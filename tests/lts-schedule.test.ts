import { strict as assert } from "node:assert";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { LtsSchedule, nextLtsBoundary } from "../src/lts-schedule";
import { ServerRestartCommand } from "../src/server-restart-command";
import { getPresetMaps } from "../src/server-maps";
import type { ServerRefreshResult } from "../src/server-monitor";
import { createTestDirectory } from "./test-directory";

const START = Date.parse("2026-10-28T19:55:00+03:00");
const END = Date.parse("2026-10-28T21:00:00+03:00");
const MINUTE = 60_000;

async function setup(context: TestContext, options: {
  rotation?: string[]; saveError?: Error; restartError?: Error; onSave?: (maps: readonly string[]) => void;
} = {}) {
  const directory = await createTestDirectory(context);
  const filePath = join(directory, "lts-schedule.json");
  const state = {
    now: START, count: 0, status: "started", queryStatus: "online", configured: true,
    rotation: options.rotation ?? ["FFA_Duelyard"], rotations: [] as string[][], restarts: [] as string[],
    refreshes: 0, rotationReads: 0, readError: false,
  };
  const snapshot = (): ServerRefreshResult => state.queryStatus === "online"
    ? { status: "online", event: null, snapshot: {
      onlineCount: state.count, players: Array(state.count).fill("player"),
      maxPlayers: 26, map: "LTS_Wardenglade", updatedAt: state.now,
    } }
    : { status: state.queryStatus as "offline" | "unavailable", error: new Error("query failed") };
  const refresh = async () => { state.refreshes++; return snapshot(); };
  const command = new ServerRestartCommand({
    commandName: "union", roleIds: [], refresh,
    nitrado: {
      get configured() { return state.configured; },
      async getStatus() { return state.status; },
      async getMapRotation() {
        state.rotationReads++;
        if (state.readError) throw new Error("read failed");
        return [...state.rotation];
      },
      async setMapRotation(maps) {
        const saved = JSON.parse(await readFile(filePath, "utf8"));
        assert.equal(saved.phase, maps[0] === "FFA_Duelyard" ? "complete" : "waiting-for-empty");
        state.rotations.push([...maps]);
        if (options.saveError) throw options.saveError;
        state.rotation = [...maps];
        options.onSave?.(maps);
      },
      async restart(message) {
        state.restarts.push(message);
        if (options.restartError) throw options.restartError;
      },
    },
  });
  const makeSchedule = () => new LtsSchedule({
    filePath, now: () => state.now, refresh,
    setPreset: (preset, options) => command.setPresetAutomatically(preset, options),
    onError: (error) => { throw error; },
  });
  const schedule = makeSchedule();
  await schedule.load();
  return { state, schedule, makeSchedule, filePath, snapshot };
}

test("weekly boundaries use Moscow Wednesday 19:55 and 21:00 across London's winter and summer time", () => {
  for (const date of ["2026-01-07", "2026-07-08", "2026-10-21", "2026-10-28"]) {
    const start = Date.parse(`${date}T19:55:00+03:00`);
    const end = Date.parse(`${date}T21:00:00+03:00`);
    assert.equal(nextLtsBoundary(start - 1), start);
    assert.equal(nextLtsBoundary(start), end);
    assert.equal(nextLtsBoundary(end - 1), end);
    assert.equal(nextLtsBoundary(end), start + 7 * 24 * 60 * MINUTE);
    assert.equal(new Date(start).getUTCHours(), 16);
  }
  assert.equal(nextLtsBoundary(Date.parse("2026-10-27T19:55:00+03:00")), START);
  assert.equal(nextLtsBoundary(Date.parse("2026-10-29T19:55:00+03:00")), START + 7 * 24 * 60 * MINUTE);
});

