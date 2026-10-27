import { strict as assert } from "node:assert";
import { test } from "node:test";
import { ApplicationCommandType, Collection, MessageFlags, type ChatInputCommandInteraction, type Client } from "discord.js";
import { createEventCommand, getServerCommandName, handleEventCommand, registerEventCommands } from "../src/event-command";
import { SERVER_MAPS } from "../src/server-maps";

const commandName = getServerCommandName(" Union ");

function fakeInteraction(roles: string[] | { cache: Collection<string, unknown> }, subcommand = "close", guildId: string | null = "guild", group: string | null = null) {
  const replies: { content: string; flags: number }[] = [];
  const edits: string[] = [];
  const deferrals: number[] = [];
  const deletions: string[] = [];
  const interaction = {
    commandName, guildId, member: guildId ? { roles } : null,
    options: { getSubcommand: () => subcommand, getSubcommandGroup: () => group },
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
    assert.equal(await handleEventCommand(close.interaction, ["another", "allowed"], change, commandName), true);
    await handleEventCommand(open.interaction, ["allowed"], change, commandName);
    assert.deepEqual(changes, [true, false]);
    assert.deepEqual(close.deferrals, [MessageFlags.Ephemeral]);
    assert.deepEqual(open.deferrals, [MessageFlags.Ephemeral]);
    assert.deepEqual(close.edits, ["Статус сохранён: сервер закрыт на ивент"]);
    assert.deepEqual(open.edits, ["Статус сохранён: ивент завершён, сервер открыт"]);
  }
});

test("missing roles, an empty configuration and direct messages never invoke the update", async () => {
  for (const subcommand of ["close", "open"]) {
    const cases = [
      { fake: fakeInteraction(["other"], subcommand), roles: ["allowed"], text: "У вас нет роли для управления отметкой ивента" },
      { fake: fakeInteraction({ cache: new Collection() }, subcommand), roles: ["allowed"], text: "У вас нет роли для управления отметкой ивента" },
      { fake: fakeInteraction(["allowed"], subcommand), roles: [], text: "Управление ивентом не настроено: укажите EVENT_MANAGER_ROLE_IDS в .env" },
      { fake: fakeInteraction(["allowed"], subcommand, null), roles: ["allowed"], text: "Эта команда доступна только на Discord-сервере" },
    ];
    for (const { fake, roles, text } of cases) {
      // Administrator permission alone does not grant a configured manager role.
      if (fake.interaction.member) Object.assign(fake.interaction.member, { permissions: "8" });
      await handleEventCommand(fake.interaction, roles, async () => { assert.fail("unauthorized status change"); }, commandName);
      assert.equal(fake.replies.length, 1);
      assert.equal(fake.replies[0].flags, MessageFlags.Ephemeral);
      assert.equal(fake.replies[0].content, text);
      assert.deepEqual(fake.deferrals, []);
    }
  }
});

test("partial notification failures still confirm the saved status without a trailing period", async () => {
  for (const [subcommand, reply] of [
    ["close", "Статус сохранён: сервер закрыт на ивент"],
    ["open", "Статус сохранён: ивент завершён, сервер открыт"],
  ]) {
    const fake = fakeInteraction(["allowed"], subcommand);
    await handleEventCommand(fake.interaction, ["allowed"], async () => ({ sent: 1, failed: 1 }), commandName);
    assert.deepEqual(fake.edits, [reply]);
  }
});

test("unknown subcommands reply with usage without a trailing period and never invoke the update", async () => {
  for (const subcommand of ["unknown", "start", "stop", "maps"]) {
    const fake = fakeInteraction(["allowed"], subcommand);
    assert.equal(await handleEventCommand(fake.interaction, ["allowed"], async () => {
      assert.fail("unknown subcommand must not change event status");
    }, commandName), true);
    assert.deepEqual(fake.replies, [{ content: "Используйте /union close или /union open", flags: MessageFlags.Ephemeral }]);
    assert.deepEqual(fake.deferrals, []);
  }
});

