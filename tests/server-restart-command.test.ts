import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  ActionRowBuilder, ButtonBuilder, Collection, MessageFlags,
  type ButtonInteraction, type ChatInputCommandInteraction, type InteractionEditReplyOptions,
} from "discord.js";
import { ServerRestartCommand } from "../src/server-restart-command";
import type { ServerRefreshResult } from "../src/server-monitor";

type Roles = string[] | { cache: Collection<string, unknown> };
type ConfirmationOptions = { filter: (button: ButtonInteraction) => boolean; time: number };

function fakeInteraction(options: {
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
    commandName: "server", guildId, member: guildId ? { roles } : null,
    user: { id: "author" }, deferred: false, replied: false,
    options: { getSubcommand: () => "restart" },
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
  count?: number;
  refresh?: () => Promise<ServerRefreshResult>;
  statuses?: (string | Error)[];
  roleIds?: string[];
  configured?: boolean;
  restartError?: Error;
} = {}) {
  const statuses = [...options.statuses ?? ["started", "started", "restarting", "started"]];
  const restarts: string[] = [];
  let statusRequests = 0;
  let now = 1000;
  const command = new ServerRestartCommand({
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
        restarts.push(message);
        if (options.restartError) throw options.restartError;
      },
    },
    refresh: options.refresh ?? (async () => online(options.count ?? 0)),
    now: () => now,
    wait: async (ms) => { now += ms; },
  });
  return { command, restarts, get statusRequests() { return statusRequests; }, advance: (ms: number) => { now += ms; } };
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

test("existing manager roles authorize restart in cached and uncached guilds", async () => {
  for (const roles of [["manager"], { cache: new Collection([["manager", {}]]) }]) {
    const state = setup({ count: 1 });
    await state.command.handle(fakeInteraction({ roles }).interaction);
    assert.equal(state.restarts.length, 1);
  }
});

test("missing roles, empty manager configuration, DMs and missing Nitrado settings make no API requests", async () => {
  for (const { state, fake } of [
    { state: setup(), fake: fakeInteraction({ roles: ["other"] }) },
    { state: setup({ roleIds: [] }), fake: fakeInteraction() },
    { state: setup(), fake: fakeInteraction({ guildId: null }) },
    { state: setup({ configured: false }), fake: fakeInteraction() },
  ]) {
    await state.command.handle(fake.interaction);
    assert.equal(fake.replies.length, 1);
    assert.equal(fake.replies[0].flags, MessageFlags.Ephemeral);
    assert.equal(state.statusRequests, 0);
    assert.deepEqual(state.restarts, []);
  }
});

test("a role revoked before confirmation prevents restart", async () => {
  const state = setup({ count: 1 });
  const fake = fakeInteraction({ buttonRoles: ["other"] });
  await state.command.handle(fake.interaction);
  assert.match(fake.content, /больше нет роли/);
  assert.deepEqual(state.restarts, []);
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
  assert.match(fake.content, /Nitrado принял запрос/);
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
  for (const [commandName, subcommand] of [["other", "restart"], ["server", "open"], ["server", "close"]]) {
    const fake = fakeInteraction();
    Object.defineProperty(fake.interaction, "commandName", { value: commandName });
    Object.defineProperty(fake.interaction.options, "getSubcommand", { value: () => subcommand });
    assert.equal(await state.command.handle(fake.interaction), false);
    assert.deepEqual(fake.replies, []);
  }
  assert.equal(state.statusRequests, 0);
});