test("the timer fires at 19:55 independently of minute polls and checks again at 21:00", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const { state, schedule } = await setup(context);
  state.now = START - 37_000;
  const check = context.mock.method(schedule, "check", async () => {});
  context.after(() => schedule.stop());
  schedule.start();
  assert.equal(check.mock.callCount(), 1);
  context.mock.timers.tick(36_999);
  assert.equal(check.mock.callCount(), 1);
  state.now = START;
  context.mock.timers.tick(1);
  assert.equal(check.mock.callCount(), 2);
  state.now = END;
  context.mock.timers.tick(65 * MINUTE);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(check.mock.callCount(), 3);
  assert.equal(state.refreshes, 1, "the 21:00 boundary must request fresh player data");
});

test("LTS is installed once at Wednesday 19:55 regardless of players or query availability", async (context) => {
  for (const queryStatus of ["online", "unavailable", "offline"]) {
    const { state, schedule } = await setup(context);
    state.count = 12;
    state.queryStatus = queryStatus;
    state.now = START - 1;
    await schedule.check();
    assert.deepEqual(state.rotations, []);
    state.now = START;
    await schedule.check();
    await schedule.check();
    assert.deepEqual(state.rotations, [getPresetMaps("lts")]);
    assert.equal(state.restarts.length, 1);
    assert.match(state.restarts[0], /\/union set lts; automatic Wednesday schedule Europe\/Moscow/);
    assert.equal(state.refreshes, 0, "starting LTS must not depend on a player query");
  }
});

test("no other weekday starts LTS at 19:55", async (context) => {
  const { state, schedule } = await setup(context);
  for (const date of ["2026-10-25", "2026-10-26", "2026-10-27", "2026-10-29", "2026-10-30", "2026-10-31"]) {
    state.now = Date.parse(`${date}T19:55:00+03:00`);
    await schedule.check();
  }
  assert.deepEqual(state.rotations, []);
});

test("the full installed LTS rotation skips mutations but still arms the return", async (context) => {
  const { state, schedule } = await setup(context, { rotation: getPresetMaps("lts") });
  await schedule.check();
  assert.deepEqual(state.rotations, []);
  assert.deepEqual(state.restarts, []);
  assert.equal(state.rotationReads, 1);
  state.now = END;
  await schedule.check();
  assert.deepEqual(state.rotations, [["FFA_Duelyard"]]);
  assert.equal(state.restarts.length, 1);
});

test("partial, extra and reordered LTS rotations are replaced by the complete preset", async (context) => {
  for (const rotation of [getPresetMaps("lts").slice(1), [...getPresetMaps("lts"), "FFA_Duelyard"], getPresetMaps("lts").reverse()]) {
    const { state, schedule } = await setup(context, { rotation });
    await schedule.check();
    assert.deepEqual(state.rotations, [getPresetMaps("lts")]);
  }
});

test("an empty server stays on LTS through 20:59:59 and returns once from 21:00", async (context) => {
  const { state, schedule, snapshot } = await setup(context);
  await schedule.check();
  for (const now of [START + MINUTE, END - MINUTE, END - 1]) {
    state.now = now;
    await schedule.check(snapshot());
    assert.deepEqual(state.rotations, [getPresetMaps("lts")]);
  }
  state.now = END;
  await schedule.check();
  assert.deepEqual(state.rotations, [getPresetMaps("lts"), ["FFA_Duelyard"]]);
  assert.equal(state.refreshes, 3, "21:00, saving and restarting each validate emptiness");
  state.now += MINUTE;
  await schedule.check(snapshot());
  assert.equal(state.restarts.length, 2);
});

test("after 21:00 it waits for all players to leave, including after midnight", async (context) => {
  const { state, schedule, snapshot } = await setup(context);
  await schedule.check();
  state.now = END;
  state.count = 5;
  await schedule.check();
  state.now += MINUTE;
  state.count = 1;
  await schedule.check(snapshot());
  assert.equal(state.restarts.length, 1);
  state.now = Date.parse("2026-10-29T00:05:00+03:00");
  state.count = 0;
  await schedule.check(snapshot());
  assert.deepEqual(state.rotations.at(-1), ["FFA_Duelyard"]);
  assert.equal(state.restarts.length, 2);
});

