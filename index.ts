const query = require("source-server-query") as SourceServerQuery;
require("dotenv").config();

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, EmbedBuilder, GatewayIntentBits, MessageFlags, escapeMarkdown } from "discord.js";

interface ServerInfo {
  header: string;
  protocol: number;
  name: string;
  map: string;
  folder: string;
  game: string;
  id: number;
  players: number;
  max_players: number;
  bots: number;
  server_type: string;
  environment: string;
  visibility: number;
  vac: number;
  version: string;
  port: number;
}

interface ServerPlayer {
  index: number;
  name: string;
  score: number;
  duration: number;
}

interface SourceServerQuery {
  info(host: string, port: number, timeout?: number): Promise<ServerInfo>;
  players(host: string, port: number, timeout?: number): Promise<ServerPlayer[]>;
}

interface ServerSnapshot {
  players: string[];
  onlineCount: number;
  maxPlayers: number;
}

interface PlayerEventMessage {
  color: number;
  icon: string;
  map: string;
  maxPlayers: number;
  onlineCount: number;
  playerName: string;
  action: string;
}

const { DISCORD_TOKEN = "", CHANNEL_IDS = "", HOST = "", PORT = "" } = process.env;

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

const channelIds = CHANNEL_IDS.split(",")
  .map((id) => id.trim())
  .filter(Boolean);

let previousPlayers: string[] | null = null;
let latestServerSnapshot: ServerSnapshot | null = null;

const ONLINE_PLAYERS_BUTTON_ID = "online_players_tab";

function createOnlinePlayersButtonRow() {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(ONLINE_PLAYERS_BUTTON_ID).setEmoji("⚔️").setLabel("TAB").setStyle(ButtonStyle.Primary),
  );
}

function formatOnlinePlayersMessage(players: string[], onlineCount: number, maxPlayers: number) {
  const onlinePlayers = players.map((name) => escapeMarkdown(name));
  const playerList = onlinePlayers.length > 0 ? onlinePlayers.map((name) => `• ${name}`).join("\n") : "Сейчас никого нет онлайн.";

  return `**Игроки онлайн — ${onlineCount}/${maxPlayers}**\n\n${playerList}`;
}

function createPlayerEventEmbed(event: PlayerEventMessage) {
  return new EmbedBuilder()
    .setColor(event.color)
    .setDescription(`${event.icon} **${escapeMarkdown(event.playerName)}** ${event.action}.`)
    .addFields(
      {
        name: "Онлайн",
        value: `**${event.onlineCount}/${event.maxPlayers}**`,
        inline: true,
      },
      {
        name: "Карта",
        value: `**${escapeMarkdown(event.map)}**`,
        inline: true,
      },
    );
}

async function sendToDiscord(event: PlayerEventMessage) {
  for (const channelId of channelIds) {
    try {
      const channel = await client.channels.fetch(channelId);

      if (!channel || !channel.isSendable()) {
        console.error(`Канал ${channelId} не найден или в него нельзя отправлять сообщения`);
        continue;
      }

      await channel.send({
        embeds: [createPlayerEventEmbed(event)],
        components: [createOnlinePlayersButtonRow()],
      });
    } catch (error) {
      console.error(`Ошибка отправки в канал ${channelId}:`, error);
    }
  }
}

async function checkServer() {
  try {
    const info = await query.info(HOST, Number(PORT), 5000);

    const players = await query.players(HOST, Number(PORT), 5000);

    const currentPlayers: string[] = players.map((player) => player.name).filter((name: string) => name.trim().length > 0);

    latestServerSnapshot = {
      players: currentPlayers,
      onlineCount: currentPlayers.length,
      maxPlayers: info.max_players,
    };

    if (previousPlayers === null) {
      previousPlayers = currentPlayers;
      return;
    }

    const joinedPlayers = currentPlayers.filter((name) => !previousPlayers!.includes(name));

    const leftPlayers = previousPlayers.filter((name) => !currentPlayers.includes(name));

    previousPlayers = currentPlayers;

    for (const name of joinedPlayers) {
      await sendToDiscord({
        color: 0x57f287,
        icon: "🟢",
        map: info.map,
        maxPlayers: info.max_players,
        onlineCount: info.players,
        playerName: name,
        action: "зашёл на сервер",
      });
    }

    for (const name of leftPlayers) {
      await sendToDiscord({
        color: 0xed4245,
        icon: "🔴",
        map: info.map,
        maxPlayers: info.max_players,
        onlineCount: info.players,
        playerName: name,
        action: "вышел с сервера",
      });
    }
  } catch (error) {
    console.error("Ошибка запроса:", error);
  }
}

client.once("ready", () => {
  console.log(`Discord bot logged in as ${client.user?.tag}`);

  checkServer();

  setInterval(checkServer, 60_000);
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton() || interaction.customId !== ONLINE_PLAYERS_BUTTON_ID) {
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (!latestServerSnapshot) {
    await interaction.editReply("Список игроков ещё не загружен. Попробуйте нажать TAB чуть позже.");
    return;
  }

  await interaction.editReply(formatOnlinePlayersMessage(latestServerSnapshot.players, latestServerSnapshot.onlineCount, latestServerSnapshot.maxPlayers));
});

client.login(DISCORD_TOKEN);
