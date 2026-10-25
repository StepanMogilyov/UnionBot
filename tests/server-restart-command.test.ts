import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  ActionRowBuilder, ButtonBuilder, Collection, MessageFlags,
  type ButtonInteraction, type ChatInputCommandInteraction, type InteractionEditReplyOptions,
} from "discord.js";
import { ServerRestartCommand } from "../src/server-restart-command";
import type { ServerRefreshResult } from "../src/server-monitor";
import { MAX_MAP_ROTATION_LENGTH, SERVER_MAPS } from "../src/server-maps";

type Roles = string[] | { cache: Collection<string, unknown> };
type ConfirmationOptions = { filter: (button: ButtonInteraction) => boolean; time: number };

function fakeInteraction(options: {
  commandName?: string;
  group?: string | null;
  subcommand?: string;
  map?: string;
  roles?: Roles;
  buttonRoles?: Roles;
  guildId?: string | null;
  choice?: "confirm" | "cancel" | "timeout";
  onConfirmation?: (button: ButtonInteraction, options: ConfirmationOptions) => Promise<ButtonInteraction>;
} = {}) {
  const replies: { content: string; flags: number }[] = [];
  const edits: (string | InteractionEditReplyOptions)[] = [];
  const deferrals: number[] = [];
  let confirmations = 0;
  let buttonDeferrals = 0;
  const roles = options.roles ?? ["manager"];
  const guildId = options.guildId === undefined ? "guild" : options.guildId;
  const interaction = {
    commandName: options.commandName ?? "union", guildId, member: guildId ? { roles } : null,
    user: { id: "author" }, deferred: false, replied: false,
    options: {
      getSubcommandGroup: () => options.group ?? null,
      getSubcommand: () => options.subcommand ?? "restart",
      getString: (name: string) => {
        assert.equal(name, "maps");
        assert.equal(options.subcommand, "map", "preset commands must not read a string argument");
        return options.map ?? "FFA_Duelyard";
      },
    },
    async reply(reply: { content: string; flags: number }) { replies.push(reply); },
    async deferReply(reply: { flags: number }) { Object.assign(interaction, { deferred: true }); deferrals.push(reply.flags); },
    async editReply(reply: string | InteractionEditReplyOptions) {
      edits.push(reply);
      return { async awaitMessageComponent(collectorOptions: ConfirmationOptions) {
        confirmations++;
        assert.equal(collectorOptions.time, 60_000);
        if (options.choice === "timeout") throw new Error("Collector timed out");
        assert.ok(typeof reply !== "string");
        const rows = reply.components as ActionRowBuilder<ButtonBuilder>[];
        const data = rows[0].components[options.choice === "cancel" ? 1 : 0].toJSON();
        assert.ok("custom_id" in data);
        const button = {
          customId: data.custom_id, guildId, user: { id: "author" },
          member: { roles: options.buttonRoles ?? roles },
          async deferUpdate() { buttonDeferrals++; },
        } as unknown as ButtonInteraction;
        if (options.onConfirmation) return options.onConfirmation(button, collectorOptions);
        assert.equal(collectorOptions.filter(button), true);
        return button;
      } };
    },
  } as unknown as ChatInputCommandInteraction;
  return {
    interaction, replies, edits, deferrals,
    get confirmations() { return confirmations; },
    get buttonDeferrals() { return buttonDeferrals; },
    get content() { return edits.map((reply) => typeof reply === "string" ? reply : reply.content ?? "").join("\n"); },
  };
}

function online(count: number): ServerRefreshResult {
  return { status: "online", snapshot: { onlineCount: count, maxPlayers: 26, players: Array(count).fill("player"), map: "FFA_Duelyard", updatedAt: Date.now() }, event: null };
}

function setup(options: {
  commandName?: string;
  count?: number;
  refresh?: () => Promise<ServerRefreshResult>;
  statuses?: (string | Error)[];
  roleIds?: string[];
  configured?: boolean;
  restartError?: Error;
  rotationError?: Error;
  currentRotation?: readonly string[];
  currentRotations?: (readonly string[] | Error)[];
  onSetMapRotation?: (maps: readonly string[]) => Promise<void>;
} = {}) {
  const statuses = [...options.statuses ?? ["started", "started", "restarting", "started"]];
  const restarts: string[] = [];
  const rotations: string[][] = [];
  const operations: string[] = [];
  const currentRotations = [...options.currentRotations ?? []];
  let currentRotation = [...options.currentRotation ?? []];
  let rotationRequests = 0;
  let statusRequests = 0;
  let now = 1000;
  const command = new ServerRestartCommand({
    commandName: options.commandName ?? "union",
    roleIds: options.roleIds ?? ["manager"],
    nitrado: {
      configured: options.configured ?? true,
      async getStatus() {
        statusRequests++;
        const status = statuses.shift();
        assert.ok(status, "unexpected status request");
        if (status instanceof Error) throw status;
        return status;
      },
      async restart(message) {
        operations.push("restart");
        restarts.push(message);
        if (options.restartError) throw options.restartError;
      },
      async getMapRotation() {
        rotationRequests++;
        const next = currentRotations.shift();
        if (next instanceof Error) throw next;
        if (next) currentRotation = [...next];
        return [...currentRotation];
      },
      async setMapRotation(maps) {
        operations.push("save");
        rotations.push([...maps]);
        if (options.rotationError) throw options.rotationError;
        await options.onSetMapRotation?.(maps);
        currentRotation = [...maps];
      },
    },
    refresh: options.refresh ?? (async () => online(options.count ?? 0)),
    now: () => now,
    wait: async (ms) => { now += ms; },
  });
  return { command, restarts, rotations, operations, get statusRequests() { return statusRequests; }, get rotationRequests() { return rotationRequests; } };
}

