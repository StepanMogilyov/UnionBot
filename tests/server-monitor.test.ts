import { strict as assert } from "node:assert";
import { test } from "node:test";
import { formatOnlinePlayersMessage } from "../src/discord-messages";
import { ServerMonitor, type ServerInfo, type ServerPlayer, type ServerRefreshResult, type SourceServerQuery } from "../src/server-monitor";

function info(players: number, map = "FFA_Duelyard"): ServerInfo {
  return { header: "I", players, max_players: 26, map };
}

function players(names: string[]): ServerPlayer[] {
  return names.map((name, index) => ({ index, name, score: 0, duration: 10 }));
}

class FakeQuery implements SourceServerQuery {
  infoReplies: (ServerInfo | Error)[] = [];
  playerReplies: (ServerPlayer[] | Error)[] = [];
  closed = 0;

  sample(count: number, names: string[], map = "FFA_Duelyard") {
    this.infoReplies.push(info(count, map), info(count, map));
    this.playerReplies.push(players(names));
  }

  async info() {
    const reply = this.infoReplies.shift();
    assert.ok(reply, "unexpected INFO request");
    if (reply instanceof Error) throw reply;
    return reply;
  }

  async players() {
    const reply = this.playerReplies.shift();
    assert.ok(reply, "unexpected PLAYER request");
    if (reply instanceof Error) throw reply;
    return reply;
  }

  close() { this.closed++; }
}

function monitor(query: SourceServerQuery, onRefresh?: (result: ServerRefreshResult) => void) {
  return new ServerMonitor(query, { host: "127.0.0.1", port: 27015, timeout: 1000, retryDelayMs: 0, now: () => 123456000, onRefresh });
}

function online(result: ServerRefreshResult) {
  assert.equal(result.status, "online");
  assert.equal(result.snapshot.onlineCount, result.snapshot.players.length);
  return result;
}

test("empty PLAYER with INFO 5 never reports that all six players left and preserves the last valid baseline", async () => {
  const query = new FakeQuery();
  const names = ["Doctor Neon", "STRESS", "Jaime L.", "steriks", "Beerson", "KARFE"];
  query.sample(6, names);
  for (let i = 0; i < 3; i++) query.sample(5, []);
  query.sample(5, names.slice(0, 5));
  const outcomes: ServerRefreshResult[] = [];
  const server = monitor(query, (result) => outcomes.push(result));

  assert.equal(online(await server.refresh()).event, null);
  assert.equal((await server.refresh()).status, "unavailable");
  assert.equal(query.closed, 1);
  const recovered = online(await server.refresh());
  assert.deepEqual(recovered.event?.leftPlayers, ["KARFE"]);
  assert.deepEqual(recovered.event?.joinedPlayers, []);
  assert.equal(recovered.event?.onlineCount, 5);
  assert.equal(outcomes.filter((result) => result.status === "online" && result.event).length, 1);
});

test("INFO 4 / PLAYER 6 is retried and all displays receive the validated six-player snapshot", async () => {
  const query = new FakeQuery();
  query.sample(4, ["a", "b", "c", "d"]);
  query.sample(4, ["a", "b", "c", "d", "e", "f"]);
  query.sample(6, ["a", "b", "c", "d", "e", "f"]);
  const server = monitor(query);
  await server.refresh();
  const result = online(await server.refresh());

  assert.equal(result.snapshot.onlineCount, 6);
  assert.equal(result.snapshot.updatedAt, 123456000);
  assert.equal(result.event?.onlineCount, 6);
  assert.deepEqual(result.event?.joinedPlayers, ["e", "f"]);
  assert.match(formatOnlinePlayersMessage(result.snapshot), /Игроки онлайн — 6\/26/);
  assert.equal(query.infoReplies.length, 0);
});

test("count or map changes across PLAYER are retried before publishing events", async () => {
  const query = new FakeQuery();
  query.sample(1, ["a"], "old_map");
  query.infoReplies.push(info(1, "old_map"), info(2, "new_map"));
  query.playerReplies.push(players(["a", "temporary"]));
  query.sample(2, ["a", "b"], "new_map");
  const server = monitor(query);
  await server.refresh();
  const result = online(await server.refresh());

  assert.equal(result.snapshot.map, "new_map");
  assert.deepEqual(result.snapshot.players, ["a", "b"]);
  assert.deepEqual(result.event?.joinedPlayers, ["b"]);
});

test("a confirmed zero-player snapshot reports real departures and an empty TAB", async () => {
  const query = new FakeQuery();
  query.sample(2, ["a", "b"]);
  query.sample(0, []);
  const server = monitor(query);
  await server.refresh();
  const result = online(await server.refresh());

  assert.deepEqual(result.event?.leftPlayers, ["a", "b"]);
  assert.equal(result.event?.onlineCount, 0);
  assert.match(formatOnlinePlayersMessage(result.snapshot), /0\/26/);
});

