import { readFile, rename, rm, writeFile } from "node:fs/promises";

interface EventStatus {
  closed: boolean;
}

export class EventStatusStore {
  private state: EventStatus = { closed: false };
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  get closed() { return this.state.closed; }

  async load() {
    let source: string;
    try {
      source = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const state = JSON.parse(source) as Partial<EventStatus> | null;
    if (!state || typeof state.closed !== "boolean") {
      throw new Error("Некорректный файл состояния ивента");
    }
    // Older versions also stored notice IDs; only the event status is needed now.
    this.state = { closed: state.closed };
  }

  setClosed(closed: boolean) {
    const result = this.writing.then(async () => {
      if (closed === this.state.closed) return;
      const next = { closed };
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
