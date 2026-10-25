import { readFile, rename, rm, writeFile } from "node:fs/promises";
import type { AutomaticPresetOptions, AutomaticPresetResult } from "./server-restart-command";
import type { MapPreset } from "./server-maps";
import type { ServerRefreshResult } from "./server-monitor";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const LTS_DURATION_MS = 65 * MINUTE_MS;
const moscowTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

function wednesdayWindow(now: number) {
  const parts = Object.fromEntries(moscowTime.formatToParts(now).map(({ type, value }) => [type, value]));
  const day = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
  const localTime = day + (Number(parts.hour) * 60 + Number(parts.minute)) * MINUTE_MS + Number(parts.second) * 1000;
  const offset = localTime - Math.floor(now / 1000) * 1000;
  const daysUntilWednesday = (3 - new Date(day).getUTCDay() + 7) % 7;
  const startsAt = day + daysUntilWednesday * DAY_MS + (19 * 60 + 55) * MINUTE_MS - offset;
  return { startsAt, endsAt: startsAt + LTS_DURATION_MS };
}

export function nextLtsBoundary(now: number) {
  const { startsAt, endsAt } = wednesdayWindow(now);
  if (now < startsAt) return startsAt;
  if (now < endsAt) return endsAt;
  return startsAt + 7 * DAY_MS;
}

interface ScheduleState {
  startsAt: number;
  phase: "pending-lts" | "lts-saved" | "waiting-for-empty" | "duelyard-saved" | "complete";
}

interface LtsScheduleOptions {
  filePath: string;
  setPreset: (preset: MapPreset, options: AutomaticPresetOptions) => Promise<AutomaticPresetResult>;
  refresh: () => Promise<ServerRefreshResult>;
  now?: () => number;
  onError: (error: unknown) => void;
  onApplied?: (preset: MapPreset, result: "applied" | "unchanged") => void;
}

export class LtsSchedule {
  private state: ScheduleState | null = null;
  private inFlight: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: LtsScheduleOptions) {}

  async load() {
    let source: string;
    try {
      source = await readFile(this.options.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const state = JSON.parse(source) as Partial<ScheduleState> | null;
    if (!state || !Number.isSafeInteger(state.startsAt) || state.startsAt! < 0 ||
      wednesdayWindow(state.startsAt!).startsAt !== state.startsAt ||
      !["pending-lts", "lts-saved", "waiting-for-empty", "duelyard-saved", "complete"].includes(state.phase ?? "")) {
      throw new Error("Некорректный файл состояния расписания LTS");
    }
    this.state = state as ScheduleState;
  }

  start() {
    this.stop();
    this.scheduleBoundary();
    void this.check().catch(this.options.onError);
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  check(result?: ServerRefreshResult): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.run(result).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private now() { return (this.options.now ?? Date.now)(); }

  private scheduleBoundary() {
    const now = this.now();
    const boundary = nextLtsBoundary(now);
    this.timer = setTimeout(() => {
      this.scheduleBoundary();
      void this.checkBoundary(boundary).catch(this.options.onError);
    }, boundary - now);
    this.timer.unref();
  }

  private async checkBoundary(boundary: number) {
    // Request players at 21:00 even if an earlier Nitrado operation is still pending.
    const result = boundary === wednesdayWindow(boundary).endsAt ? await this.options.refresh() : undefined;
    // Do not lose a boundary check by sharing a run that began before the deadline.
    if (this.inFlight) await this.inFlight.catch(() => {});
    await this.check(result);
  }

  private async save(state: ScheduleState) {
    const temporaryPath = `${this.options.filePath}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
      await rename(temporaryPath, this.options.filePath);
      this.state = state;
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => {});
    }
  }

  private async run(result?: ServerRefreshResult) {
    const now = this.now();
    const window = wednesdayWindow(now);
    if (now >= window.startsAt && now < window.endsAt) {
      if (this.state?.startsAt !== window.startsAt) {
        await this.save({ startsAt: window.startsAt, phase: "pending-lts" });
      }
      if (this.state!.phase !== "pending-lts" && this.state!.phase !== "lts-saved") return;
      const next: ScheduleState = { startsAt: window.startsAt, phase: "waiting-for-empty" };
      const applied = await this.options.setPreset("lts", {
        shouldApply: () => this.now() >= window.startsAt && this.now() < window.endsAt,
        beforeMutation: () => this.save(next),
        restartIfUnchanged: this.state!.phase === "lts-saved",
        afterSave: () => this.save({ startsAt: window.startsAt, phase: "lts-saved" }),
        beforeRestart: () => this.save(next),
      });
      if (applied !== "deferred") {
        if (applied === "unchanged") await this.save(next);
        this.options.onApplied?.("lts", applied);
      }
      return;
    }

    const state = this.state;
    if (!state || (state.phase !== "waiting-for-empty" && state.phase !== "lts-saved" && state.phase !== "duelyard-saved") ||
      now < state.startsAt + LTS_DURATION_MS) return;
    // A boundary timer and startup request fresh data; minute polls reuse their validated snapshot.
    const snapshot = result ?? await this.options.refresh();
    if (snapshot.status !== "online" || snapshot.snapshot.onlineCount !== 0 ||
      snapshot.snapshot.updatedAt < state.startsAt + LTS_DURATION_MS) return;
    const next: ScheduleState = { startsAt: state.startsAt, phase: "complete" };
    const applied = await this.options.setPreset("duelyard", {
      shouldApply: () => {
        const time = this.now();
        const currentWindow = wednesdayWindow(time);
        return time >= state.startsAt + LTS_DURATION_MS &&
          !(time >= currentWindow.startsAt && time < currentWindow.endsAt);
      },
      beforeMutation: () => this.save(next),
      restartIfUnchanged: state.phase === "duelyard-saved",
      afterSave: () => this.save({ startsAt: state.startsAt, phase: "duelyard-saved" }),
      beforeRestart: () => this.save(next),
    });
    if (applied !== "deferred") {
      if (this.state!.phase !== "complete") await this.save(next);
      this.options.onApplied?.("duelyard", applied);
    }
  }
}
