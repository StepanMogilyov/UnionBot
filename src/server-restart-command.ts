import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, MessageFlags,
  type ButtonInteraction, type ChatInputCommandInteraction,
} from "discord.js";
import type { ServerRefreshResult } from "./server-monitor";
import type { NitradoClient } from "./nitrado-client";

interface RestartOptions {
  roleIds: string[];
  nitrado: Pick<NitradoClient, "configured" | "getStatus" | "restart">;
  refresh: () => Promise<ServerRefreshResult>;
  now?: () => number;
  wait?: (ms: number) => Promise<unknown>;
}

const CONFIRMATION_TIMEOUT_MS = 60_000;
const STATUS_INTERVAL_MS = 5_000;
const STATUS_ATTEMPTS = 60;

export class ServerRestartCommand {
  private busy = false;

  constructor(private readonly options: RestartOptions) {}

  async handle(interaction: ChatInputCommandInteraction): Promise<boolean> {
    if (interaction.commandName !== "server" || interaction.options.getSubcommand() !== "restart") return false;
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

    // One game server is shared by every configured Discord channel and guild.
    this.busy = true;
    let restartRequested = false;
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const initialStatus = await this.options.nitrado.getStatus();
      if (initialStatus !== "started" && initialStatus !== "stopped") {
        await interaction.editReply("Сервер уже перезапускается или занят другой операцией Nitrado. Проверьте панель хостинга");
        return true;
      }

      let onlineCount: number | undefined;
      try {
        const result = await this.options.refresh();
        if (result.status === "online") onlineCount = result.snapshot.onlineCount;
      } catch {
        // Missing or inconsistent query data must never be treated as an empty server.
      }
      if (onlineCount !== 0 && !await this.confirm(interaction, onlineCount)) return true;

      // The service may have been restarted from the hosting panel while the prompt was open.
      const status = await this.options.nitrado.getStatus();
      if (status !== "started" && status !== "stopped") {
        await interaction.editReply({ content: "Сервер уже перезапускается или занят другой операцией Nitrado. Повторный запрос не отправлен", components: [] });
        return true;
      }
      await interaction.editReply({ content: "Отправляю запрос на перезапуск сервера…", components: [] });
      // Do not retry a POST, even on timeout: Nitrado may already have accepted it.
      restartRequested = true;
      await this.options.nitrado.restart(`UnionBot /server restart; Discord user ${interaction.user.id}; guild ${interaction.guildId}`);
      await interaction.editReply("Перезапуск...");
      await this.waitForStartup(interaction, status === "stopped");
    } catch (error) {
      console.error("Ошибка команды перезапуска сервера:", error);
      const detail = error instanceof Error ? error.message : "Неизвестная ошибка";
      const content = restartRequested
        ? `Не удалось подтвердить завершение перезапуска. ${detail}. Проверьте панель Nitrado перед повторной командой; повторный запрос автоматически не отправлялся`
        : `Не удалось подготовить перезапуск. ${detail}`;
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

  private allowed(interaction: ChatInputCommandInteraction | ButtonInteraction) {
    if (!interaction.member) return false;
    const roles = interaction.member.roles;
    return this.options.roleIds.some((id) => Array.isArray(roles) ? roles.includes(id) : roles.cache.has(id));
  }

  private now() {
    return (this.options.now ?? Date.now)();
  }

  private async confirm(interaction: ChatInputCommandInteraction, onlineCount?: number): Promise<boolean> {
    const prefix = `server-restart:${randomUUID()}:`;
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`${prefix}confirm`).setLabel("Перезапустить").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`${prefix}cancel`).setLabel("Отмена").setStyle(ButtonStyle.Secondary),
    );
    const warning = onlineCount === undefined
      ? "Не удалось проверить онлайн. На сервере могут быть игроки"
      : `Сейчас на сервере игроков: ${onlineCount}`;
    const message = await interaction.editReply({
      content: `${warning}\n\n**Вы уверены, что хотите перезапустить сервер?**\n\n-# Подтверждение действует 60 секунд`,
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

  private async waitForStartup(interaction: ChatInputCommandInteraction, sawRestart: boolean) {
    const deadline = this.now() + STATUS_INTERVAL_MS * STATUS_ATTEMPTS;
    for (let attempt = 0; attempt < STATUS_ATTEMPTS && this.now() < deadline; attempt++) {
      await (this.options.wait ?? delay)(Math.min(STATUS_INTERVAL_MS, deadline - this.now()));
      const status = await this.options.nitrado.getStatus();
      if (status === "restarting" || status === "stopping" || status === "stopped") sawRestart = true;
      if (status === "started" && sawRestart) {
        await interaction.editReply("Сервер запущен");
        return;
      }
      if (status !== "started" && status !== "restarting" && status !== "stopping" && status !== "stopped") break;
    }
    await interaction.editReply("Перезапуск начат...");
  }
}
