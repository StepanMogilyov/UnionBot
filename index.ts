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

interface PlayerEventBatchMessage {
  joinedPlayers: string[];
  leftPlayers: string[];
  map: string;
  maxPlayers: number;
  onlineCount: number;
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

function formatPlayerEventList(players: string[]) {
  return players.map((name) => `• **${escapeMarkdown(name)}**`).join("\n");
}

function getPlayerEventBatchColor(event: PlayerEventBatchMessage) {
  if (event.joinedPlayers.length > 0 && event.leftPlayers.length > 0) {
    return 0xfee75c;
  }

  return event.joinedPlayers.length > 0 ? 0x57f287 : 0xed4245;
}

function createPlayerEventEmbed(event: PlayerEventBatchMessage) {
  const embed = new EmbedBuilder()
    .setColor(getPlayerEventBatchColor(event))
    .setDescription("Изменения активности игроков на сервере.")
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

    if (joinedPlayers.length > 0 || leftPlayers.length > 0) {
      await sendToDiscord({
        joinedPlayers,
        leftPlayers,
        map: info.map,
        maxPlayers: info.max_players,
        onlineCount: info.players,
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