test("other commands are left to their own handlers", async () => {
  for (const otherCommandName of ["other", "event", "server"]) {
    const fake = fakeInteraction(["allowed"]);
    Object.defineProperty(fake.interaction, "commandName", { value: otherCommandName });
    assert.equal(await handleEventCommand(fake.interaction, ["allowed"], async () => { assert.fail(); }, commandName), false);
    assert.deepEqual(fake.replies, []);
  }
  for (const [subcommand, group] of [["restart", null], ["map", "set"], ["lts", "set"], ["duelyard", "set"]] as const) {
    const fake = fakeInteraction(["allowed"], subcommand, "guild", group);
    assert.equal(await handleEventCommand(fake.interaction, ["allowed"], async () => { assert.fail(); }, commandName), false);
    assert.deepEqual(fake.replies, []);
  }
});

test("failed persistence does not report that the server was closed", async (context) => {
  const fake = fakeInteraction(["allowed"]);
  context.mock.method(console, "error", () => {});
  await handleEventCommand(fake.interaction, ["allowed"], async () => { throw new Error("disk unavailable"); }, commandName);
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
  }, commandName);
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
    }, commandName), true);
    assert.equal(notifications, 1);
    assert.deepEqual(fake.deletions, ["@original"]);
  }
});

test("configured commands replace legacy server and event commands once per guild and preserve other commands on repeated startup", async () => {
  const registrations: { data: ReturnType<ReturnType<typeof createEventCommand>["toJSON"]>; guildId: string }[] = [];
  const deletions: { id: string; guildId: string }[] = [];
  const stored = new Map(["guild-1", "guild-2"].map((guildId) => [guildId, new Collection([
    ["legacy", { id: "legacy", name: "event", type: ApplicationCommandType.ChatInput }],
    ["server", { id: "server", name: "server", type: ApplicationCommandType.ChatInput }],
    ["other", { id: "other", name: "other", type: ApplicationCommandType.ChatInput }],
    ["context", { id: "context", name: "event", type: ApplicationCommandType.User }],
    ["context-server", { id: "context-server", name: "server", type: ApplicationCommandType.Message }],
  ])]));
  const client = {
    channels: { async fetch(id: string) { return id === "dm" ? {} : { guildId: id === "one" || id === "two" ? "guild-1" : "guild-2" }; } },
    application: { commands: {
      async create(data: ReturnType<ReturnType<typeof createEventCommand>["toJSON"]>, guildId: string) {
        registrations.push({ data, guildId });
        stored.get(guildId)!.set(data.name, { id: data.name, name: data.name, type: ApplicationCommandType.ChatInput });
      },
      async fetch({ guildId }: { guildId: string }) { return stored.get(guildId)!; },
      async delete(id: string, guildId: string) {
        assert.ok(stored.get(guildId)!.has(commandName), "register the replacement before deleting the legacy command");
        deletions.push({ id, guildId });
        stored.get(guildId)!.delete(id);
      },
    } },
  } as unknown as Client;
  await registerEventCommands(client, ["one", "two", "three", "dm"], commandName);
  assert.deepEqual(registrations.map(({ guildId }) => guildId), ["guild-1", "guild-2"]);
  assert.equal(registrations[0].data.name, "union");
  assert.deepEqual(registrations[0].data.options?.map((option) => option.name), ["close", "open", "restart", "set", "show"]);
  await registerEventCommands(client, ["one", "two", "three", "dm"], commandName);
  assert.deepEqual(registrations.map(({ guildId }) => guildId), ["guild-1", "guild-2", "guild-1", "guild-2"]);
  assert.deepEqual(deletions, [
    { id: "legacy", guildId: "guild-1" }, { id: "server", guildId: "guild-1" },
    { id: "legacy", guildId: "guild-2" }, { id: "server", guildId: "guild-2" },
  ]);
  for (const commands of stored.values()) assert.deepEqual([...commands.keys()], ["other", "context", "context-server", "union"]);
});

test("server display names produce valid commands and invalid names fail before registration", () => {
  for (const [displayName, expected] of [[" Union ", "union"], ["Elbrus", "elbrus"], ["", "server"], ["   ", "server"]]) {
    assert.equal(createEventCommand(getServerCommandName(displayName)).toJSON().name, expected);
  }
  for (const displayName of ["Union server", "union!", "a".repeat(33)]) {
    assert.throws(() => getServerCommandName(displayName), /SERVER_DISPLAY_NAME/);
  }
});

