import { strict as assert } from "node:assert";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { EmbedBuilder, type Client, type Embed } from "discord.js";
import { ActivityNotifications } from "../src/activity-notifications";
import { createOnlinePlayersButtonRow, createPlayerEventEmbed, EVENT_CLOSED_NOTICE, EVENT_OPEN_NOTICE } from "../src/discord-messages";
import { EVENT_AUTO_OPEN_DELAY_MS, EventStatusStore } from "../src/event-status";
import { ServerMonitor, type PlayerEventBatchMessage, type ServerRefreshResult } from "../src/server-monitor";
import { StatusChannelUpdater } from "../src/status-channel-updater";
import { createTestDirectory } from "./test-directory";

const event: PlayerEventBatchMessage = {
  players: ["a", "b"], onlineCount: 2, maxPlayers: 26, map: "FFA_Duelyard", updatedAt: 123456000,
  joinedPlayers: ["b"], leftPlayers: [],
};

async function setup(context: TestContext) {
  const directory = await createTestDirectory(context);
  const path = join(directory, "event-status.json");
  const store = new EventStatusStore(path);
  await store.load();
  const errors: unknown[] = [];
  const channels = new Map<string, ReturnType<typeof fakeChannel>>();
  const client = { user: { id: "bot" }, channels: { async fetch(id: string) { return channels.get(id); } } } as unknown as Client;
  return {
    store, path, channels, errors, client,
    notifications: (
      ids: string[],
      refresh: () => Promise<ServerRefreshResult> = async () => ({ status: "online", snapshot: event, event: null }),
      onStatusChange?: (closed: boolean) => void,
    ) => new ActivityNotifications(client, ids, store, (_id, error) => errors.push(error), refresh, onStatusChange),
  };
}

function fakeEmbed(builder: EmbedBuilder) {
  const data = builder.toJSON();
  return { ...data, fields: data.fields ?? [], toJSON: () => data } as unknown as Embed;
}

function fakeMessage(id: string, authorId = "bot", embed = createPlayerEventEmbed(event)) {
  return {
    id, author: { id: authorId }, embeds: [fakeEmbed(embed)],
    components: [createOnlinePlayersButtonRow().toJSON()], edits: 0,
    async edit(options: { embeds: EmbedBuilder[] }) {
      this.edits++;
      this.embeds = options.embeds.map(fakeEmbed);
      return this;
    },
  };
}

function fakeChannel() {
  const sent: ReturnType<typeof fakeMessage>[] = [];
  return {
    sent, isSendable: () => true,
    messages: {
      async fetch() {
        assert.fail("Sending an event notice must not read message history");
      },
    },
    async send(options: { embeds: EmbedBuilder[]; components?: ReturnType<typeof createOnlinePlayersButtonRow>[] }) {
      const message = fakeMessage(`sent-${sent.length + 1}`, "bot", options.embeds[0]);
      message.components = options.components?.map((row) => row.toJSON()) ?? [];
      sent.push(message);
      return message;
    },
  };
}

test("every start and stop sends a new notice with TAB and preserves previous messages", async (context) => {
  const { channels, store, errors, notifications } = await setup(context);
  const message = fakeMessage("existing");
  const original = message.embeds[0].toJSON();
  const components = structuredClone(message.components);
  const channel = fakeChannel();
  channel.sent.push(message);
  channels.set("one", channel);
  const notices = notifications(["one"]);

  assert.deepEqual(await notices.setEventClosed(true), { sent: 1, failed: 0 });
  await notices.setEventClosed(true);
  await notices.setEventClosed(false);
  assert.equal(channel.sent.length, 4);
  assert.equal(channel.sent[1].embeds[0].description, `Изменения активности на сервере\n${EVENT_CLOSED_NOTICE}`);
  assert.equal(channel.sent[2].embeds[0].description, `Изменения активности на сервере\n${EVENT_CLOSED_NOTICE}`);
  assert.deepEqual(channel.sent[1].embeds[0].fields, [
    { name: "Онлайн", value: "**2/26**", inline: true },
    { name: "Карта", value: "**FFA\\_Duelyard**", inline: true },
  ]);
  assert.equal(channel.sent[3].embeds[0].description, EVENT_OPEN_NOTICE);
  assert.deepEqual(channel.sent[3].embeds[0].fields, [
    { name: "Онлайн", value: "**2/26**", inline: true },
    { name: "Карта", value: "**FFA\\_Duelyard**", inline: true },
  ]);
  for (const notice of channel.sent) {
    assert.equal(notice.edits, 0);
    assert.deepEqual(notice.components, components);
  }
  assert.deepEqual(message.embeds[0].toJSON(), original);
  assert.equal(store.closed, false);
  assert.deepEqual(errors, []);
});

