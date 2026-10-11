import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Collection, MessageFlags, type ChatInputCommandInteraction, type Client } from "discord.js";
import { createEventCommand, handleEventCommand, registerEventCommands } from "../event-command";

function fakeInteraction(roles: string[] | { cache: Collection<string, unknown> }, subcommand = "start", guildId: string | null = "guild") {
  const replies: { content: string; flags: number }[] = [];
  const edits: string[] = [];
  const deferrals: number[] = [];
  const deletions: string[] = [];
  const interaction = {
    commandName: "event", guildId, member: guildId ? { roles } : null,
    options: { getSubcommand: () => subcommand },
    async reply(reply: { content: string; flags: number }) { replies.push(reply); },
    async deferReply(options: { flags: number }) { deferrals.push(options.flags); },
    async editReply(content: string) { edits.push(content); },
    async deleteReply() { deletions.push("@original"); },
  } as unknown as ChatInputCommandInteraction;
  return { interaction, replies, edits, deferrals, deletions };
}

test("only configured roles can change event status, including in cached and uncached guilds", async () => {
  for (const roles of [["allowed"], { cache: new Collection([["allowed", {}]]) }]) {
    const start = fakeInteraction(roles);
    const stop = fakeInteraction(roles, "stop");
    const changes: boolean[] = [];
    const change = async (closed: boolean) => { changes.push(closed); return { sent: 2, failed: 0 }; };
    assert.equal(await handleEventCommand(start.interaction, ["another", "allowed"], change), true);
    await handleEventCommand(stop.interaction, ["allowed"], change);
    assert.deepEqual(changes, [true, false]);
    assert.deepEqual(start.deferrals, [MessageFlags.Ephemeral]);
    assert.deepEqual(stop.deferrals, [MessageFlags.Ephemeral]);
    assert.match(start.edits[0], /сервер закрыт на ивент/);
    assert.match(stop.edits[0], /сервер открыт/);
  }
});

test("missing roles, an empty configuration and direct messages never invoke the update", async () => {
  const cases = [
    { fake: fakeInteraction(["other"]), roles: ["allowed"], text: /нет роли/ },
    { fake: fakeInteraction({ cache: new Collection() }), roles: ["allowed"], text: /нет роли/ },
    { fake: fakeInteraction(["allowed"]), roles: [], text: /EVENT_MANAGER_ROLE_IDS/ },
    { fake: fakeInteraction(["allowed"], "start", null), roles: ["allowed"], text: /только на Discord-сервере/ },
  ];
  for (const { fake, roles, text } of cases) {
    await handleEventCommand(fake.interaction, roles, async () => { assert.fail("unauthorized status change"); });
    assert.equal(fake.replies.length, 1);
    assert.equal(fake.replies[0].flags, MessageFlags.Ephemeral);
    assert.match(fake.replies[0].content, text);
    assert.deepEqual(fake.deferrals, []);
  }
});

test("partial notification failures are reported while confirming the saved status", async () => {
  const fake = fakeInteraction(["allowed"]);
  await handleEventCommand(fake.interaction, ["allowed"], async () => ({ sent: 1, failed: 1 }));
  assert.match(fake.edits[0], /Статус сохранён/);
  assert.match(fake.edits[0], /Не удалось отправить/);
});

test("other commands are left to their own handlers", async () => {
  const fake = fakeInteraction(["allowed"]);
  Object.defineProperty(fake.interaction, "commandName", { value: "other" });
  assert.equal(await handleEventCommand(fake.interaction, ["allowed"], async () => { assert.fail(); }), false);
  assert.deepEqual(fake.replies, []);
});

test("failed persistence does not report that the server was closed", async (context) => {
  const fake = fakeInteraction(["allowed"]);
  context.mock.method(console, "error", () => {});
  await handleEventCommand(fake.interaction, ["allowed"], async () => { throw new Error("disk unavailable"); });
  assert.match(fake.edits[0], /Не удалось сохранить статус/);
  assert.doesNotMatch(fake.edits[0], /Статус сохранён/);
});

test("stop completes its deferred response after sending the opening notice", async (context) => {
  const fake = fakeInteraction(["allowed"], "stop");
  const order: string[] = [];
  context.mock.method(fake.interaction, "editReply", async (content: string) => {
    order.push("reply");
    assert.match(content, /сервер открыт/);
  });
  await handleEventCommand(fake.interaction, ["allowed"], async (closed) => {
    assert.equal(closed, false);
    assert.deepEqual(fake.deferrals, [MessageFlags.Ephemeral]);
    order.push("notification");
    return { sent: 1, failed: 0 };
  });
  assert.deepEqual(order, ["notification", "reply"]);
  assert.deepEqual(fake.deletions, []);
});

test("failed final responses clear the thinking indicator without sending duplicate notifications", async (context) => {
  context.mock.method(console, "error", () => {});
  for (const subcommand of ["start", "stop"]) {
    const fake = fakeInteraction(["allowed"], subcommand);
    let notifications = 0;
    context.mock.method(fake.interaction, "editReply", async () => { throw new Error("Reply unavailable"); });
    assert.equal(await handleEventCommand(fake.interaction, ["allowed"], async () => {
      notifications++;
      return { sent: 1, failed: 0 };
    }), true);
    assert.equal(notifications, 1);
    assert.deepEqual(fake.deletions, ["@original"]);
  }
});

test("event commands are registered once per configured guild without replacing other commands", async () => {
  const registrations: { data: ReturnType<ReturnType<typeof createEventCommand>["toJSON"]>; guildId: string }[] = [];
  const client = {
    channels: { async fetch(id: string) { return id === "dm" ? {} : { guildId: id === "one" || id === "two" ? "guild-1" : "guild-2" }; } },
    application: { commands: { async create(data: ReturnType<ReturnType<typeof createEventCommand>["toJSON"]>, guildId: string) { registrations.push({ data, guildId }); } } },
  } as unknown as Client;
  await registerEventCommands(client, ["one", "two", "three", "dm"]);
  assert.deepEqual(registrations.map(({ guildId }) => guildId), ["guild-1", "guild-2"]);
  assert.equal(registrations[0].data.name, "event");
  assert.deepEqual(registrations[0].data.options?.map((option) => option.name), ["start", "stop"]);
});
