import { readFile, rename, rm, writeFile } from "node:fs/promises";

export const EVENT_AUTO_OPEN_DELAY_MS = 4 * 60 * 60 * 1000;

interface EventStatus {
  closed: boolean;
  autoOpenAt?: number;
}

export class EventStatusStore {
  private state: EventStatus = { closed: false };
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  get closed() { return this.state.closed; }
  get autoOpenAt() { return this.state.autoOpenAt; }

  async load() {
    let source: string;
    try {
      source = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const state = JSON.parse(source) as Partial<EventStatus> | null;
    if (!state || typeof state.closed !== "boolean" ||
      (state.autoOpenAt !== undefined && (!Number.isSafeInteger(state.autoOpenAt) || state.autoOpenAt < 0))) {
      throw new Error("Некорректный файл состояния ивента");
    }
    // Older versions have no deadline and may also contain unused notice IDs.
    this.state = state.closed && state.autoOpenAt !== undefined
      ? { closed: true, autoOpenAt: state.autoOpenAt }
      : { closed: state.closed };
  }

  setClosed(closed: boolean) {
    const result = this.writing.then(async () => {
      const next: EventStatus = closed ? { closed: true, autoOpenAt: Date.now() + EVENT_AUTO_OPEN_DELAY_MS } : { closed: false };
      if (next.closed === this.state.closed && next.autoOpenAt === this.state.autoOpenAt) return;
      const temporaryPath = `${this.filePath}.tmp`;
      try {
        await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
        await rename(temporaryPath, this.filePath);
        this.state = next;
      } finally {
        await rm(temporaryPath, { force: true }).catch(() => {});
      }
    });
    this.writing = result.catch(() => {});
    return result;
  }
}
