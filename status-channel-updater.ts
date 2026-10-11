import { RateLimitError, type RateLimitData } from "discord.js";

export interface RenamableChannel {
  name: string;
  setName(name: string, reason?: string): Promise<unknown>;
}

function isRenamableChannel(channel: unknown): channel is RenamableChannel {
  if (typeof channel !== "object" || channel === null) return false;
  const candidate = channel as Partial<RenamableChannel>;
  return typeof candidate.name === "string" && typeof candidate.setName === "function";
}

export function isStatusChannelRateLimit(limit: RateLimitData, channelIds: string[]) {
  return limit.method.toUpperCase() === "PATCH" && limit.route === "/channels/:id" && channelIds.includes(limit.majorParameter);
}

export class StatusChannelUpdater {
  private readonly desiredNames = new Map<string, string>();
  private readonly appliedNames = new Map<string, string>();
  private readonly updating = new Set<string>();
  private readonly retryAt = new Map<string, number>();
  private readonly retryTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly channelIds: string[],
    private readonly fetchChannel: (id: string) => Promise<unknown>,
    private readonly onError: (id: string, error: unknown) => void,
    private readonly onDelay?: (id: string, retryAt: number) => void,
  ) {}

  update(desiredName: string): void {
    for (const channelId of this.channelIds) {
      this.desiredNames.set(channelId, desiredName);
      this.start(channelId);
    }
  }

  isRateLimited(channelId: string) {
    return (this.retryAt.get(channelId) ?? 0) > Date.now();
  }

  private start(channelId: string) {
    if (this.updating.has(channelId)) return;
    if (this.isRateLimited(channelId)) {
      if (!this.retryTimers.has(channelId)) {
        const timer = setTimeout(() => {
          this.retryTimers.delete(channelId);
          this.start(channelId);
        }, this.retryAt.get(channelId)! - Date.now());
        timer.unref?.();
        this.retryTimers.set(channelId, timer);
      }
      return;
    }
    this.updating.add(channelId);
    void this.flush(channelId);
  }

  private async flush(channelId: string) {
    try {
      // Recheck Discord even when the desired value is unchanged: another bot or
      // a manual rename may have changed the channel since our last successful edit.
      do {
        const channel = await this.fetchChannel(channelId);
        if (!isRenamableChannel(channel)) throw new Error("Канал не найден или его нельзя переименовать");

        // Always prepare the name from the latest snapshot, including after a rate-limit retry.
        const desiredName = this.desiredNames.get(channelId)!;
        if (channel.name !== desiredName) {
          await channel.setName(desiredName, "Обновление статуса игрового сервера");
        }
        this.appliedNames.set(channelId, desiredName);
      } while (this.appliedNames.get(channelId) !== this.desiredNames.get(channelId));
    } catch (error) {
      if (error instanceof RateLimitError) {
        const waits = [error.retryAfter, error.sublimitTimeout, error.timeToReset].filter((value) => Number.isFinite(value) && value > 0);
        const retryAt = Date.now() + (waits.length > 0 ? Math.max(...waits) : 1000);
        this.retryAt.set(channelId, retryAt);
        this.onDelay?.(channelId, retryAt);
      } else {
        this.onError(channelId, error);
      }
    } finally {
      this.updating.delete(channelId);
      if (this.isRateLimited(channelId)) this.start(channelId);
    }
  }
}