test("offline, unavailable and pre-21:00 snapshots never trigger the return", async (context) => {
  const { state, schedule, snapshot } = await setup(context);
  await schedule.check();
  state.now = END - 1;
  const stale = snapshot();
  state.now = END;
  await schedule.check(stale);
  for (const status of ["offline", "unavailable"]) {
    state.queryStatus = status;
    await schedule.check(snapshot());
  }
  assert.equal(state.restarts.length, 1);
  state.queryStatus = "online";
  await schedule.check(snapshot());
  assert.equal(state.restarts.length, 2);
});

test("a player joining after the minute snapshot defers the return", async (context) => {
  const { state, schedule, snapshot } = await setup(context);
  await schedule.check();
  state.now = END;
  const empty = snapshot();
  state.count = 1;
  await schedule.check(empty);
  assert.equal(state.restarts.length, 1);
  state.count = 0;
  state.now += MINUTE;
  await schedule.check(snapshot());
  assert.equal(state.restarts.length, 2);
});

test("a player joining during the save postpones the restart, also across bot restarts", async (context) => {
  const fixture = await setup(context, { onSave: (maps) => {
    if (maps[0] === "FFA_Duelyard") fixture.state.count = 1;
  } });
  const { state, schedule, makeSchedule, snapshot } = fixture;
  await schedule.check();
  state.now = END;
  await schedule.check();
  assert.deepEqual(state.rotation, ["FFA_Duelyard"]);
  assert.equal(state.restarts.length, 1, "the saved rotation must not kick the new player");
  const restored = makeSchedule();
  await restored.load();
  await restored.check(snapshot());
  assert.equal(state.restarts.length, 1);
  state.count = 0;
  state.now += MINUTE;
  await restored.check(snapshot());
  assert.equal(state.restarts.length, 2);
  assert.equal(state.rotations.length, 2, "resume only the restart, without saving the rotation again");
});

test("a return already applied manually is completed without another save or restart", async (context) => {
  const { state, schedule } = await setup(context);
  await schedule.check();
  state.rotation = ["FFA_Duelyard"];
  state.now = END;
  await schedule.check();
  await schedule.check();
  assert.equal(state.rotations.length, 1);
  assert.equal(state.restarts.length, 1);
});

test("bot restarts restore the active window and the deferred return", async (context) => {
  const { state, schedule, makeSchedule, snapshot } = await setup(context);
  await schedule.check();
  state.now = START + MINUTE;
  const duringLts = makeSchedule();
  await duringLts.load();
  await duringLts.check(snapshot());
  assert.equal(state.restarts.length, 1);
  state.now = END + MINUTE;
  state.count = 3;
  const afterEnd = makeSchedule();
  await afterEnd.load();
  await afterEnd.check();
  assert.equal(state.restarts.length, 1);
  state.count = 0;
  await afterEnd.check(snapshot());
  const completed = makeSchedule();
  await completed.load();
  await completed.check(snapshot());
  assert.equal(state.restarts.length, 2);
});

test("startup catches up inside the window, but an entirely missed window cannot force late LTS", async (context) => {
  const { state, schedule } = await setup(context);
  state.now = START + 10 * MINUTE;
  await schedule.check();
  assert.equal(state.restarts.length, 1);
  const missed = await setup(context);
  missed.state.now = END;
  await missed.schedule.check();
  assert.deepEqual(missed.state.rotations, []);
});

test("LTS starts again the next Wednesday, superseding any older pending return", async (context) => {
  for (const finish of [true, false]) {
    const { state, schedule } = await setup(context);
    await schedule.check();
    if (finish) { state.now = END; await schedule.check(); }
    state.rotation = ["FFA_Duelyard"];
    state.now = START + 7 * 24 * 60 * MINUTE;
    await schedule.check();
    assert.deepEqual(state.rotations.at(-1), getPresetMaps("lts"));
    assert.equal(state.restarts.length, finish ? 3 : 2);
  }
});

