import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, MessageFlags,
  type ButtonInteraction, type ChatInputCommandInteraction,
} from "discord.js";
import type { ServerRefreshResult } from "./server-monitor";
import type { NitradoClient } from "./nitrado-client";
import { getPresetMaps, isSameMapRotation, MAX_MAP_ROTATION_LENGTH, SERVER_MAPS, type MapPreset } from "./server-maps";

export type AutomaticPresetResult = "applied" | "unchanged" | "deferred";

export interface AutomaticPresetOptions {
  beforeMutation: () => Promise<void>;
  shouldApply: () => boolean;
  restartIfUnchanged?: boolean;
  afterSave?: () => Promise<void>;
  beforeRestart?: () => Promise<void>;
}

interface RestartOptions {
  commandName: string;
  roleIds: string[];
  nitrado: Pick<NitradoClient, "configured" | "getStatus" | "getMapRotation" | "restart" | "setMapRotation">;
  refresh: () => Promise<ServerRefreshResult>;
  now?: () => number;
  wait?: (ms: number) => Promise<unknown>;
}

const CONFIRMATION_TIMEOUT_MS = 60_000;
const STATUS_INTERVAL_MS = 5_000;
const STATUS_ATTEMPTS = 60;

function formatSavedRotation(maps: readonly string[]) {
  return maps.length === 1 ? `Карта ${maps[0]} сохранена` : `Ротация сохранена: ${maps.join(" → ")}`;
}

export class ServerRestartCommand {
  private busy = false;

  constructor(private readonly options: RestartOptions) {}