test("new notices use the persisted status after a restart and can be reopened", async (context) => {
  const { channels, store, path, errors, notifications } = await setup(context);
  const channel = fakeChannel();
  channels.set("one", channel);
  const notices = notifications(["one"]);
  assert.deepEqual(await notices.setEventClosed(true), { sent: 1, failed: 0 });
  await notices.publish(event);
  assert.match(channel.sent[0].embeds[0].description!, /Сервер закрыт на ивент/);
  assert.match(channel.sent[1].embeds[0].description!, /Сервер закрыт на ивент/);

  const restored = new EventStatusStore(path);
  await restored.load();
  assert.equal(restored.closed, true);
  const client = { user: { id: "bot" }, channels: { async fetch() { return channel; } } } as unknown as Client;
  const restarted = new ActivityNotifications(client, ["one"], restored, (_id, error) => errors.push(error),
    async () => ({ status: "online", snapshot: event, event: null }));
  await restarted.setEventClosed(false);
  await restarted.publish(event);
  assert.match(channel.sent[0].embeds[0].description!, /Сервер закрыт/);
  assert.match(channel.sent[1].embeds[0].description!, /Сервер закрыт/);
  assert.equal(channel.sent[2].embeds[0].description, EVENT_OPEN_NOTICE);
  assert.doesNotMatch(channel.sent[3].embeds[0].description!, /Сервер закрыт/);
  assert.equal(store.closed, true); // The old process is no longer used.
  assert.deepEqual(errors, []);
});

test("one inaccessible channel does not prevent new notices in other channels", async (context) => {
  const { channels, store, errors, notifications } = await setup(context);
  const channel = fakeChannel();
  channels.set("good", channel);
  const result = await notifications(["missing", "good"]).setEventClosed(true);
  assert.deepEqual(result, { sent: 1, failed: 1 });
  assert.equal(store.closed, true);
  assert.match(channel.sent[0].embeds[0].description!, /Сервер закрыт/);
  assert.equal(errors.length, 1);
});

test("a command during a slow send announces the status before later activity notifications", async (context) => {
  const { channels, store, errors, notifications } = await setup(context);
  const channel = fakeChannel();
  const send = channel.send.bind(channel);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  channel.send = async (options) => { await gate; return send(options); };
  channels.set("one", channel);
  const notices = notifications(["one"]);
  const first = notices.publish(event);
  await nextTurn();
  const start = notices.setEventClosed(true);
  const second = notices.publish(event);
  assert.equal(store.closed, false);
  release();
  await Promise.all([first, start, second]);
  assert.equal(channel.sent.length, 3);
  assert.doesNotMatch(channel.sent[0].embeds[0].description!, /Сервер закрыт/);
  assert.equal(channel.sent[1].embeds[0].description, `Изменения активности на сервере\n${EVENT_CLOSED_NOTICE}`);
  assert.match(channel.sent[2].embeds[0].description!, /Сервер закрыт на ивент/);
  await notices.setEventClosed(false);
  assert.equal(channel.sent[3].embeds[0].description, EVENT_OPEN_NOTICE);
  for (const message of channel.sent) assert.equal(message.edits, 0);
  assert.deepEqual(errors, []);
});