function setupMap(options: Parameters<typeof setup>[0] = {}) {
  return setup({ statuses: ["started", "started", "started", "restarting", "started"], ...options });
}

test("an empty server can restart again immediately after a completed restart", async () => {
  const state = setup({ statuses: ["started", "started", "restarting", "started", "started", "started", "restarting", "started"] });
  for (let attempt = 1; attempt <= 2; attempt++) {
    const fake = fakeInteraction();
    assert.equal(await state.command.handle(fake.interaction), true);
    assert.deepEqual(fake.replies, []);
    assert.deepEqual(fake.deferrals, [MessageFlags.Ephemeral]);
    assert.equal(fake.confirmations, 0);
    assert.equal(state.restarts.length, attempt);
    assert.match(state.restarts[attempt - 1], /Discord user author; guild guild/);
    assert.equal(fake.edits.at(-1), "Сервер запущен");
  }
});

test("restart uses the configured command name in routing and Nitrado's audit message", async () => {
  const state = setup({ commandName: "elbrus" });
  const fake = fakeInteraction({ commandName: "elbrus" });
  assert.equal(await state.command.handle(fake.interaction), true);
  assert.deepEqual(state.restarts, ["UnionBot /elbrus restart; Discord user author; guild guild"]);
  assert.equal(fake.edits.at(-1), "Сервер запущен");
});

test("an occupied server never restarts until its author presses confirm", async () => {
  const state = setup({ count: 3 });
  const fake = fakeInteraction({ onConfirmation: async (button, options) => {
    assert.equal(state.restarts.length, 0);
    assert.equal(options.filter({ ...button, user: { id: "someone-else" } } as ButtonInteraction), false);
    assert.equal(options.filter({ ...button, guildId: "another-guild" } as ButtonInteraction), false);
    assert.equal(options.filter({ ...button, customId: "server-restart:stale:confirm" } as ButtonInteraction), false);
    assert.equal(options.filter(button), true);
    return button;
  } });
  await state.command.handle(fake.interaction);
  assert.match(fake.content, /Сейчас на сервере игроков: 3/);
  assert.equal(fake.confirmations, 1);
  assert.equal(fake.buttonDeferrals, 1);
  assert.equal(state.restarts.length, 1);
  assert.ok(fake.edits.some((edit) => typeof edit !== "string" && edit.components?.length === 0));
});

test("cancel and expired confirmations send no restart and release the pending lock", async () => {
  for (const choice of ["cancel", "timeout"] as const) {
    const state = setup({ count: 2, statuses: ["started", "started"] });
    for (let attempt = 0; attempt < 2; attempt++) {
      const fake = fakeInteraction({ choice });
      await state.command.handle(fake.interaction);
      assert.match(fake.content, /Перезапуск отменён/);
      assert.equal(fake.confirmations, 1);
      const last = fake.edits.at(-1) as InteractionEditReplyOptions;
      assert.deepEqual(last.components, []);
    }
    assert.deepEqual(state.restarts, []);
  }
});

test("unavailable, offline and thrown queries require confirmation instead of assuming zero players", async () => {
  for (const refresh of [
    async (): Promise<ServerRefreshResult> => ({ status: "unavailable", error: new Error("query failed") }),
    async (): Promise<ServerRefreshResult> => ({ status: "offline", error: new Error("query failed") }),
    async (): Promise<ServerRefreshResult> => { throw new Error("query failed"); },
  ]) {
    const state = setup({ refresh });
    const fake = fakeInteraction({ choice: "cancel" });
    await state.command.handle(fake.interaction);
    assert.match(fake.content, /Не удалось проверить онлайн/);
    assert.equal(fake.confirmations, 1);
    assert.deepEqual(state.restarts, []);
  }
});

