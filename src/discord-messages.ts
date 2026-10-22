import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, escapeMarkdown } from "discord.js";
import type { PlayerEventBatchMessage, ServerSnapshot } from "./server-monitor";

export const ONLINE_PLAYERS_BUTTON_ID = "online_players_tab";
export const ACTIVITY_DESCRIPTION = "Изменения активности на сервере";
export const EVENT_CLOSED_NOTICE = "🔒 Сервер закрыт на ивент";
export const EVENT_OPEN_NOTICE = "🔓 Сервер доступен по текущему паролю";

export function createEventStatusEmbed(eventClosed: boolean, snapshot?: ServerSnapshot) {
  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setDescription(eventClosed ? formatActivityDescription(true) : EVENT_OPEN_NOTICE)
    .setTimestamp();
  return addServerFields(embed, snapshot);
}

export function formatActivityDescription(eventClosed: boolean) {
  return eventClosed ? `${ACTIVITY_DESCRIPTION}\n${EVENT_CLOSED_NOTICE}` : ACTIVITY_DESCRIPTION;
}

export function createOnlinePlayersButtonRow() {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(ONLINE_PLAYERS_BUTTON_ID).setEmoji("⚔️").setLabel("TAB").setStyle(ButtonStyle.Primary),
  );
}

export function createPlayerEventEmbed(event: PlayerEventBatchMessage, eventClosed = false) {
  let color = event.onlineCount > 0 ? 0x57f287 : 0xfee75c;
  if (!event.mapChanged && event.leftPlayers.length > 0) {
    color = event.joinedPlayers.length > 0 ? 0xfee75c : 0xed4245;
  }
  const embed = new EmbedBuilder()
    .setColor(color)
    .setDescription(formatActivityDescription(eventClosed))
    .setTimestamp(event.updatedAt);
  addServerFields(embed, event);

  if (event.joinedPlayers.length > 0) {
    embed.addFields({ name: "🟢 Зашли", value: formatPlayerEventList(event.joinedPlayers) });
  }
  if (event.leftPlayers.length > 0) {
    embed.addFields({ name: "🔴 Вышли", value: formatPlayerEventList(event.leftPlayers) });
  }
  return embed;
}

function addServerFields(embed: EmbedBuilder, snapshot?: ServerSnapshot) {
  return embed.addFields(
    { name: "Онлайн", value: snapshot ? `**${snapshot.onlineCount}/${snapshot.maxPlayers}**` : "Нет данных", inline: true },
    { name: "Карта", value: snapshot ? `**${escapeMarkdown(snapshot.map)}**` : "Нет данных", inline: true },
  );
}

function formatPlayerEventList(players: string[]) {
  return players.map((name) => `• **${escapeMarkdown(name)}**`).join("\n");
}

export function formatOnlinePlayersMessage(snapshot: ServerSnapshot) {
  const playerList = snapshot.players.length > 0
    ? snapshot.players.map((name) => `• ${name.trim() ? escapeMarkdown(name) : "Игрок без имени"}`).join("\n")
    : "Сейчас никого нет 🪦";

  return `**Игроки онлайн — ${snapshot.onlineCount}/${snapshot.maxPlayers}**\n\n${playerList}`;
}