test("start and stop use fresh server data rather than the previous activity notification", async (context) => {
  const { channels, notifications } = await setup(context);
  const channel = fakeChannel();
  channels.set("one", channel);
  const notices = notifications(["one"], async () => ({
    status: "online", snapshot: { ...event, onlineCount: 4, maxPlayers: 32, map: "current_map" }, event: null,
  }));
  await notices.publish(event);
  await notices.setEventClosed(true);
  assert.deepEqual(channel.sent[1].embeds[0].fields, [
    { name: "Онлайн", value: "**4/32**", inline: true },
    { name: "Карта", value: "**current\\_map**", inline: true },
  ]);
  assert.equal(channel.sent[0].embeds[0].fields[0].value, "**2/26**");
  await notices.publish({ ...event, onlineCount: 3, players: ["a", "b", "c"], joinedPlayers: ["c"] });
  assert.match(channel.sent[2].embeds[0].description!, /🔒 Сервер закрыт на ивент/);
  assert.equal(channel.sent[2].embeds[0].fields[0].value, "**3/26**");
  assert.equal(channel.sent[2].embeds[0].fields[2].name, "🟢 Зашли");
  await notices.setEventClosed(false);
  assert.equal(channel.sent[3].embeds[0].description, EVENT_OPEN_NOTICE);
  assert.deepEqual(channel.sent[3].embeds[0].fields, [
    { name: "Онлайн", value: "**4/32**", inline: true },
    { name: "Карта", value: "**current\\_map**", inline: true },
  ]);
});

test("start and stop still save and announce the status when server data is unavailable", async (context) => {
  const { channels, store, notifications } = await setup(context);
  const channel = fakeChannel();
  channels.set("one", channel);
  for (const status of ["offline", "unavailable"] as const) {
    const notices = notifications(["one"], async () => ({ status, error: new Error("Server unavailable") }));
    for (const closed of [true, false]) {
      assert.deepEqual(await notices.setEventClosed(closed), { sent: 1, failed: 0 });
      assert.equal(store.closed, closed);
      const embed = channel.sent.at(-1)!.embeds[0];
      assert.equal(embed.description, closed ? `Изменения активности на сервере\n${EVENT_CLOSED_NOTICE}` : EVENT_OPEN_NOTICE);
      assert.deepEqual(embed.fields, [
        { name: "Онлайн", value: "Нет данных", inline: true },
        { name: "Карта", value: "Нет данных", inline: true },
      ]);
    }
  }
});

test("refreshing for start can publish real player changes without blocking the command", async (context) => {
  const { channels, notifications } = await setup(context);
  const channel = fakeChannel();
  channels.set("one", channel);
  const deliveries: Promise<unknown>[] = [];
  let notices: ActivityNotifications;
  let count = 1;
  const monitor = new ServerMonitor({
    async info() { return { header: "I", players: count, max_players: 26, map: "FFA_Duelyard" }; },
    async players() { return ["a", "b"].slice(0, count).map((name, index) => ({ name, index, score: 0, duration: 1 })); },
  }, {
    host: "127.0.0.1", port: 27015, timeout: 1000,
    onRefresh(result) {
      if (result.status === "online" && result.event) deliveries.push(notices.publish(result.event));
    },
  });
  await monitor.refresh();
  notices = notifications(["one"], () => monitor.refresh());
  count = 2;
  assert.deepEqual(await notices.setEventClosed(true), { sent: 1, failed: 0 });
  await Promise.all(deliveries);
  assert.equal(channel.sent.length, 2);
  for (const message of channel.sent) {
    assert.match(message.embeds[0].description!, /Сервер закрыт на ивент/);
    assert.equal(message.embeds[0].fields[0].value, "**2/26**");
  }
  assert.equal(channel.sent[1].embeds[0].fields[2].value, "• **b**");
});