test("a configured manager role authorizes restart and every set variant in cached and uncached guilds", async () => {
  for (const roles of [["manager"], { cache: new Collection([["manager", {}]]) }]) {
    for (const options of [
      { subcommand: "restart" },
      { group: "set", subcommand: "map", map: "FFA_Duelyard" },
      { group: "set", subcommand: "map", map: "TO_Falmire TO_DarkForest TO_Falmire" },
      { group: "set", subcommand: "lts" },
      { group: "set", subcommand: "duelyard" },
    ]) {
      const state = setupMap({ count: 1, roleIds: ["another", "manager"] });
      await state.command.handle(fakeInteraction({ roles, ...options }).interaction);
      assert.equal(state.restarts.length, 1);
      assert.equal(state.rotations.length, options.group === "set" ? 1 : 0);
    }
  }
});

test("missing roles, empty manager configuration, DMs and missing Nitrado settings make no API requests", async () => {
  for (const { state, fake } of [
    { state: setup(), fake: fakeInteraction({ roles: ["other"] }) },
    { state: setup(), fake: fakeInteraction({ roles: { cache: new Collection() } }) },
    { state: setup({ roleIds: [] }), fake: fakeInteraction() },
    { state: setup(), fake: fakeInteraction({ guildId: null }) },
    { state: setup({ configured: false }), fake: fakeInteraction() },
  ]) {
    if (fake.interaction.member) Object.assign(fake.interaction.member, { permissions: "8" });
    await state.command.handle(fake.interaction);
    assert.equal(fake.replies.length, 1);
    assert.equal(fake.replies[0].flags, MessageFlags.Ephemeral);
    assert.equal(state.statusRequests, 0);
    assert.equal(state.rotationRequests, 0);
    assert.deepEqual(state.operations, []);
    assert.deepEqual(state.restarts, []);
  }
});

test("a role revoked before confirmation prevents restart and every set variant", async () => {
  for (const options of [
    { subcommand: "restart" },
    { group: "set", subcommand: "map", map: "FFA_Duelyard" },
    { group: "set", subcommand: "map", map: "TO_Falmire TO_DarkForest TO_Falmire" },
    { group: "set", subcommand: "lts" },
    { group: "set", subcommand: "duelyard" },
  ]) {
    const state = setupMap({ count: 1 });
    const fake = fakeInteraction({ ...options, buttonRoles: ["other"] });
    await state.command.handle(fake.interaction);
    assert.match(fake.content, /больше нет роли/);
    assert.deepEqual(state.operations, []);
  }
});

test("simultaneous restart commands share one lock across guilds", async () => {
  const state = setup({ count: 1 });
  const fake = fakeInteraction({ onConfirmation: async (button) => {
    const other = fakeInteraction({ guildId: "other-guild" });
    await state.command.handle(other.interaction);
    assert.match(other.replies[0].content, /ожидает подтверждения/);
    assert.equal(state.statusRequests, 1);
    return button;
  } });
  await state.command.handle(fake.interaction);
  assert.equal(state.restarts.length, 1);
});

test("a restart already in progress, including one begun during confirmation, is never duplicated", async () => {
  for (const statuses of [["restarting"], ["started", "restarting"]]) {
    const state = setup({ count: 1, statuses });
    const fake = fakeInteraction();
    await state.command.handle(fake.interaction);
    assert.match(fake.content, /уже перезапускается/);
    assert.deepEqual(state.restarts, []);
  }
});

test("a successful API response without a state transition does not falsely confirm completion", async () => {
  const state = setup({ statuses: Array(62).fill("started") });
  const fake = fakeInteraction();
  await state.command.handle(fake.interaction);
  assert.equal(state.restarts.length, 1);
  assert.doesNotMatch(fake.content, /Сервер запущен/);
  assert.equal(fake.edits.at(-1), "Перезапуск начат...");
});

test("ambiguous POST failures are not retried automatically and allow an immediate manual retry", async (context) => {
  context.mock.method(console, "error", () => {});
  const state = setup({ statuses: ["started", "started", "started", "started"], restartError: new Error("Nitrado timeout") });
  const fake = fakeInteraction();
  await state.command.handle(fake.interaction);
  assert.match(fake.content, /Проверьте панель Nitrado/);
  assert.equal(state.restarts.length, 1);
  const retry = fakeInteraction();
  await state.command.handle(retry.interaction);
  assert.deepEqual(retry.replies, []);
  assert.deepEqual(retry.deferrals, [MessageFlags.Ephemeral]);
  assert.equal(state.restarts.length, 2);
  assert.equal(state.statusRequests, 4);
});

test("status polling failures preserve the accepted restart and do not repeat POST", async (context) => {
  context.mock.method(console, "error", () => {});
  const state = setup({ statuses: ["started", "started", new Error("API unavailable")] });
  const fake = fakeInteraction();
  await state.command.handle(fake.interaction);
  assert.match(fake.content, /Перезапуск\.\.\./);
  assert.match(fake.content, /Не удалось подтвердить завершение/);
  assert.equal(state.restarts.length, 1);
});

