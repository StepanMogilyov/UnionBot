import { setTimeout as delay } from "node:timers/promises";

const OFFLINE_CONFIRMATION_FAILURES = 5;

export interface ServerInfo {
  header: string;
  players: number;
  max_players: number;
  map: string;
}

export interface ServerPlayer {
  index: number;
  name: string;
  score: number;
  duration: number;
}

export interface SourceServerQuery {
  info(host: string, port: number, timeout?: number): Promise<ServerInfo>;
  players(host: string, port: number, timeout?: number): Promise<ServerPlayer[]>;
  close?(): void;
}

export interface ServerSnapshot {
  players: string[];
  onlineCount: number;
  maxPlayers: number;
  map: string;
  updatedAt: number;
}

export interface PlayerEventBatchMessage extends ServerSnapshot {
  joinedPlayers: string[];
  leftPlayers: string[];
  mapChanged?: boolean;
}

export type ServerRefreshResult =
  | { status: "online"; snapshot: ServerSnapshot; event: PlayerEventBatchMessage | null }
  | { status: "offline" | "unavailable"; error: Error };

interface ServerMonitorOptions {
  host: string;
  port: number;
  timeout: number;
  retryDelayMs?: number;
  now?: () => number;
  onRefresh?: (result: ServerRefreshResult) => void;
}

function validateInfo(info: ServerInfo) {
  if (
    info.header !== "I" ||
    !Number.isInteger(info.players) || info.players < 0 ||
    !Number.isInteger(info.max_players) || info.max_players < info.players ||
    typeof info.map !== "string"
  ) {
    throw new Error("Некорректный ответ на запрос информации о сервере");
  }
}

function addedNames(current: string[], previous: string[]) {
  const remaining = new Map<string, number>();
  for (const name of previous) {
    remaining.set(name, (remaining.get(name) ?? 0) + 1);
  }

  return current.filter((name) => {
    const count = remaining.get(name) ?? 0;
    if (count === 0) return true;
    remaining.set(name, count - 1);
    return false;
  });
}

export class ServerMonitor {
  private previousSnapshot: ServerSnapshot | null = null;
  private inFlight: Promise<ServerRefreshResult> | null = null;
  private unansweredRefreshes = 0;

  constructor(private readonly query: SourceServerQuery, private readonly options: ServerMonitorOptions) {}

  refresh(): Promise<ServerRefreshResult> {
    // source-server-query shares one socket and does not match responses to request types.
    // Polling and TAB must share the entire refresh, including state publication.
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.readSnapshot().then((result) => {
      this.options.onRefresh?.(result);
      return result;
    }).finally(() => {
      this.inFlight = null;
    });

    return this.inFlight;
  }

  private async readSnapshot(): Promise<ServerRefreshResult> {
    const { host, port, timeout } = this.options;
    let serverResponded = false;

    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        // Keep these requests adjacent, without waiting for any Discord operation.
        const before = await this.query.info(host, port, timeout);
        serverResponded = true;
        validateInfo(before);
        const players = await this.query.players(host, port, timeout);
        const after = await this.query.info(host, port, timeout);
        validateInfo(after);

        if (!Array.isArray(players) || players.some((player) => typeof player.name !== "string")) {
          throw new Error("Некорректный ответ на запрос списка игроков");
        }

        if (
          before.map === after.map &&
          before.max_players === after.max_players &&
          before.players === after.players &&
          players.length === after.players
        ) {
          const snapshot: ServerSnapshot = {
            // Keep unnamed slots: dropping them would make the displayed count disagree with TAB.
            players: players.map((player) => player.name),
            onlineCount: players.length,
            maxPlayers: after.max_players,
            map: after.map,
            updatedAt: (this.options.now ?? Date.now)(),
          };
          const previous = this.previousSnapshot;
          this.previousSnapshot = snapshot;
          this.unansweredRefreshes = 0;

          let event: PlayerEventBatchMessage | null = null;
          if (previous) {
            // An unnamed slot cannot reliably be identified as a join or leave.
            const namesComplete = [...previous.players, ...snapshot.players].every((name) => name.trim().length > 0);
            const joinedPlayers = namesComplete ? addedNames(snapshot.players, previous.players) : [];
            const leftPlayers = namesComplete ? addedNames(previous.players, snapshot.players) : [];
            if (joinedPlayers.length > 0 || leftPlayers.length > 0 || previous.map !== snapshot.map || previous.onlineCount !== snapshot.onlineCount) {
              event = { ...snapshot, joinedPlayers, leftPlayers, mapChanged: previous.map !== snapshot.map };
            }
          }

          return { status: "online", snapshot, event };
        }

        if (attempt < 2) await delay(this.options.retryDelayMs ?? 250);
      }

      throw new Error("Количество игроков или карта не совпадают в ответах сервера после трёх попыток");
    } catch (error) {
      // The library leaves its socket open on timeouts; discard it before the next refresh.
      this.query.close?.();
      // A lost response must not consume Discord's rename quota with a false offline status.
      // Any response proves reachability, even if the full player snapshot is unavailable.
      this.unansweredRefreshes = serverResponded ? 0 : this.unansweredRefreshes + 1;
      return {
        status: this.unansweredRefreshes >= OFFLINE_CONFIRMATION_FAILURES ? "offline" : "unavailable",
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }
}
