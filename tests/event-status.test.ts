import { strict as assert } from "node:assert";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { EVENT_AUTO_OPEN_DELAY_MS, EventStatusStore } from "../src/event-status";
import { createTestDirectory } from "./test-directory";

test("event status survives restarts and simultaneous writes preserve command order", async (context) => {
  const directory = await createTestDirectory(context);
  const path = join(directory, "event-status.json");
  const store = new EventStatusStore(path);
  await store.load();
  assert.equal(store.closed, false);
  await Promise.all([store.setClosed(true), store.setClosed(false), store.setClosed(true)]);

  const restored = new EventStatusStore(path);
  await restored.load();
  assert.equal(restored.closed, true);
  assert.equal(restored.autoOpenAt, store.autoOpenAt);
  await restored.setClosed(false);
  const reopened = new EventStatusStore(path);
  await reopened.load();
  assert.equal(reopened.closed, false);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { closed: false });
});

test("state saved by the version that edited notices still restores the event status", async (context) => {
  const directory = await createTestDirectory(context);
  const path = join(directory, "event-status.json");
  await writeFile(path, JSON.stringify({ closed: true, messageIds: { one: "notice-1" } }));
  const store = new EventStatusStore(path);
  await store.load();
  assert.equal(store.closed, true);
  await store.setClosed(false);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { closed: false });
});

test("invalid persisted state is rejected instead of silently reopening the server", async (context) => {
  const directory = await createTestDirectory(context);
  const path = join(directory, "event-status.json");
  for (const source of ["broken JSON", '{"closed":"false"}', '{}', 'null',
    '{"closed":true,"autoOpenAt":"tomorrow"}', '{"closed":true,"autoOpenAt":-1}']) {
    await writeFile(path, source);
    await assert.rejects(new EventStatusStore(path).load());
    assert.equal(await readFile(path, "utf8"), source);
  }
});

test("a failed save does not change the active event status", async (context) => {
  const directory = await createTestDirectory(context);
  const store = new EventStatusStore(join(directory, "missing", "event-status.json"));
  await assert.rejects(store.setClosed(true));
  assert.equal(store.closed, false);
  assert.equal(store.autoOpenAt, undefined);
});

test("each start saves a new four-hour deadline and stop removes it", async (context) => {
  const directory = await createTestDirectory(context);
  const path = join(directory, "event-status.json");
  const store = new EventStatusStore(path);
  context.mock.timers.enable({ apis: ["Date"], now: 1000 });
  await store.setClosed(true);
  assert.equal(store.autoOpenAt, 1000 + EVENT_AUTO_OPEN_DELAY_MS);
  context.mock.timers.tick(5000);
  await store.setClosed(true);
  assert.equal(store.autoOpenAt, 6000 + EVENT_AUTO_OPEN_DELAY_MS);
  const restored = new EventStatusStore(path);
  await restored.load();
  assert.equal(restored.autoOpenAt, store.autoOpenAt);
  await restored.setClosed(false);
  assert.equal(restored.autoOpenAt, undefined);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { closed: false });
});