test("Discord reply failures after POST cannot retry restart or leave the lock held", async (context) => {
  context.mock.method(console, "error", () => {});
  const state = setup({ statuses: ["started", "started", "started", "started", "restarting", "started"] });
  const fake = fakeInteraction();
  const originalEdit = fake.interaction.editReply.bind(fake.interaction);
  context.mock.method(fake.interaction, "editReply", async (...args: Parameters<typeof originalEdit>) => {
    if (state.restarts.length) throw new Error("Discord unavailable");
    return originalEdit(...args);
  });
  await state.command.handle(fake.interaction);
  assert.equal(state.restarts.length, 1);
  const retry = fakeInteraction();
  await state.command.handle(retry.interaction);
  assert.deepEqual(retry.replies, []);
  assert.equal(state.restarts.length, 2);
  assert.equal(retry.edits.at(-1), "Сервер запущен");
});

test("other slash commands and server subcommands remain with their existing handlers", async () => {
  const state = setup();
  for (const options of [
    { commandName: "other", subcommand: "restart" },
    { commandName: "server", subcommand: "restart" },
    { commandName: "event", subcommand: "restart" },
    { subcommand: "open" }, { subcommand: "close" },
    { group: "show", subcommand: "maps" },
    { subcommand: "map" }, { subcommand: "lts" }, { subcommand: "duelyard" }, { subcommand: "set" },
    { group: "show", subcommand: "lts" },
    { group: "show", subcommand: "duelyard" },
  ]) {
    const fake = fakeInteraction(options);
    assert.equal(await state.command.handle(fake.interaction), false);
    assert.deepEqual(fake.replies, []);
  }
  assert.equal(state.statusRequests, 0);
});

test("set uses a full map name, waits for saving, then restarts with the configured audit command", async () => {
  const state = setupMap({ commandName: "elbrus", onSetMapRotation: async (maps) => {
    assert.deepEqual(maps, ["FFA_Duelyard"]);
    assert.deepEqual(state.restarts, []);
    await Promise.resolve();
    assert.deepEqual(state.restarts, []);
  } });
  const fake = fakeInteraction({ commandName: "elbrus", group: "set", subcommand: "map", map: " FFA_Duelyard " });
  assert.equal(await state.command.handle(fake.interaction), true);
  assert.deepEqual(state.rotations, [["FFA_Duelyard"]]);
  assert.deepEqual(state.operations, ["save", "restart"]);
  assert.deepEqual(state.restarts, ["UnionBot /elbrus set map FFA_Duelyard; Discord user author; guild guild"]);
  assert.deepEqual(fake.deferrals, [MessageFlags.Ephemeral]);
  assert.equal(fake.confirmations, 0);
  assert.equal(fake.edits.at(-1), "Карта FFA_Duelyard сохранена. Сервер запущен");
});

test("set preserves full map names and game mode prefixes", async () => {
  for (const map of ["FFA_Duelyard", "TO_Coxwell", "TDM_Wardenglade_horse", "LTS_Falmire", "PR_LTS_Raid", "Brawl_GreatHall", "BRAWL_Midsommar", "BOW_Wardenglade"]) {
    const state = setupMap();
    await state.command.handle(fakeInteraction({ group: "set", subcommand: "map", map }).interaction);
    assert.deepEqual(state.rotations, [[map]]);
    assert.deepEqual(state.operations, ["save", "restart"]);
  }
});

test("set rejects an entire rotation with short names, unknown maps or wrong casing before any API request", async () => {
  for (const map of ["Duelyard", "Coxwell", "FFA_UnknownMap", "ffa_duelyard", "Brawl_Midsommar", "", "   ", "TO_Falmire unknown TO_Falmire", "TO_Coxwell to_lionspire", "TO_Coxwell,TO_Lionspire", "LTS", "lts", "LTS TO_Coxwell", "TO_Coxwell LTS", "FFA", "two maps", "../map", "@everyone", "_map", "FFA_", "a".repeat(MAX_MAP_ROTATION_LENGTH + 1), Array(100).fill("TO_Falmire").join(" ")]) {
    const state = setupMap();
    const fake = fakeInteraction({ group: "set", subcommand: "map", map });
    await state.command.handle(fake.interaction);
    assert.match(fake.replies[0].content, /Укажите полные названия карт из списка через пробел/);
    assert.equal(fake.replies[0].flags, MessageFlags.Ephemeral);
    assert.equal(state.statusRequests, 0);
    assert.deepEqual(state.operations, []);
  }
});

