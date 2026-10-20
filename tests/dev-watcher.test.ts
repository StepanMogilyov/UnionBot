import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { test } from "node:test";

const match = require("nodemon/lib/monitor/match") as {
  (files: string[], rules: string[], extensions: string): { result: string[] };
  rulesToMonitor(watch: string[], ignore: string[], config: { dirs: string[] }): string[];
};

test("runtime event state changes cannot restart dev, while source edits still can", async () => {
  const root = resolve(__dirname, "..");
  const config = JSON.parse(await readFile(join(root, "nodemon.json"), "utf8")) as { ignore: string[] };
  const files = [
    "event-status.json", "event-status.json.tmp", "tests/.unionbot-test-example/event-status.json",
    "index.ts", "src/event-command.ts", "package.json",
  ].map((file) => join(root, file));
  const rules = match.rulesToMonitor([root], config.ignore, { dirs: [] });
  assert.deepEqual(
    match(files, rules, "ts,json").result.map((file) => relative(root, file)),
    files.slice(3).map((file) => relative(root, file)),
  );
});
