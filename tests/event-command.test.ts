import { strict as assert } from "node:assert";
import { test } from "node:test";
import { ApplicationCommandType, Collection, MessageFlags, type ChatInputCommandInteraction, type Client } from "discord.js";
import { createEventCommand, handleEventCommand, registerEventCommands } from "../src/event-command";

function fakeInteraction(roles: string[] | { cache: Collection<string, unknown> }, subcommand = "close", guildId: string | null = "guild") {
  const replies: { content: string; flags: number }[] = [];
  const edits: string[] = [];
  const deferrals: number[] = [];
  const deletions: string[] = [];
  const interaction = {
    commandName: "server", guildId, member: guildId ? { roles } : null,
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
    const close = fakeInteraction(roles);
    const open = fakeInteraction(roles, "open");
    const changes: boolean[] = [];
    const change = async (closed: boolean) => { changes.push(closed); return { sent: 2, failed: 0 }; };
    assert.equal(await handleEventCommand(close.interaction, ["another", "allowed"], change), true);
    await handleEventCommand(open.interaction, ["allowed"], change);
    assert.deepEqual(changes, [true, false]);
    assert.deepEqual(close.deferrals, [MessageFlags.Ephemeral]);
    assert.deepEqual(open.deferrals, [MessageFlags.Ephemeral]);
    assert.deepEqual(close.edits, ["Статус сохранён: сервер закрыт на ивент"]);
    assert.deepEqual(open.edits, ["Статус сохранён: ивент завершён, сервер открыт"]);
  }
});

test("missing roles, an empty configuration and direct messages never invoke the update", async () => {
  const cases = [
    { fake: fakeInteraction(["other"]), roles: ["allowed"], text: "У вас нет роли для управления отметкой ивента" },
    { fake: fakeInteraction({ cache: new Collection() }), roles: ["allowed"], text: "У вас нет роли для управления отметкой ивента" },
    { fake: fakeInteraction(["allowed"]), roles: [], text: "Управление ивентом не настроено: укажите EVENT_MANAGER_ROLE_IDS в .env" },
    { fake: fakeInteraction(["allowed"], "close", null), roles: ["allowed"], text: "Эта команда доступна только на Discord-сервере" },
  ];
  for (const { fake, roles, text } of cases) {
    await handleEventCommand(fake.interaction, roles, async () => { assert.fail("unauthorized status change"); });
    assert.equal(fake.replies.length, 1);
    assert.equal(fake.replies[0].flags, MessageFlags.Ephemeral);
    assert.equal(fake.replies[0].content, text);
    assert.deepEqual(fake.deferrals, []);
  }
});

test("partial notification failures still confirm the saved status without a trailing period", async () => {
  for (const [subcommand, reply] of [
    ["close", "Статус сохранён: сервер закрыт на ивент"],
    ["open", "Статус сохранён: ивент завершён, сервер открыт"],
  ]) {
    const fake = fakeInteraction(["allowed"], subcommand);
    await handleEventCommand(fake.interaction, ["allowed"], async () => ({ sent: 1, failed: 1 }));
    assert.deepEqual(fake.edits, [reply]);
  }
});

test("unknown subcommands reply with usage without a trailing period and never invoke the update", async () => {
  for (const subcommand of ["unknown", "start", "stop"]) {
    const fake = fakeInteraction(["allowed"], subcommand);
    assert.equal(await handleEventCommand(fake.interaction, ["allowed"], async () => {
      assert.fail("unknown subcommand must not change event status");
    }), true);
    assert.deepEqual(fake.replies, [{ content: "Используйте /server close или /server open", flags: MessageFlags.Ephemeral }]);
    assert.deepEqual(fake.deferrals, []);
  }
});

test("other commands are left to their own handlers", async () => {
  for (const commandName of ["other", "event"]) {
    const fake = fakeInteraction(["allowed"]);
    Object.defineProperty(fake.interaction, "commandName", { value: commandName });
    assert.equal(await handleEventCommand(fake.interaction, ["allowed"], async () => { assert.fail(); }), false);
    assert.deepEqual(fake.replies, []);
  }
  const restart = fakeInteraction(["allowed"], "restart");
  assert.equal(await handleEventCommand(restart.interaction, ["allowed"], async () => { assert.fail(); }), false);
  assert.deepEqual(restart.replies, []);
});

test("failed persistence does not report that the server was closed", async (context) => {
  const fake = fakeInteraction(["allowed"]);
  context.mock.method(console, "error", () => {});
  await handleEventCommand(fake.interaction, ["allowed"], async () => { throw new Error("disk unavailable"); });
  assert.deepEqual(fake.edits, ["Не удалось сохранить статус ивента. Попробуйте ещё раз"]);
});

test("open completes its deferred response after sending the opening notice", async (context) => {
  const fake = fakeInteraction(["allowed"], "open");
  const order: string[] = [];
  context.mock.method(fake.interaction, "editReply", async (content: string) => {
    order.push("reply");
    assert.equal(content, "Статус сохранён: ивент завершён, сервер открыт");
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
  for (const subcommand of ["close", "open"]) {
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

test("server commands replace legacy event commands once per guild and preserve other commands on repeated startup", async () => {
  const registrations: { data: ReturnType<ReturnType<typeof createEventCommand>["toJSON"]>; guildId: string }[] = [];
  const deletions: { id: string; guildId: string }[] = [];
  const stored = new Map(["guild-1", "guild-2"].map((guildId) => [guildId, new Collection([
    ["legacy", { id: "legacy", name: "event", type: ApplicationCommandType.ChatInput }],
    ["other", { id: "other", name: "other", type: ApplicationCommandType.ChatInput }],
    ["context", { id: "context", name: "event", type: ApplicationCommandType.User }],
  ])]));
  const client = {
    channels: { async fetch(id: string) { return id === "dm" ? {} : { guildId: id === "one" || id === "two" ? "guild-1" : "guild-2" }; } },
    application: { commands: {
      async create(data: ReturnType<ReturnType<typeof createEventCommand>["toJSON"]>, guildId: string) {
        registrations.push({ data, guildId });
        stored.get(guildId)!.set("server", { id: "server", name: data.name, type: ApplicationCommandType.ChatInput });
      },
      async fetch({ guildId }: { guildId: string }) { return stored.get(guildId)!; },
      async delete(id: string, guildId: string) {
        assert.ok(stored.get(guildId)!.has("server"), "register the replacement before deleting the legacy command");
        deletions.push({ id, guildId });
        stored.get(guildId)!.delete(id);
      },
    } },
  } as unknown as Client;
  await registerEventCommands(client, ["one", "two", "three", "dm"]);
  assert.deepEqual(registrations.map(({ guildId }) => guildId), ["guild-1", "guild-2"]);
  assert.equal(registrations[0].data.name, "server");
  assert.deepEqual(registrations[0].data.options?.map((option) => option.name), ["close", "open", "restart"]);
  await registerEventCommands(client, ["one", "two", "three", "dm"]);
  assert.deepEqual(registrations.map(({ guildId }) => guildId), ["guild-1", "guild-2", "guild-1", "guild-2"]);
  assert.deepEqual(deletions, [{ id: "legacy", guildId: "guild-1" }, { id: "legacy", guildId: "guild-2" }]);
  for (const commands of stored.values()) assert.deepEqual([...commands.keys()], ["other", "context", "server"]);
});