test("Nitrado busy and failed settings reads can retry before 21:00", async (context) => {
  const { state, schedule } = await setup(context);
  state.status = "restarting";
  await schedule.check();
  assert.deepEqual(state.rotations, []);
  state.status = "started";
  state.readError = true;
  await assert.rejects(schedule.check(), /read failed/);
  state.readError = false;
  state.now += MINUTE;
  await schedule.check();
  assert.equal(state.restarts.length, 1);
});

test("verified LTS settings still get their restart after Nitrado becomes available", async (context) => {
  const fixture = await setup(context, { onSave: () => { fixture.state.status = "restarting"; } });
  const { state, schedule, makeSchedule } = fixture;
  // A temporary failure after a verified save must preserve the unfinished restart.
  await schedule.check().catch(() => {});
  assert.equal(state.rotations.length, 1);
  assert.equal(state.restarts.length, 0);
  state.status = "started";
  state.now += MINUTE;
  const restored = makeSchedule();
  await restored.load();
  await restored.check();
  assert.equal(state.rotations.length, 1, "verified settings must not be saved twice");
  assert.equal(state.restarts.length, 1, "resume the unfinished LTS restart");
});

test("the 21:00 boundary queries players even while an earlier scheduled operation is pending", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const directory = await createTestDirectory(context);
  let now = END - 1000;
  let refreshes = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const starting = new Promise<void>((resolve) => { entered = resolve; });
  let completed!: () => void;
  const returned = new Promise<void>((resolve) => { completed = resolve; });
  const schedule = new LtsSchedule({
    filePath: join(directory, "lts-schedule.json"), now: () => now,
    refresh: async () => {
      refreshes++;
      return { status: "online", event: null, snapshot: {
        onlineCount: 0, players: [], map: "LTS_Wardenglade", maxPlayers: 26, updatedAt: now,
      } };
    },
    setPreset: async (preset, options) => {
      await options.beforeMutation();
      if (preset === "lts") { entered(); await gate; }
      return "applied";
    },
    onError: (error) => { throw error; },
    onApplied: (preset) => { if (preset === "duelyard") completed(); },
  });
  context.after(() => { release(); schedule.stop(); });
  schedule.start();
  await starting;
  const pending = schedule.check();
  now = END;
  context.mock.timers.tick(1000);
  const boundaryRefreshes = refreshes;
  release();
  await pending;
  assert.equal(boundaryRefreshes, 1, "request players at 21:00 without waiting for the pending operation");
  await returned;
});

test("failed preflight cannot start late LTS or reset unrelated maps after 21:00", async (context) => {
  const { state, schedule } = await setup(context);
  state.status = "restarting";
  await schedule.check();
  state.status = "started";
  state.now = END;
  await schedule.check();
  assert.deepEqual(state.rotations, []);
});

test("ambiguous POST failures cannot replay on polls or bot restarts", async (context) => {
  for (const errors of [{ saveError: new Error("save timeout") }, { restartError: new Error("restart timeout") }]) {
    const { state, schedule, makeSchedule } = await setup(context, errors);
    await assert.rejects(schedule.check(), /timeout/);
    await schedule.check();
    const restored = makeSchedule();
    await restored.load();
    await restored.check();
    assert.equal(state.rotations.length, 1);
    assert.equal(state.restarts.length, errors.saveError ? 0 : 1);
  }
});

test("concurrent timer and player polls share one operation", async (context) => {
  const { state, schedule, snapshot } = await setup(context);
  const timer = schedule.check();
  const poll = schedule.check(snapshot());
  assert.equal(timer, poll);
  await Promise.all([timer, poll]);
  assert.equal(state.restarts.length, 1);
});

test("malformed persisted schedule state is rejected", async (context) => {
  const { schedule, filePath } = await setup(context);
  for (const state of [null, {}, { startsAt: START + MINUTE, phase: "complete" }, { startsAt: START, phase: "unknown" }]) {
    await writeFile(filePath, JSON.stringify(state));
    await assert.rejects(schedule.load(), /Некорректный файл/);
  }
});