test("an event opens automatically after four hours and sends the existing opening notice once", async (context) => {
  const { channels, store, notifications, errors } = await setup(context);
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const channel = fakeChannel();
  channels.set("one", channel);
  let queries = 0;
  const notices = notifications(["one"], async () => {
    queries++;
    return { status: "online", snapshot: event, event: null };
  });
  await notices.setEventClosed(true);
  context.mock.timers.tick(EVENT_AUTO_OPEN_DELAY_MS - 1);
  await notices.publish(event);
  assert.equal(store.closed, true);
  assert.equal(channel.sent.filter((message) => message.embeds[0].description === EVENT_OPEN_NOTICE).length, 0);

  context.mock.timers.tick(1);
  await notices.publish(event); // Wait behind the timer's queued delivery and verify subsequent activity.
  assert.equal(store.closed, false);
  assert.equal(store.autoOpenAt, undefined);
  const opening = channel.sent.filter((message) => message.embeds[0].description === EVENT_OPEN_NOTICE);
  assert.equal(opening.length, 1);
  assert.deepEqual(opening[0].embeds[0].fields, [
    { name: "Онлайн", value: "**2/26**", inline: true },
    { name: "Карта", value: "**FFA\\_Duelyard**", inline: true },
  ]);
  assert.deepEqual(opening[0].components, [createOnlinePlayersButtonRow().toJSON()]);
  assert.doesNotMatch(channel.sent.at(-1)!.embeds[0].description!, /Сервер закрыт/);
  assert.equal(queries, 2);
  context.mock.timers.tick(EVENT_AUTO_OPEN_DELAY_MS);
  await notices.publish(event);
  assert.equal(channel.sent.filter((message) => message.embeds[0].description === EVENT_OPEN_NOTICE).length, 1);
  assert.deepEqual(errors, []);
});

test("a manual stop cancels automatic opening, including a timer already waiting behind Discord", async (context) => {
  const { channels, store, notifications } = await setup(context);
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const channel = fakeChannel();
  channels.set("one", channel);
  const notices = notifications(["one"]);
  await notices.setEventClosed(true);
  const send = channel.send.bind(channel);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  channel.send = async (options) => { await gate; return send(options); };
  const activity = notices.publish(event);
  await nextTurn();
  const stop = notices.setEventClosed(false);
  context.mock.timers.tick(EVENT_AUTO_OPEN_DELAY_MS);
  release();
  await Promise.all([activity, stop]);
  await notices.publish(event);
  assert.equal(store.closed, false);
  assert.equal(store.autoOpenAt, undefined);
  assert.equal(channel.sent.filter((message) => message.embeds[0].description === EVENT_OPEN_NOTICE).length, 1);
});

test("a repeated start begins a new four-hour countdown", async (context) => {
  const { channels, store, notifications } = await setup(context);
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const channel = fakeChannel();
  channels.set("one", channel);
  const notices = notifications(["one"]);
  await notices.setEventClosed(true);
  context.mock.timers.tick(EVENT_AUTO_OPEN_DELAY_MS / 2);
  await notices.setEventClosed(true);
  assert.equal(store.autoOpenAt, 1000 + EVENT_AUTO_OPEN_DELAY_MS * 1.5);
  context.mock.timers.tick(EVENT_AUTO_OPEN_DELAY_MS / 2);
  await notices.publish(event);
  assert.equal(store.closed, true);
  assert.equal(channel.sent.filter((message) => message.embeds[0].description === EVENT_OPEN_NOTICE).length, 0);
  context.mock.timers.tick(EVENT_AUTO_OPEN_DELAY_MS / 2);
  await notices.publish(event);
  assert.equal(store.closed, false);
  assert.equal(channel.sent.filter((message) => message.embeds[0].description === EVENT_OPEN_NOTICE).length, 1);
});

test("restart restores the remaining time, and overdue events open after reconnecting", async (context) => {
  const { channels, path, client, errors } = await setup(context);
  const channel = fakeChannel();
  channels.set("one", channel);
  for (const downtime of [EVENT_AUTO_OPEN_DELAY_MS / 2, EVENT_AUTO_OPEN_DELAY_MS + 1000]) {
    context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
    const activeStore = new EventStatusStore(path);
    await activeStore.load();
    const active = new ActivityNotifications(client, ["one"], activeStore, (_id, error) => errors.push(error),
      async () => ({ status: "online", snapshot: event, event: null }));
    await active.setEventClosed(true);
    const deadline = activeStore.autoOpenAt;
    // A stopped process loses its timers, while the state file survives.
    context.mock.timers.reset();
    context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 + downtime });
    const restored = new EventStatusStore(path);
    await restored.load();
    assert.equal(restored.autoOpenAt, deadline);
    const restarted = new ActivityNotifications(client, ["one"], restored, (_id, error) => errors.push(error),
      async () => ({ status: "online", snapshot: event, event: null }));
    await restarted.restoreAutoOpen();
    const before = channel.sent.length;
    if (downtime < EVENT_AUTO_OPEN_DELAY_MS) {
      context.mock.timers.tick(EVENT_AUTO_OPEN_DELAY_MS - downtime - 1);
      await restarted.publish(event);
      assert.equal(restored.closed, true);
    }
    context.mock.timers.tick(1);
    await restarted.publish(event);
    assert.equal(restored.closed, false);
    assert.equal(channel.sent.slice(before).filter((message) => message.embeds[0].description === EVENT_OPEN_NOTICE).length, 1);
    context.mock.timers.reset();
  }
  assert.deepEqual(errors, []);
});

