import { ApplicationCommandType, MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction, type Client } from "discord.js";
import type { EventNotificationResult } from "./activity-notifications";
import { formatServerMapsMessage } from "./discord-messages";
import { MAX_MAP_ROTATION_LENGTH } from "./server-maps";

export function getServerCommandName(serverDisplayName: string) {
  const commandName = serverDisplayName.trim().toLowerCase() || "server";
  try {
    new SlashCommandBuilder().setName(commandName);
  } catch {
    throw new Error("Некорректный SERVER_DISPLAY_NAME в .env: имя slash-команды должно содержать от 1 до 32 символов (буквы, цифры, _ или -), без пробелов");
  }
  return commandName;
}

export function createEventCommand(commandName: string) {
  return new SlashCommandBuilder()
    .setName(commandName)
    .setDescription("Информация об игровом сервере и управление им")
    .addSubcommand((command) => command.setName("close").setDescription("Сообщить о закрытии сервера на ивент"))
    .addSubcommand((command) => command.setName("open").setDescription("Сообщить о завершении ивента и открытии сервера"))
    .addSubcommand((command) => command.setName("restart").setDescription("Перезапустить игровой сервер"))
    .addSubcommandGroup((group) => group.setName("set").setDescription("Сохранить ротацию карт и перезапустить игровой сервер")
      .addSubcommand((command) => command.setName("map").setDescription("Установить выбранные карты и перезапустить сервер (несколько карт — через пробел)")
        .addStringOption((option) => option.setName("maps").setDescription(`Например: FFA_Duelyard TO_DarkForest. Список и примеры: /${commandName} show maps`)
          .setRequired(true).setMinLength(1).setMaxLength(MAX_MAP_ROTATION_LENGTH).setAutocomplete(false)))
      .addSubcommand((command) => command.setName("lts").setDescription("Установить все карты LTS и перезапустить сервер"))
      .addSubcommand((command) => command.setName("duelyard").setDescription("Установить только FFA_Duelyard и перезапустить сервер")))
    .addSubcommandGroup((group) => group.setName("show").setDescription("Посмотреть информацию об игровом сервере")
      .addSubcommand((command) => command.setName("maps").setDescription("Показать полный список доступных карт")));
}

export async function registerEventCommands(client: Client, channelIds: string[], commandName: string) {
  const guildIds = new Set<string>();
  for (const channelId of channelIds) {
    try {
      const channel = await client.channels.fetch(channelId);
      if (channel && "guildId" in channel) guildIds.add(channel.guildId);
    } catch (error) {
      console.error(`Не удалось определить Discord-сервер канала ${channelId}:`, error);
    }
  }
  for (const guildId of guildIds) {
    try {
      const commands = client.application!.commands;
      await commands.create(createEventCommand(commandName).toJSON(), guildId);
      // Retire the old slash command only after its replacement is registered.
      const registered = await commands.fetch({ guildId });
      for (const command of registered.values()) {
        if (command.name !== commandName && (command.name === "event" || command.name === "server")
          && command.type === ApplicationCommandType.ChatInput) {
          await commands.delete(command.id, guildId);
        }
      }
    } catch (error) {
      console.error(`Ошибка регистрации /${commandName} на Discord-сервере ${guildId}:`, error);
    }
  }
}

export async function handleEventCommand(interaction: ChatInputCommandInteraction, roleIds: string[], setEventClosed: (closed: boolean) => Promise<EventNotificationResult>, commandName: string) {
  if (interaction.commandName !== commandName) return false;
  const group = interaction.options.getSubcommandGroup(false);
  const subcommand = interaction.options.getSubcommand();
  if (group === "set" || (!group && subcommand === "restart")) return false;
  if (!interaction.guildId || !interaction.member) {
    await interaction.reply({ content: "Эта команда доступна только на Discord-сервере", flags: MessageFlags.Ephemeral });
    return true;
  }
  if (group === "show" && subcommand === "maps") {
    await interaction.reply({ content: formatServerMapsMessage(commandName), flags: MessageFlags.Ephemeral });
    return true;
  }
  if (roleIds.length === 0) {
    await interaction.reply({ content: "Управление ивентом не настроено: укажите EVENT_MANAGER_ROLE_IDS в .env", flags: MessageFlags.Ephemeral });
    return true;
  }
  const roles = interaction.member.roles;
  const allowed = roleIds.some((id) => (Array.isArray(roles) ? roles.includes(id) : roles.cache.has(id)));
  if (!allowed) {
    await interaction.reply({ content: "У вас нет роли для управления отметкой ивента", flags: MessageFlags.Ephemeral });
    return true;
  }
  if (group || (subcommand !== "close" && subcommand !== "open")) {
    await interaction.reply({ content: `Используйте /${commandName} close или /${commandName} open`, flags: MessageFlags.Ephemeral });
    return true;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    await setEventClosed(subcommand === "close");
  } catch (error) {
    console.error("Ошибка изменения статуса ивента:", error);
    await completeEventReply(interaction, "Не удалось сохранить статус ивента. Попробуйте ещё раз");
    return true;
  }
  await completeEventReply(interaction, subcommand === "close"
    ? "Статус сохранён: сервер закрыт на ивент"
    : "Статус сохранён: ивент завершён, сервер открыт");
  return true;
}

async function completeEventReply(interaction: ChatInputCommandInteraction, content: string) {
  try {
    await interaction.editReply(content);
  } catch (error) {
    console.error("Не удалось завершить ответ команды ивента:", error);
    // The public notice has already been sent; clear the deferred reply without replaying the command.
    await interaction.deleteReply();
  }
}