test("every set variant needs the same roles, guild and Nitrado configuration as restart", async () => {
  for (const options of [
    { group: "set", subcommand: "map", map: "FFA_Duelyard" },
    { group: "set", subcommand: "map", map: "TO_Falmire TO_DarkForest TO_Falmire" },
    { group: "set", subcommand: "lts" },
    { group: "set", subcommand: "duelyard" },
  ]) {
    for (const { state, fake } of [
      { state: setupMap(), fake: fakeInteraction({ ...options, roles: ["other"] }) },
      { state: setupMap(), fake: fakeInteraction({ ...options, roles: { cache: new Collection() } }) },
      { state: setupMap({ roleIds: [] }), fake: fakeInteraction(options) },
      { state: setupMap(), fake: fakeInteraction({ ...options, guildId: null }) },
      { state: setupMap({ configured: false }), fake: fakeInteraction(options) },
    ]) {
      if (fake.interaction.member) Object.assign(fake.interaction.member, { permissions: "8" });
      await state.command.handle(fake.interaction);
      assert.equal(fake.replies.length, 1);
      assert.equal(fake.replies[0].flags, MessageFlags.Ephemeral);
      assert.deepEqual(fake.deferrals, []);
      assert.equal(state.statusRequests, 0);
      assert.equal(state.rotationRequests, 0);
      assert.deepEqual(state.operations, []);
    }
  }
});

test("set confirms the chosen map before saving when players are online", async () => {
  const state = setupMap({ count: 2 });
  const fake = fakeInteraction({ group: "set", subcommand: "map", onConfirmation: async (button) => {
    assert.deepEqual(state.operations, []);
    return button;
  } });
  await state.command.handle(fake.interaction);
  assert.match(fake.content, /поставить карту FFA_Duelyard и перезапустить сервер/);
  assert.equal(fake.confirmations, 1);
  assert.deepEqual(state.operations, ["save", "restart"]);
});

test("cancel, expiry, unknown online and revoked roles never save a map or restart", async () => {
  for (const options of [
    { choice: "cancel" as const },
    { choice: "timeout" as const },
    { buttonRoles: ["other"] },
  ]) {
    const state = setupMap({ count: 2 });
    await state.command.handle(fakeInteraction({ group: "set", subcommand: "map", ...options }).interaction);
    assert.deepEqual(state.operations, []);
  }
  const state = setupMap({ refresh: async () => ({ status: "unavailable", error: new Error("query failed") }) });
  const fake = fakeInteraction({ group: "set", subcommand: "map", choice: "cancel" });
  await state.command.handle(fake.interaction);
  assert.match(fake.content, /Не удалось проверить онлайн/);
  assert.deepEqual(state.operations, []);
});

test("restart and set share the same lock during confirmation and saving across guilds", async () => {
  const routes = [
    { subcommand: "restart" },
    { group: "set", subcommand: "map" },
    { group: "set", subcommand: "lts" },
    { group: "set", subcommand: "duelyard" },
  ];
  for (const route of routes) {
    const state = setupMap({ count: 1, onSetMapRotation: async () => {
      for (const otherRoute of routes) {
        const other = fakeInteraction({ ...otherRoute, guildId: "other-guild" });
        await state.command.handle(other.interaction);
        assert.match(other.replies[0].content, /ожидает подтверждения/);
      }
    } });
    const fake = fakeInteraction({ ...route, onConfirmation: async (button) => {
      for (const otherRoute of routes) {
        const other = fakeInteraction({ ...otherRoute, guildId: "other-guild" });
        await state.command.handle(other.interaction);
        assert.match(other.replies[0].content, /ожидает подтверждения/);
      }
      return button;
    } });
    await state.command.handle(fake.interaction);
    assert.equal(state.restarts.length, 1);
    assert.equal(state.rotations.length, route.group === "set" ? 1 : 0);
  }
});

test("failed map saves send no restart, explain the uncertainty and release the lock", async (context) => {
  context.mock.method(console, "error", () => {});
  const state = setupMap({ statuses: Array(4).fill("started"), rotationError: new Error("Save not confirmed") });
  for (let attempt = 1; attempt <= 2; attempt++) {
    const fake = fakeInteraction({ group: "set", subcommand: "map" });
    await state.command.handle(fake.interaction);
    assert.equal(state.rotations.length, attempt);
    assert.deepEqual(state.restarts, []);
    assert.match(fake.content, /Запрос на перезапуск не отправлен/);
    assert.match(fake.content, /ротация могла сохраниться/);
    assert.deepEqual(fake.replies, []);
  }
});

test("external operations before and after saving prevent a map change or duplicate restart", async () => {
  for (const [statuses, maps] of [
    [["restarting"], []],
    [["started", "restarting"], []],
    [["started", "started", "restarting"], [["FFA_Duelyard"]]],
  ] as const) {
    const state = setupMap({ statuses: [...statuses] });
    const fake = fakeInteraction({ group: "set", subcommand: "map" });
    await state.command.handle(fake.interaction);
    assert.deepEqual(state.rotations, maps);
    assert.deepEqual(state.restarts, []);
    if (maps.length) assert.match(fake.content, /Карта FFA_Duelyard сохранена/);
  }
});

