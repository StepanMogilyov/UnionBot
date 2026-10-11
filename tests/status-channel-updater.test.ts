import { strict as assert } from "node:assert";
import { setImmediate as nextTurn } from "node:timers/promises";
import { test } from "node:test";
import { RateLimitError } from "discord.js";
import { ServerMonitor } from "../server-monitor";
import { StatusChannelUpdater, isStatusChannelRateLimit } from "../status-channel-updater";

function rateLimit(retryAfter: number, sublimitTimeout = retryAfter) {
  return new RateLimitError({
    global: false, method: "PATCH", route: "/channels/:id", majorParameter: "channel",
    url: "https://discord.com/api/v10/channels/channel", hash: "rename", limit: 2,
    timeToReset: 100, retryAfter, sublimitTimeout, scope: "user",
  });
}

test("slow Discord renames coalesce intermediate counts without concurrent edits", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const names: string[] = [];
  let active = 0;
  let maxActive = 0;
  const channel = {
    name: "old",
    async setName(name: string) {
      names.push(name);
      maxActive = Math.max(maxActive, ++active);
      if (names.length === 1) await gate;
      this.name = name;
      active--;
    },
  };
  const updater = new StatusChannelUpdater(["channel"], async () => channel, (_id, error) => { throw error; });
  updater.update("1/26");
  await nextTurn();
  updater.update("2/26");
  updater.update("6/26");
  assert.deepEqual(names, ["1/26"]);
  release();
  await nextTurn();

  assert.deepEqual(names, ["1/26", "6/26"]);
  assert.equal(channel.name, "6/26");
  assert.equal(maxActive, 1);
  updater.update("6/26");
  await nextTurn();
  assert.equal(names.length, 2);
});

test("a rename waiting in one channel does not delay updates to another", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const slow = { name: "old", async setName(name: string) { await gate; this.name = name; } };
  const fast = { name: "old", async setName(name: string) { this.name = name; } };
  const updater = new StatusChannelUpdater(["slow", "fast"], async (id) => id === "slow" ? slow : fast, (_id, error) => { throw error; });

  updater.update("6/26");
  await nextTurn();
  assert.equal(fast.name, "6/26");
  assert.equal(slow.name, "old");
  release();
  await nextTurn();
});

test("failed renames are retried on the next refresh", async () => {
  let attempts = 0;
  const errors: unknown[] = [];
  const channel = {
    name: "old",
    async setName(name: string) {
      attempts++;
      if (attempts === 1) throw new Error("Discord unavailable");
      this.name = name;
    },
  };
  const updater = new StatusChannelUpdater(["channel"], async () => channel, (_id, error) => { errors.push(error); });
  updater.update("6/26");
  await nextTurn();
  assert.equal(errors.length, 1);
  updater.update("6/26");
  await nextTurn();
  assert.equal(attempts, 2);
  assert.equal(channel.name, "6/26");
});

test("a blocked Discord rename cannot delay either the next poll or a fresh TAB result", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const channel = { name: "old", async setName(name: string) { await gate; this.name = name; } };
  const updater = new StatusChannelUpdater(["channel"], async () => channel, (_id, error) => { throw error; });
  let count = 1;
  const server = new ServerMonitor({
    async info() { return { header: "I", players: count, max_players: 26, map: "FFA_Duelyard" }; },
    async players() { return Array.from({ length: count }, (_, index) => ({ index, name: `player ${index}`, score: 0, duration: 1 })); },
  }, {
    host: "127.0.0.1", port: 27015, timeout: 1000,
    onRefresh(result) {
      if (result.status === "online") updater.update(`${result.snapshot.onlineCount}/26`);
    },
  });

  try {
    await server.refresh();
    count = 6;
    const result = await server.refresh();
    assert.equal(result.status, "online");
    if (result.status === "online") assert.equal(result.snapshot.onlineCount, 6);
    assert.equal(channel.name, "old");
  } finally {
    release();
    await nextTurn();
  }
  assert.equal(channel.name, "6/26");
});

test("a Discord rate limit retries only the latest online count at the server-provided deadline", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const names: string[] = [];
  const delays: number[] = [];
  const channel = {
    name: "old",
    async setName(name: string) {
      names.push(name);
      if (names.length === 1) throw rateLimit(1000, 60_000);
      this.name = name;
    },
  };
  const updater = new StatusChannelUpdater(["channel"], async () => channel, (_id, error) => { throw error; }, (_id, retryAt) => delays.push(retryAt));

  updater.update("1/26");
  await nextTurn();
  assert.equal(updater.isRateLimited("channel"), true);
  assert.deepEqual(delays, [61_000]);
  updater.update("2/26");
  updater.update("0/26");
  context.mock.timers.tick(59_999);
  await nextTurn();
  assert.deepEqual(names, ["1/26"]);
  context.mock.timers.tick(1);
  await nextTurn();

  assert.deepEqual(names, ["1/26", "0/26"]);
  assert.equal(channel.name, "0/26");
  assert.equal(updater.isRateLimited("channel"), false);
});

test("a second rate limit reschedules the latest count without waiting for another game-server poll", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const names: string[] = [];
  const channel = {
    name: "old",
    async setName(name: string) {
      names.push(name);
      if (names.length <= 2) throw rateLimit(1000);
      this.name = name;
    },
  };
  const updater = new StatusChannelUpdater(["channel"], async () => channel, (_id, error) => { throw error; });
  updater.update("1/26");
  await nextTurn();
  updater.update("0/26");
  context.mock.timers.tick(1000);
  await nextTurn();
  updater.update("3/26");
  context.mock.timers.tick(1000);
  await nextTurn();

  assert.deepEqual(names, ["1/26", "0/26", "3/26"]);
  assert.equal(channel.name, "3/26");
});

test("an external channel rename is corrected even when the online count has not changed", async () => {
  const names: string[] = [];
  const channel = { name: "1/26", async setName(name: string) { names.push(name); this.name = name; } };
  const updater = new StatusChannelUpdater(["channel"], async () => channel, (_id, error) => { throw error; });
  updater.update("0/26");
  await nextTurn();
  channel.name = "1/26";
  updater.update("0/26");
  await nextTurn();

  assert.deepEqual(names, ["0/26", "0/26"]);
  assert.equal(channel.name, "0/26");
});

test("custom rate-limit handling applies only to edits of configured status channels", () => {
  const limit = rateLimit(1000);
  assert.equal(isStatusChannelRateLimit(limit, ["channel"]), true);
  assert.equal(isStatusChannelRateLimit(limit, ["other"]), false);
  assert.equal(isStatusChannelRateLimit({ ...limit, method: "GET" }, ["channel"]), false);
  assert.equal(isStatusChannelRateLimit({ ...limit, method: "POST", route: "/channels/:id/messages" }, ["channel"]), false);
});
