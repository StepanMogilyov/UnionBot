import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, escapeMarkdown } from "discord.js";
import type { PlayerEventBatchMessage, ServerSnapshot } from "./server-monitor";
import { SERVER_MAPS } from "./server-maps";

export const ONLINE_PLAYERS_BUTTON_ID = "online_players_tab";
export const ACTIVITY_DESCRIPTION = "Изменения активности на сервере";
export const EVENT_CLOSED_NOTICE = "🔒 Сервер закрыт на ивент";
export const EVENT_OPEN_NOTICE = "🔓 Сервер доступен по текущему паролю";

export function createEventStatusEmbed(eventClosed: boolean, snapshot?: ServerSnapshot) {
  const embed = new EmbedBuilder()
    .setColor(eventClosed ? 0xfee75c : 0x57f287)
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
  if (event.leftPlayers.length > 0) {
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

export function formatServerMapsMessage(commandName: string) {
  const groups = new Map<string, string[]>();
  for (const map of SERVER_MAPS) {
    const mode = map.startsWith("PR_LTS_") ? "PR_LTS" : map.slice(0, map.indexOf("_")).toUpperCase();
    const maps = groups.get(mode) ?? [];
    maps.push(map);
    groups.set(mode, maps);
  }
  const sections = Array.from(groups, ([mode, maps]) => `**${mode}**\n${maps.map((map) => `\`${map}\``).join("\n")}`);
  return `**Доступные карты — ${SERVER_MAPS.length}**\n\n${sections.join("\n\n")}\n\nДля смены карты (несколько карт — через пробел): \`/${commandName} set map FFA_Wardenglade\`\nПример ротации: \`/${commandName} set map TO_Coxwell TO_Lionspire TO_RudhelmSiege\`\nВсе карты LTS: \`/${commandName} set lts\`\nТолько Duelyard: \`/${commandName} set duelyard\``;
}