test("upgrading an active event without a deadline sets one once without reposting closure", async (context) => {
  const { channels, path, store, notifications } = await setup(context);
  await writeFile(path, JSON.stringify({ closed: true }));
  await store.load();
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const channel = fakeChannel();
  channels.set("one", channel);
  const notices = notifications(["one"]);
  await notices.restoreAutoOpen();
  assert.equal(store.autoOpenAt, 1000 + EVENT_AUTO_OPEN_DELAY_MS);
  assert.equal(channel.sent.length, 0);
  context.mock.timers.tick(1000);
  await notices.restoreAutoOpen();
  assert.equal(store.autoOpenAt, 1000 + EVENT_AUTO_OPEN_DELAY_MS);
  context.mock.timers.tick(EVENT_AUTO_OPEN_DELAY_MS - 1000);
  await notices.publish(event);
  assert.equal(store.closed, false);
  assert.equal(channel.sent[0].embeds[0].description, EVENT_OPEN_NOTICE);
});

test("automatic opening retries after a failed state save instead of losing the timer", async (context) => {
  const { channels, store, notifications } = await setup(context);
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  context.mock.method(console, "error", () => {});
  const channel = fakeChannel();
  channels.set("one", channel);
  const notices = notifications(["one"]);
  await notices.setEventClosed(true);
  const setClosed = store.setClosed.bind(store);
  let fail = true;
  context.mock.method(store, "setClosed", async (closed: boolean) => {
    if (!closed && fail) {
      fail = false;
      throw new Error("Disk temporarily unavailable");
    }
    return setClosed(closed);
  });
  context.mock.timers.tick(EVENT_AUTO_OPEN_DELAY_MS);
  await notices.publish(event);
  assert.equal(store.closed, true);
  context.mock.timers.tick(59_999);
  await notices.publish(event);
  assert.equal(store.closed, true);
  context.mock.timers.tick(1);
  await notices.publish(event);
  assert.equal(store.closed, false);
  assert.equal(channel.sent.filter((message) => message.embeds[0].description === EVENT_OPEN_NOTICE).length, 1);
});

test("channel locks track restored events, manual commands and automatic opening", async (context) => {
  const { channels, store, notifications, errors } = await setup(context);
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const channel = Object.assign(fakeChannel(), {
    name: "old", async setName(name: string) { this.name = name; },
  });
  channels.set("one", channel);
  const updater = new StatusChannelUpdater(["one"], async () => channel, (_id, error) => errors.push(error));
  const notices = notifications(["one"], undefined, (closed) => updater.setEventClosed(closed));
  await store.setClosed(true);
  await notices.restoreAutoOpen();
  updater.update("🟢・union・2⁄26・map");
  await nextTurn();
  assert.equal(channel.name, "🔒・union・2⁄26・map");
  await notices.setEventClosed(false);
  await nextTurn();
  assert.equal(channel.name, "🟢・union・2⁄26・map");
  await notices.setEventClosed(true);
  await nextTurn();
  assert.equal(channel.name, "🔒・union・2⁄26・map");
  updater.update("🟢・union・3⁄26・new-map");
  await nextTurn();
  assert.equal(channel.name, "🔒・union・3⁄26・new-map");
  context.mock.timers.tick(EVENT_AUTO_OPEN_DELAY_MS);
  await notices.publish(event);
  await nextTurn();
  assert.equal(channel.name, "🟢・union・3⁄26・new-map");
  assert.deepEqual(errors, []);
});
