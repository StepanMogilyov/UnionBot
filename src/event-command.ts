import { ApplicationCommandType, MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction, type Client } from "discord.js";
import type { EventNotificationResult } from "./activity-notifications";

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
    .setDescription("Управление игровым сервером и отметкой ивента")
    .addSubcommand((command) => command.setName("close").setDescription("Сообщить о закрытии сервера на ивент"))
    .addSubcommand((command) => command.setName("open").setDescription("Сообщить о завершении ивента и открытии сервера"))
    .addSubcommand((command) => command.setName("restart").setDescription("Перезапустить игровой сервер"));
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
  if (interaction.options.getSubcommand() === "restart") return false;
  if (!interaction.guildId || !interaction.member) {
    await interaction.reply({ content: "Эта команда доступна только на Discord-сервере", flags: MessageFlags.Ephemeral });
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
  const subcommand = interaction.options.getSubcommand();
  if (subcommand !== "close" && subcommand !== "open") {
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
  const lines = [subcommand === "close" ? "Статус сохранён: сервер закрыт на ивент" : "Статус сохранён: ивент завершён, сервер открыт"];

  await completeEventReply(interaction, lines.join("\n"));
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