  async handle(interaction: ChatInputCommandInteraction): Promise<boolean> {
    if (interaction.commandName !== this.options.commandName) return false;
    const group = interaction.options.getSubcommandGroup(false);
    const subcommand = interaction.options.getSubcommand();
    const isRestart = !group && subcommand === "restart";
    const isSetMap = group === "set" && subcommand === "map";
    const isSetPreset = group === "set" && (subcommand === "lts" || subcommand === "duelyard");
    if (!isRestart && !isSetMap && !isSetPreset) return false;
    let refusal: string | undefined;
    if (!interaction.guildId || !interaction.member) {
      refusal = "Эта команда доступна только на Discord-сервере";
    } else if (this.options.roleIds.length === 0) {
      refusal = "Управление сервером не настроено: укажите EVENT_MANAGER_ROLE_IDS в .env";
    } else if (!this.allowed(interaction)) {
      refusal = "У вас нет роли для перезапуска сервера";
    } else if (!this.options.nitrado.configured) {
      refusal = "Перезапуск не настроен: укажите NITRADO_API_TOKEN и NITRADO_SERVICE_ID в .env";
    } else if (this.busy) {
      refusal = "Перезапуск уже запрошен или ожидает подтверждения. Дождитесь завершения";
    }
    if (refusal) {
      await interaction.reply({ content: refusal, flags: MessageFlags.Ephemeral });
      return true;
    }

    let maps: string[] | undefined;
    if (isSetPreset) {
      maps = getPresetMaps(subcommand as MapPreset);
    } else if (isSetMap) {
      const input = interaction.options.getString("maps", true).trim();
      const names = input.split(/\s+/);
      if (input.length > MAX_MAP_ROTATION_LENGTH || names.some((name) => !SERVER_MAPS.includes(name))) {
        await interaction.reply({
          content: `Укажите полные названия карт из списка через пробел, например TO_Coxwell TO_Lionspire TO_RudhelmSiege. Максимум ${MAX_MAP_ROTATION_LENGTH} символов. Полный список: /${this.options.commandName} show maps. Все карты LTS: /${this.options.commandName} set lts`,
          flags: MessageFlags.Ephemeral,
        });
        return true;
      }
      maps = names;
    }

    // One game server is shared by every configured Discord channel and guild.
    this.busy = true;
    let restartRequested = false;
    let rotationSaveRequested = false;
    let rotationSaved = false;
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const initialStatus = await this.options.nitrado.getStatus();
      if (initialStatus !== "started" && initialStatus !== "stopped") {
        await interaction.editReply("Сервер уже перезапускается или занят другой операцией Nitrado. Проверьте панель хостинга");
        return true;
      }
      if (maps && await this.rejectUnchangedRotation(interaction, maps)) return true;

      let onlineCount: number | undefined;
      try {
        const result = await this.options.refresh();
        if (result.status === "online") onlineCount = result.snapshot.onlineCount;
      } catch {
        // Missing or inconsistent query data must never be treated as an empty server.
      }
      if (onlineCount !== 0 && !await this.confirm(interaction, onlineCount, maps)) return true;

      // The service may have been restarted from the hosting panel while the prompt was open.
      let status = await this.options.nitrado.getStatus();
      if (status !== "started" && status !== "stopped") {
        await interaction.editReply({ content: "Сервер уже перезапускается или занят другой операцией Nitrado. Повторный запрос не отправлен", components: [] });
        return true;
      }
      if (maps) {
        // The hosting panel may have applied this rotation while confirmation was open.
        if (await this.rejectUnchangedRotation(interaction, maps)) return true;
        await interaction.editReply({ content: `Сохраняю ротацию: ${maps.join(" → ")}…`, components: [] });
        rotationSaveRequested = true;
        await this.options.nitrado.setMapRotation(maps);
        rotationSaved = true;
        status = await this.options.nitrado.getStatus();
        if (status !== "started" && status !== "stopped") {
          await interaction.editReply(`${formatSavedRotation(maps)}. Сервер уже занят другой операцией Nitrado. Запрос на перезапуск не отправлен; проверьте панель хостинга`);
          return true;
        }
      }
      await interaction.editReply({ content: "Отправляю запрос на перезапуск сервера…", components: [] });
      // Do not retry a POST, even on timeout: Nitrado may already have accepted it.
      restartRequested = true;
      const command = isRestart ? "restart" : isSetMap ? `set map ${maps!.join(" ")}` : `set ${subcommand}`;
      await this.options.nitrado.restart(`UnionBot /${this.options.commandName} ${command}; Discord user ${interaction.user.id}; guild ${interaction.guildId}`);
      await interaction.editReply("Перезапуск...");
      await this.waitForStartup(interaction, status === "stopped", maps);
    } catch (error) {
      console.error("Ошибка команды перезапуска сервера:", error);
      const detail = error instanceof Error ? error.message : "Неизвестная ошибка";
      let content = restartRequested
        ? `Не удалось подтвердить завершение перезапуска. ${detail}. Проверьте панель Nitrado перед повторной командой; повторный запрос автоматически не отправлялся`
        : `Не удалось подготовить перезапуск. ${detail}`;
      if (rotationSaved && maps) {
        content = `${formatSavedRotation(maps)}. ${content}${restartRequested ? "" : ". Запрос на перезапуск не отправлен"}`;
      } else if (rotationSaveRequested) {
        content = `Не удалось подтвердить сохранение ротации карт. ${detail}. Запрос на перезапуск не отправлен. Проверьте панель Nitrado: ротация могла сохраниться`;
      } else if (maps) {
        content = `Не удалось подготовить смену ротации. ${detail}. Сохранение и перезапуск не выполнялись`;
      }
      // A failed Discord reply must not replay the restart or leave the process locked.
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content, components: [] }).catch((replyError) => {
          console.error("Не удалось завершить ответ команды перезапуска:", replyError);
        });
      }
    } finally {
      this.busy = false;
    }
    return true;
  }

  async setPresetAutomatically(preset: MapPreset, options: AutomaticPresetOptions): Promise<AutomaticPresetResult> {
    if (this.busy || !this.options.nitrado.configured || !options.shouldApply()) return "deferred";
    this.busy = true;
    try {
      const maps = getPresetMaps(preset);
      const initialStatus = await this.options.nitrado.getStatus();
      if (initialStatus !== "started" && initialStatus !== "stopped") return "deferred";
      const unchanged = isSameMapRotation(await this.options.nitrado.getMapRotation(), maps);
      if (unchanged && !options.restartIfUnchanged) return "unchanged";

      const status = await this.options.nitrado.getStatus();
      if (status !== "started" && status !== "stopped") return "deferred";
      if (preset === "duelyard") {
        // Recheck after reading Nitrado: a player may have joined since the minute poll.
        const result = await this.options.refresh();
        if (result.status !== "online" || result.snapshot.onlineCount !== 0) return "deferred";
      }
      if (!options.shouldApply()) return "deferred";

      // Persist the attempt before either POST: a timeout can mean it was accepted.
      if (!unchanged) {
        await options.beforeMutation();
        if (!options.shouldApply()) return "deferred";
        await this.options.nitrado.setMapRotation(maps);
      }
      await options.afterSave?.();
      const savedStatus = await this.options.nitrado.getStatus();
      if (savedStatus !== "started" && savedStatus !== "stopped") {
        return "deferred";
      }
      if (preset === "duelyard") {
        // Saving and verifying settings takes time. Never restart players who joined meanwhile.
        const result = await this.options.refresh();
        if (result.status !== "online" || result.snapshot.onlineCount !== 0) return "deferred";
      }
      if (!options.shouldApply()) return "deferred";
      await options.beforeRestart?.();
      if (!options.shouldApply()) return "deferred";
      await this.options.nitrado.restart(`UnionBot /${this.options.commandName} set ${preset}; automatic Wednesday schedule Europe/Moscow`);
      return "applied";
    } finally {
      this.busy = false;
    }
  }

  private async rejectUnchangedRotation(interaction: ChatInputCommandInteraction, maps: readonly string[]) {
    const current = await this.options.nitrado.getMapRotation();
    if (!isSameMapRotation(current, maps)) return false;
    const content = maps.length === 1
      ? `Карта ${maps[0]} уже установлена в ротации. Сохранение и перезапуск не выполняются`
      : "Такая ротация уже установлена: карты, порядок и повторы совпадают. Сохранение и перезапуск не выполняются";
    await interaction.editReply({ content, components: [] });
    return true;
  }

  private allowed(interaction: ChatInputCommandInteraction | ButtonInteraction) {
    if (!interaction.member) return false;
    const roles = interaction.member.roles;
    return this.options.roleIds.some((id) => Array.isArray(roles) ? roles.includes(id) : roles.cache.has(id));
  }

  private now() {
    return (this.options.now ?? Date.now)();
  }

  private async confirm(interaction: ChatInputCommandInteraction, onlineCount?: number, maps?: readonly string[]): Promise<boolean> {
    const prefix = `server-restart:${randomUUID()}:`;
    const action = maps
      ? maps.length === 1 ? `поставить карту ${maps[0]} и перезапустить сервер` : `сохранить ротацию ${maps.join(" → ")} и перезапустить сервер`
      : "перезапустить сервер";
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`${prefix}confirm`).setLabel(maps ? "Сохранить ротацию и перезапустить" : "Перезапустить").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`${prefix}cancel`).setLabel("Отмена").setStyle(ButtonStyle.Secondary),
    );
    const warning = onlineCount === undefined
      ? "Не удалось проверить онлайн. На сервере могут быть игроки"
      : `Сейчас на сервере игроков: ${onlineCount}`;
    const message = await interaction.editReply({
      content: `${warning}\n\n**Вы уверены, что хотите ${action}?**\n\n-# Подтверждение действует 60 секунд`,
      components: [row],
    });
    let button: ButtonInteraction;
    try {
      button = await message.awaitMessageComponent({
        componentType: ComponentType.Button,
        time: CONFIRMATION_TIMEOUT_MS,
        filter: (candidate) => candidate.user.id === interaction.user.id
          && candidate.guildId === interaction.guildId
          && (candidate.customId === `${prefix}confirm` || candidate.customId === `${prefix}cancel`),
      });
    } catch {
      await interaction.editReply({ content: "Время подтверждения истекло. Перезапуск отменён", components: [] });
      return false;
    }
    await button.deferUpdate();
    if (button.customId === `${prefix}cancel`) {
      await interaction.editReply({ content: "Перезапуск отменён", components: [] });
      return false;
    }
    if (!this.allowed(button)) {
      await interaction.editReply({ content: "У вас больше нет роли для перезапуска сервера. Перезапуск отменён", components: [] });
      return false;
    }
    return true;
  }

  private async waitForStartup(interaction: ChatInputCommandInteraction, sawRestart: boolean, maps?: readonly string[]) {
    const deadline = this.now() + STATUS_INTERVAL_MS * STATUS_ATTEMPTS;
    for (let attempt = 0; attempt < STATUS_ATTEMPTS && this.now() < deadline; attempt++) {
      await (this.options.wait ?? delay)(Math.min(STATUS_INTERVAL_MS, deadline - this.now()));
      const status = await this.options.nitrado.getStatus();
      if (status === "restarting" || status === "stopping" || status === "stopped") sawRestart = true;
      if (status === "started" && sawRestart) {
        await interaction.editReply(maps ? `${formatSavedRotation(maps)}. Сервер запущен` : "Сервер запущен");
        return;
      }
      if (status !== "started" && status !== "restarting" && status !== "stopping" && status !== "stopped") break;
    }
    await interaction.editReply(maps ? `${formatSavedRotation(maps)}. Перезапуск начат...` : "Перезапуск начат...");
  }
}