test("restart failures after saving report the saved map and do not repeat either POST", async (context) => {
  context.mock.method(console, "error", () => {});
  const state = setupMap({ restartError: new Error("Nitrado timeout") });
  const fake = fakeInteraction({ group: "set", subcommand: "map" });
  await state.command.handle(fake.interaction);
  assert.match(fake.content, /Карта FFA_Duelyard сохранена/);
  assert.match(fake.content, /Не удалось подтвердить завершение перезапуска/);
  assert.deepEqual(state.operations, ["save", "restart"]);
});

test("set saves space-separated maps once in their original order, including repeated maps", async () => {
  for (const { input, expected } of [
    { input: "TO_Coxwell TO_Lionspire TO_RudhelmSiege", expected: ["TO_Coxwell", "TO_Lionspire", "TO_RudhelmSiege"] },
    { input: "  TO_Falmire   TO_DarkForest TO_Falmire  ", expected: ["TO_Falmire", "TO_DarkForest", "TO_Falmire"] },
  ]) {
    const state = setupMap({ onSetMapRotation: async (maps) => {
      assert.deepEqual(maps, expected);
      assert.deepEqual(state.restarts, []);
    } });
    const fake = fakeInteraction({ group: "set", subcommand: "map", map: input });
    await state.command.handle(fake.interaction);
    assert.deepEqual(state.rotations, [expected]);
    assert.deepEqual(state.operations, ["save", "restart"]);
    assert.deepEqual(state.restarts, [`UnionBot /union set map ${expected.join(" ")}; Discord user author; guild guild`]);
    assert.equal(fake.edits.at(-1), `Ротация сохранена: ${expected.join(" → ")}. Сервер запущен`);
  }
});

test("set accepts the full 44-map rotation and shows it without exceeding Discord message limits", async () => {
  const input = SERVER_MAPS.join(" ");
  assert.ok(input.length > 100 && input.length <= MAX_MAP_ROTATION_LENGTH);
  const state = setupMap({ count: 1 });
  const fake = fakeInteraction({ group: "set", subcommand: "map", map: input });
  await state.command.handle(fake.interaction);
  assert.deepEqual(state.rotations, [SERVER_MAPS]);
  assert.deepEqual(state.operations, ["save", "restart"]);
  for (const edit of fake.edits) {
    assert.ok((typeof edit === "string" ? edit : edit.content ?? "").length <= 2000);
  }
});

test("multi-map confirmation previews the full order and cancellation or expiry saves nothing", async () => {
  const maps = ["TO_Falmire", "TO_DarkForest", "TO_Falmire"];
  for (const choice of ["confirm", "cancel", "timeout"] as const) {
    const state = setupMap({ count: 2 });
    const fake = fakeInteraction({ group: "set", subcommand: "map", map: maps.join(" "), choice, onConfirmation: async (button) => {
      assert.deepEqual(state.operations, []);
      assert.match(fake.content, /сохранить ротацию TO_Falmire → TO_DarkForest → TO_Falmire и перезапустить сервер/);
      return button;
    } });
    await state.command.handle(fake.interaction);
    assert.equal(fake.confirmations, 1);
    assert.deepEqual(state.operations, choice === "confirm" ? ["save", "restart"] : []);
    assert.deepEqual(state.rotations, choice === "confirm" ? [maps] : []);
  }
});

test("multi-map save and restart failures preserve the order and never repeat mutations", async (context) => {
  context.mock.method(console, "error", () => {});
  const maps = ["TO_Falmire", "TO_DarkForest", "TO_Falmire"];
  for (const stage of ["save", "restart"] as const) {
    const state = setupMap(stage === "save" ? { rotationError: new Error("Save not confirmed") } : { restartError: new Error("Nitrado timeout") });
    const fake = fakeInteraction({ group: "set", subcommand: "map", map: maps.join(" ") });
    await state.command.handle(fake.interaction);
    assert.deepEqual(state.rotations, [maps]);
    assert.deepEqual(state.operations, stage === "save" ? ["save"] : ["save", "restart"]);
    assert.match(fake.content, stage === "save" ? /Запрос на перезапуск не отправлен/ : /Ротация сохранена: TO_Falmire → TO_DarkForest → TO_Falmire/);
  }
});

const ltsRotation = [
  "LTS_Wardenglade", "LTS_TournamentGrounds", "LTS_FightingPit",
  "LTS_Courtyard", "LTS_Galencourt", "LTS_Falmire",
];

