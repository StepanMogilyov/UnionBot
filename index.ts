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
  map: string;
}

interface PlayerEventBatchMessage {
  joinedPlayers: string[];
  leftPlayers: string[];
  map: string;
  maxPlayers: number;
  onlineCount: number;
}

interface RenamableChannel {
  name: string;
  setName(name: string, reason?: string): Promise<unknown>;
}

const { DISCORD_TOKEN = "", CHANNEL_IDS = "", HOST = "", PORT = "", SERVER_QUERY_TIMEOUT_MS = "10000" } = process.env;

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

const channelIds = CHANNEL_IDS.split(",")
  .map((id) => id.trim())
  .filter(Boolean);

let previousPlayers: string[] | null = null;
let previousMap: string | null = null;
let latestServerSnapshot: ServerSnapshot | null = null;
const lastStatusChannelNames = new Map<string, string>();

const ONLINE_PLAYERS_BUTTON_ID = "online_players_tab";
const SERVER_DISPLAY_NAME = "union";
const MAX_CHANNEL_NAME_LENGTH = 100;
const configuredServerQueryTimeout = Number(SERVER_QUERY_TIMEOUT_MS);
const serverQueryTimeout = Number.isFinite(configuredServerQueryTimeout) ? configuredServerQueryTimeout : 10000;

function isRenamableChannel(channel: unknown): channel is RenamableChannel {
  if (typeof channel !== "object" || channel === null) {
    return false;
  }

  const candidate = channel as Partial<RenamableChannel>;
  return typeof candidate.name === "string" && typeof candidate.setName === "function";
}

function formatStatusChannelName(isOnline: boolean, onlineCount?: number, maxPlayers?: number, map?: string) {
  const statusEmoji = isOnline ? "🟢" : "🔴";

  if (onlineCount === undefined || maxPlayers === undefined || map === undefined) {
    return `${statusEmoji}・${SERVER_DISPLAY_NAME}・offline`;
  }

  const normalizedMap =
    map
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_-]+/gu, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "unknown";
  const name = `${statusEmoji}・${SERVER_DISPLAY_NAME}・${onlineCount}⁄${maxPlayers}・${normalizedMap}`;

  return Array.from(name).slice(0, MAX_CHANNEL_NAME_LENGTH).join("");
}

async function updateStatusChannels(isOnline: boolean, onlineCount?: number, maxPlayers?: number, map?: string) {
  if (channelIds.length === 0) {
    return;
  }

  const desiredName = formatStatusChannelName(isOnline, onlineCount, maxPlayers, map);

  for (const channelId of channelIds) {
    if (lastStatusChannelNames.get(channelId) === desiredName) {
      continue;
    }

    try {
      const channel = await client.channels.fetch(channelId);

      if (!isRenamableChannel(channel)) {
        console.error(`Канал ${channelId} не найден или его нельзя переименовать`);
        continue;
      }

      if (channel.name !== desiredName) {
        await channel.setName(desiredName, "Обновление статуса игрового сервера");
        console.log(`Название канала ${channelId} обновлено: ${desiredName}`);
      }

      lastStatusChannelNames.set(channelId, desiredName);
    } catch (error) {
      console.error(`Ошибка обновления названия канала ${channelId}:`, error);
    }
  }
}

function createOnlinePlayersButtonRow() {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(ONLINE_PLAYERS_BUTTON_ID).setEmoji("⚔️").setLabel("TAB").setStyle(ButtonStyle.Primary),
  );
}

function formatOnlinePlayersMessage(players: string[], onlineCount: number, maxPlayers: number) {
  const onlinePlayers = players.map((name) => escapeMarkdown(name));
  const playerList = onlinePlayers.length > 0 ? onlinePlayers.map((name) => `• ${name}`).join("\n") : "Сейчас никого нет";

  return `**Игроки онлайн — ${onlineCount}/${maxPlayers}**\n\n${playerList}`;
}

function formatPlayerEventList(players: string[]) {
  return players.map((name) => `• **${escapeMarkdown(name)}**`).join("\n");
}

function getPlayerEventBatchColor(event: PlayerEventBatchMessage) {
  if (event.joinedPlayers.length > 0 && event.leftPlayers.length > 0) {
    return 0xfee75c;
  }

  if (event.joinedPlayers.length === 0 && event.leftPlayers.length === 0) {
    return 0xfee75c;
  }

  return event.joinedPlayers.length > 0 ? 0x57f287 : 0xed4245;
}

function createPlayerEventEmbed(event: PlayerEventBatchMessage) {
  const embed = new EmbedBuilder()
    .setColor(getPlayerEventBatchColor(event))
    .setDescription("Изменения активности на сервере")
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

  if (event.joinedPlayers.length > 0) {
    embed.addFields({
      name: "🟢 Зашли",
      value: formatPlayerEventList(event.joinedPlayers),
    });
  }

  if (event.leftPlayers.length > 0) {
    embed.addFields({
      name: "🔴 Вышли",
      value: formatPlayerEventList(event.leftPlayers),
    });
  }

  return embed;
}

async function sendToDiscord(event: PlayerEventBatchMessage) {
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
  let serverResponded = false;

  try {
    const info = await query.info(HOST, Number(PORT), serverQueryTimeout);
    serverResponded = true;
    await updateStatusChannels(true, info.players, info.max_players, info.map);

    const players = await query.players(HOST, Number(PORT), serverQueryTimeout);

    const currentPlayers: string[] = players.map((player) => player.name).filter((name: string) => name.trim().length > 0);

    latestServerSnapshot = {
      players: currentPlayers,
      onlineCount: info.players,
      maxPlayers: info.max_players,
      map: info.map,
    };

    if (previousPlayers === null) {
      previousPlayers = currentPlayers;
      previousMap = info.map;
      return;
    }

    const joinedPlayers = currentPlayers.filter((name) => !previousPlayers!.includes(name));

    const leftPlayers = previousPlayers.filter((name) => !currentPlayers.includes(name));

    const mapChanged = previousMap !== info.map;

    previousPlayers = currentPlayers;
    previousMap = info.map;

    if (joinedPlayers.length > 0 || leftPlayers.length > 0 || mapChanged) {
      await sendToDiscord({
        joinedPlayers,
        leftPlayers,
        map: info.map,
        maxPlayers: info.max_players,
        onlineCount: info.players,
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Сервер не ответил на запрос: ${message}`);

    if (!serverResponded) {
      await updateStatusChannels(false);
    }
  }
}

client.once("clientReady", () => {
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
