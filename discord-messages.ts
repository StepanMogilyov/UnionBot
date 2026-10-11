import { escapeMarkdown } from "discord.js";
import type { ServerSnapshot } from "./server-monitor";

export function formatOnlinePlayersMessage(snapshot: ServerSnapshot) {
  const playerList = snapshot.players.length > 0
    ? snapshot.players.map((name) => `• ${name.trim() ? escapeMarkdown(name) : "Игрок без имени"}`).join("\n")
    : "Сейчас никого нет";

  return `**Игроки онлайн — ${snapshot.onlineCount}/${snapshot.maxPlayers}**\n\n${playerList}`;
}