test("set lts is a standalone command that saves every LTS map and restarts without string arguments", async () => {
  for (const commandName of ["union", "elbrus"]) {
    const state = setupMap({ commandName });
    const fake = fakeInteraction({ commandName, group: "set", subcommand: "lts" });
    assert.equal(await state.command.handle(fake.interaction), true);
    assert.deepEqual(state.rotations, [ltsRotation]);
    assert.deepEqual(state.operations, ["save", "restart"]);
    assert.deepEqual(state.restarts, [`UnionBot /${commandName} set lts; Discord user author; guild guild`]);
    assert.equal(fake.edits.at(-1), `Ротация сохранена: ${ltsRotation.join(" → ")}. Сервер запущен`);
  }
});

test("set duelyard replaces every existing entry with exactly one FFA_Duelyard without arguments", async () => {
  for (const commandName of ["union", "elbrus"]) {
    for (const currentRotation of [
      ["TO_Coxwell", "FFA_Duelyard", "TO_DarkForest"],
      ["FFA_Duelyard", "FFA_Duelyard"],
    ]) {
      const state = setupMap({ commandName, currentRotation });
      const fake = fakeInteraction({ commandName, group: "set", subcommand: "duelyard" });
      assert.equal(await state.command.handle(fake.interaction), true);
      assert.deepEqual(state.rotations, [["FFA_Duelyard"]]);
      assert.deepEqual(state.operations, ["save", "restart"]);
      assert.deepEqual(state.restarts, [`UnionBot /${commandName} set duelyard; Discord user author; guild guild`]);
      assert.equal(fake.edits.at(-1), "Карта FFA_Duelyard сохранена. Сервер запущен");
    }
  }
});

test("preset confirmations show the selected maps and respect cancellation and expiry", async () => {
  for (const { subcommand, maps } of [
    { subcommand: "lts", maps: ltsRotation },
    { subcommand: "duelyard", maps: ["FFA_Duelyard"] },
  ]) {
    for (const choice of ["confirm", "cancel", "timeout"] as const) {
      const state = setupMap({ count: 2 });
      const fake = fakeInteraction({ group: "set", subcommand, choice, onConfirmation: async (button) => {
        assert.deepEqual(state.operations, []);
        assert.ok(fake.content.includes(maps.join(" → ")));
        return button;
      } });
      await state.command.handle(fake.interaction);
      assert.equal(fake.confirmations, 1);
      assert.deepEqual(state.rotations, choice === "confirm" ? [maps] : []);
      assert.deepEqual(state.operations, choice === "confirm" ? ["save", "restart"] : []);
    }
  }
});

test("identical single maps, repeated rotations and set lts are refused before player confirmation", async () => {
  for (const { options, current } of [
    { options: { group: "set", subcommand: "map", map: "FFA_Duelyard" }, current: ["FFA_Duelyard"] },
    { options: { group: "set", subcommand: "map", map: "  TO_Falmire   TO_DarkForest TO_Falmire  " }, current: ["TO_Falmire", "TO_DarkForest", "TO_Falmire"] },
    { options: { group: "set", subcommand: "lts" }, current: ltsRotation },
    { options: { group: "set", subcommand: "duelyard" }, current: ["FFA_Duelyard"] },
  ]) {
    let refreshes = 0;
    const state = setupMap({ currentRotation: current, refresh: async () => { refreshes++; return online(3); } });
    const fake = fakeInteraction(options);
    assert.equal(await state.command.handle(fake.interaction), true);
    assert.match(fake.content, /уже установлена/);
    assert.match(fake.content, /Сохранение и перезапуск не выполняются/);
    assert.deepEqual(state.operations, []);
    assert.equal(state.rotationRequests, 1);
    assert.equal(refreshes, 0);
    assert.equal(fake.confirmations, 0);
    assert.deepEqual(fake.deferrals, [MessageFlags.Ephemeral]);
  }
});

test("changes to map order, repetition counts or rotation length still save and restart", async () => {
  for (const { current, requested } of [
    { current: ["TO_Falmire", "TO_DarkForest", "TO_Falmire"], requested: ["TO_DarkForest", "TO_Falmire", "TO_Falmire"] },
    { current: ["TO_Falmire", "TO_DarkForest", "TO_Falmire"], requested: ["TO_Falmire", "TO_DarkForest"] },
    { current: ["FFA_Duelyard", "FFA_Duelyard"], requested: ["FFA_Duelyard"] },
    { current: ["FFA_Duelyard", "TO_Falmire"], requested: ["FFA_Duelyard"] },
  ]) {
    const state = setupMap({ currentRotation: current });
    const fake = fakeInteraction({ group: "set", subcommand: "map", map: requested.join(" ") });
    await state.command.handle(fake.interaction);
    assert.deepEqual(state.rotations, [requested]);
    assert.deepEqual(state.operations, ["save", "restart"]);
    assert.equal(state.rotationRequests, 2);
  }
});