test("unnamed players keep their slots and do not create false name-based departures", async () => {
  const query = new FakeQuery();
  query.sample(2, ["a", "b"]);
  query.sample(2, ["", "  "]);
  query.sample(2, ["a", "b"]);
  const server = monitor(query);
  await server.refresh();
  const result = online(await server.refresh());

  assert.equal(result.snapshot.onlineCount, 2);
  assert.equal(result.event, null);
  const message = formatOnlinePlayersMessage(result.snapshot);
  assert.equal(message.split("Игрок без имени").length - 1, 2);
  assert.equal(online(await server.refresh()).event, null);
});

test("players with identical names are counted individually in join and leave events", async () => {
  const query = new FakeQuery();
  query.sample(1, ["same"]);
  query.sample(2, ["same", "same"]);
  query.sample(1, ["same"]);
  const server = monitor(query);
  await server.refresh();

  assert.deepEqual(online(await server.refresh()).event?.joinedPlayers, ["same"]);
  assert.deepEqual(online(await server.refresh()).event?.leftPlayers, ["same"]);
});

test("concurrent poll and TAB requests share one refresh and publish it exactly once", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let infoCalls = 0;
  let playerCalls = 0;
  let published = 0;
  const server = monitor({
    async info() { infoCalls++; await gate; return info(1); },
    async players() { playerCalls++; return players(["a"]); },
  }, () => { published++; });

  const poll = server.refresh();
  const tab = server.refresh();
  assert.equal(poll, tab);
  assert.equal(infoCalls, 1);
  release();
  const [pollResult, tabResult] = await Promise.all([poll, tab]);
  assert.equal(pollResult, tabResult);
  assert.equal(infoCalls, 2);
  assert.equal(playerCalls, 1);
  assert.equal(published, 1);

  await server.refresh();
  assert.equal(infoCalls, 4);
  assert.equal(published, 2);
});

test("PLAYER and isolated INFO timeouts are unavailable and neither resets player history", async () => {
  const query = new FakeQuery();
  query.sample(1, ["a"]);
  query.infoReplies.push(info(1));
  query.playerReplies.push(new Error("PLAYER timed out"));
  query.infoReplies.push(new Error("INFO timed out"));
  query.sample(1, ["a"]);
  const server = monitor(query);
  await server.refresh();

  assert.equal((await server.refresh()).status, "unavailable");
  assert.equal((await server.refresh()).status, "unavailable");
  assert.equal(query.closed, 2);
  assert.equal(online(await server.refresh()).event, null);
});

test("offline requires three consecutive unanswered refreshes, including at startup, and recovery resets the count", async () => {
  const query = new FakeQuery();
  for (let i = 0; i < 4; i++) query.infoReplies.push(new Error("INFO timed out"));
  query.sample(1, ["a"]);
  for (let i = 0; i < 3; i++) query.infoReplies.push(new Error("INFO timed out"));
  query.sample(1, ["b"]);
  query.infoReplies.push(new Error("INFO timed out"));
  const server = monitor(query);

  for (const expected of ["unavailable", "unavailable", "offline", "offline"]) {
    assert.equal((await server.refresh()).status, expected);
  }
  assert.equal(online(await server.refresh()).event, null);
  for (const expected of ["unavailable", "unavailable", "offline"]) {
    assert.equal((await server.refresh()).status, expected);
  }
  const recovered = online(await server.refresh());
  assert.deepEqual(recovered.event?.joinedPlayers, ["b"]);
  assert.deepEqual(recovered.event?.leftPlayers, ["a"]);
  assert.equal((await server.refresh()).status, "unavailable");
  assert.equal(query.closed, 8);
});

test("an INFO response resets offline confirmation even when PLAYER subsequently times out", async () => {
  const query = new FakeQuery();
  for (let i = 0; i < 2; i++) query.infoReplies.push(new Error("INFO timed out"));
  query.infoReplies.push(info(1));
  query.playerReplies.push(new Error("PLAYER timed out"));
  for (let i = 0; i < 3; i++) query.infoReplies.push(new Error("INFO timed out"));
  const server = monitor(query);

  for (const expected of ["unavailable", "unavailable", "unavailable", "unavailable", "unavailable", "offline"]) {
    assert.equal((await server.refresh()).status, expected);
  }
});

test("concurrent poll and TAB failures count as a single unanswered refresh", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let infoCalls = 0;
  const outcomes: ServerRefreshResult[] = [];
  const server = monitor({
    async info() { infoCalls++; await gate; throw new Error("INFO timed out"); },
    async players() { assert.fail("unexpected PLAYER request"); },
  }, (result) => outcomes.push(result));

  const poll = server.refresh();
  const tab = server.refresh();
  assert.equal(poll, tab);
  release();
  const [pollResult, tabResult] = await Promise.all([poll, tab]);
  assert.equal(pollResult, tabResult);
  assert.equal(pollResult.status, "unavailable");
  assert.equal(infoCalls, 1);
  assert.equal(outcomes.length, 1);
  assert.equal((await server.refresh()).status, "unavailable");
  assert.equal((await server.refresh()).status, "offline");
});

test("an unexpected packet header is rejected without querying players", async () => {
  const query = new FakeQuery();
  query.infoReplies.push({ ...info(0), header: "D" });
  assert.equal((await monitor(query).refresh()).status, "unavailable");
  assert.equal(query.closed, 1);
});