test("set is a group with a map command accepting a required maps string", () => {
  const set = createEventCommand(commandName).toJSON().options?.find((option) => option.name === "set");
  assert.ok(set?.type === 2);
  assert.ok(set.options);
  assert.deepEqual(set.options.map((option) => ({ name: option.name, type: option.type })), [
    { name: "map", type: 1 }, { name: "lts", type: 1 }, { name: "duelyard", type: 1 },
  ]);
  const map = set.options.find((option) => option.name === "map");
  assert.deepEqual(map?.options?.map((option) => ({ name: option.name, type: option.type, required: "required" in option && option.required })), [
    { name: "maps", type: 3, required: true },
  ]);
  const maps = map?.options?.[0];
  assert.ok(maps?.type === 3);
  assert.equal(maps.max_length, 1000);
  assert.equal(maps.autocomplete, false);
});

test("set presets are registered as separate commands without arguments", () => {
  const set = createEventCommand(commandName).toJSON().options?.find((option) => option.name === "set");
  assert.ok(set?.type === 2);
  assert.ok(set.options);
  assert.deepEqual(set.options
    .filter((option) => option.name === "lts" || option.name === "duelyard")
    .map((option) => ({ name: option.name, type: option.type, options: option.options ?? [] })), [
    { name: "lts", type: 1, options: [] },
    { name: "duelyard", type: 1, options: [] },
  ]);
});

test("maps is registered as /show maps without required parameters", () => {
  const show = createEventCommand(commandName).toJSON().options?.find((option) => option.name === "show");
  assert.ok(show && "options" in show);
  assert.equal(show.type, 2);
  assert.deepEqual(show.options?.map((option) => ({ name: option.name, type: option.type })), [{ name: "maps", type: 1 }]);
  assert.ok(!show.options?.[0].options?.length);
});

test("show maps displays all 44 maps once in a private reply without manager roles or event changes", async () => {
  for (const roleIds of [[], ["manager"]]) {
    const fake = fakeInteraction([], "maps", "guild", "show");
    assert.equal(await handleEventCommand(fake.interaction, roleIds, async () => { assert.fail("viewing maps must not change the event"); }, commandName), true);
    assert.equal(fake.replies.length, 1);
    const reply = fake.replies[0];
    assert.equal(reply.flags, MessageFlags.Ephemeral);
    assert.match(reply.content, /Доступные карты — 44/);
    const maps = Array.from(reply.content.matchAll(/`([A-Za-z0-9_]+)`/g), (match) => match[1]);
    assert.deepEqual(maps, SERVER_MAPS);
    assert.equal(new Set(maps).size, 44);
    assert.ok(reply.content.length <= 2000, "all maps must fit in one Discord message");
    assert.match(reply.content, /\*\*PR_LTS\*\*\n`PR_LTS_Raid`/);
    assert.match(reply.content, /\*\*BRAWL\*\*/);
    assert.match(reply.content, /\/union set map FFA_Wardenglade/);
    assert.deepEqual(fake.deferrals, []);
  }
});

test("show maps uses the configured command name and rejects direct messages and other commands", async () => {
  const configured = fakeInteraction([], "maps", "guild", "show");
  Object.defineProperty(configured.interaction, "commandName", { value: "elbrus" });
  assert.equal(await handleEventCommand(configured.interaction, [], async () => { assert.fail(); }, "elbrus"), true);
  assert.match(configured.replies[0].content, /\/elbrus set map FFA_Wardenglade/);

  const dm = fakeInteraction([], "maps", null, "show");
  await handleEventCommand(dm.interaction, [], async () => { assert.fail(); }, commandName);
  assert.deepEqual(dm.replies, [{ content: "Эта команда доступна только на Discord-сервере", flags: MessageFlags.Ephemeral }]);

  const other = fakeInteraction([], "maps", "guild", "show");
  Object.defineProperty(other.interaction, "commandName", { value: "other" });
  assert.equal(await handleEventCommand(other.interaction, [], async () => { assert.fail(); }, commandName), false);
  assert.deepEqual(other.replies, []);
});

test("a failed registration keeps the legacy commands available", async (context) => {
  context.mock.method(console, "error", () => {});
  const calls: string[] = [];
  const client = {
    channels: { async fetch() { return { guildId: "guild" }; } },
    application: { commands: {
      async create() { calls.push("create"); throw new Error("Discord unavailable"); },
      async fetch() { calls.push("fetch"); return new Collection(); },
      async delete() { calls.push("delete"); },
    } },
  } as unknown as Client;
  await registerEventCommands(client, ["channel"], commandName);
  assert.deepEqual(calls, ["create"]);
});