test("a rotation applied from the hosting panel during confirmation is refused without either mutation", async () => {
  const maps = ["TO_Falmire", "TO_DarkForest", "TO_Falmire"];
  const state = setupMap({ count: 2, currentRotations: [["FFA_Duelyard"], maps] });
  const fake = fakeInteraction({ group: "set", subcommand: "map", map: maps.join(" "), onConfirmation: async (button) => {
    assert.equal(state.rotationRequests, 1);
    assert.deepEqual(state.operations, []);
    return button;
  } });
  await state.command.handle(fake.interaction);
  assert.equal(fake.confirmations, 1);
  assert.equal(state.rotationRequests, 2);
  assert.deepEqual(state.operations, []);
  assert.match(fake.content, /Такая ротация уже установлена/);
  assert.deepEqual((fake.edits.at(-1) as InteractionEditReplyOptions).components, []);
});

test("a failed initial or final rotation read prevents saving and restarting", async (context) => {
  context.mock.method(console, "error", () => {});
  for (const currentRotations of [
    [new Error("Settings unavailable")],
    [["TO_Falmire"], new Error("Settings unavailable")],
  ]) {
    const state = setupMap({ count: 2, currentRotations });
    const fake = fakeInteraction({ group: "set", subcommand: "map" });
    await state.command.handle(fake.interaction);
    assert.deepEqual(state.operations, []);
    assert.match(fake.content, /Сохранение и перезапуск не выполнялись/);
    assert.deepEqual((fake.edits.at(-1) as InteractionEditReplyOptions).components, []);
  }
});

test("refusing an unchanged rotation releases the shared command lock", async () => {
  const state = setupMap({ currentRotation: ["FFA_Duelyard"] });
  for (let attempt = 0; attempt < 2; attempt++) {
    const fake = fakeInteraction({ group: "set", subcommand: "map" });
    await state.command.handle(fake.interaction);
    assert.match(fake.content, /уже установлена/);
    assert.deepEqual(fake.replies, []);
  }
  assert.equal(state.rotationRequests, 2);
  assert.deepEqual(state.operations, []);
});

test("repeating a successful set reads the persisted rotation and does not save or restart again", async () => {
  const state = setupMap({ statuses: ["started", "started", "started", "restarting", "started", "started"] });
  const first = fakeInteraction({ group: "set", subcommand: "map" });
  await state.command.handle(first.interaction);
  assert.equal(first.edits.at(-1), "Карта FFA_Duelyard сохранена. Сервер запущен");
  const repeat = fakeInteraction({ group: "set", subcommand: "map" });
  await state.command.handle(repeat.interaction);
  assert.match(repeat.content, /Карта FFA_Duelyard уже установлена/);
  assert.deepEqual(state.operations, ["save", "restart"]);
  assert.equal(state.rotationRequests, 3);
});

test("restart remains available even if rotation settings cannot be read", async () => {
  const state = setup({ currentRotations: [new Error("Settings unavailable")] });
  const fake = fakeInteraction();
  await state.command.handle(fake.interaction);
  assert.equal(state.rotationRequests, 0);
  assert.deepEqual(state.operations, ["restart"]);
  assert.equal(fake.edits.at(-1), "Сервер запущен");
});

test("automatic LTS waits behind a manual command's confirmation without changing maps", async () => {
  const state = setup({ count: 2 });
  const fake = fakeInteraction({ choice: "cancel", onConfirmation: async (button) => {
    const result = await state.command.setPresetAutomatically("lts", {
      shouldApply: () => true,
      beforeMutation: async () => { assert.fail("automatic mutation while a manual command is pending"); },
    });
    assert.equal(result, "deferred");
    assert.deepEqual(state.operations, []);
    return button;
  } });
  await state.command.handle(fake.interaction);
  assert.deepEqual(state.operations, []);
});

test("manual commands wait behind automatic saving and the lock releases afterwards", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const saving = new Promise<void>((resolve) => { entered = resolve; });
  const state = setupMap({ onSetMapRotation: async () => { entered(); await gate; } });
  const automatic = state.command.setPresetAutomatically("lts", { shouldApply: () => true, beforeMutation: async () => {} });
  await saving;
  const fake = fakeInteraction();
  await state.command.handle(fake.interaction);
  assert.match(fake.replies[0].content, /Перезапуск уже запрошен/);
  release();
  assert.equal(await automatic, "applied");
  assert.equal(state.restarts.length, 1);
  assert.equal(await state.command.setPresetAutomatically("lts", { shouldApply: () => true, beforeMutation: async () => {} }), "deferred");
  assert.equal(state.statusRequests, 4, "the next request sees Nitrado restarting after the lock releases");
});

test("automatic presets recheck the time guard before saving after slow API calls", async () => {
  let checks = 0;
  const state = setupMap();
  const result = await state.command.setPresetAutomatically("lts", {
    shouldApply: () => ++checks === 1,
    beforeMutation: async () => { assert.fail("expired window must not be persisted as attempted"); },
  });
  assert.equal(result, "deferred");
  assert.deepEqual(state.operations, []);
});
