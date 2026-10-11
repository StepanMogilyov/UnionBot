const query = require("source-server-query") as SourceServerQuery;
require("dotenv").config();

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, EmbedBuilder, GatewayIntentBits, MessageFlags, escapeMarkdown } from "discord.js";
import { ServerMonitor, type PlayerEventBatchMessage, type ServerRefreshResult, type SourceServerQuery } from "./server-monitor";
import { StatusChannelUpdater, isStatusChannelRateLimit } from "./status-channel-updater";
import { formatOnlinePlayersMessage } from "./discord-messages";

const { DISCORD_TOKEN = "", CHANNEL_IDS = "", HOST = "", PORT = "", SERVER_QUERY_TIMEOUT_MS = "10000" } = process.env;

const channelIds = CHANNEL_IDS.split(",")
  .map((id) => id.trim())
  .filter(Boolean);

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  rest: {
    // Retry renames ourselves so discord.js cannot replay an old count after a long wait.
    rejectOnRateLimit: (limit) => isStatusChannelRateLimit(limit, channelIds),
  },
});

const ONLINE_PLAYERS_BUTTON_ID = "online_players_tab";
const SERVER_DISPLAY_NAME = "union";
const MAX_CHANNEL_NAME_LENGTH = 100;
const configuredServerQueryTimeout = Number(SERVER_QUERY_TIMEOUT_MS);
const serverQueryTimeout = Number.isFinite(configuredServerQueryTimeout) && configuredServerQueryTimeout > 0 ? configuredServerQueryTimeout : 10000;
const statusChannelUpdater = new StatusChannelUpdater(
  channelIds,
  (id) => client.channels.fetch(id, { force: true }),
  (id, error) => console.error(`Ошибка обновления названия канала ${id}:`, error),
  (id, retryAt) => console.warn(
    `Discord отложил переименование канала ${id} до ${new Date(retryAt).toISOString()}; после ожидания будет отправлен актуальный онлайн`,
  ),
);
let eventDelivery = Promise.resolve();
const serverMonitor = new ServerMonitor(query, {
  host: HOST,
  port: Number(PORT),
  timeout: serverQueryTimeout,
  onRefresh: publishServerRefresh,
});

function formatStatusChannelName(isOnline: boolean, onlineCount?: number, maxPlayers?: number, map?: string) {
  const statusEmoji = isOnline && onlineCount !== undefined && onlineCount > 0 ? "🟢" : "🔴";

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

function createOnlinePlayersButtonRow() {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(ONLINE_PLAYERS_BUTTON_ID).setEmoji("⚔️").setLabel("TAB").setStyle(ButtonStyle.Primary),
  );
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

function createPlayerEventEmbed(event: PlayerEventBatchMessage, channelId: string) {
  const embed = new EmbedBuilder()
    .setColor(getPlayerEventBatchColor(event))
    .setDescription("Изменения активности на сервере")
    .setTimestamp(event.updatedAt)
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

  if (statusChannelUpdater.isRateLimited(channelId)) {
    embed.setFooter({ text: "Название канала обновится позже. Свежий онлайн — по кнопке TAB." });
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
        embeds: [createPlayerEventEmbed(event, channelId)],
        components: [createOnlinePlayersButtonRow()],
      });
    } catch (error) {
      console.error(`Ошибка отправки в канал ${channelId}:`, error);
    }
  }
}

function publishServerRefresh(result: ServerRefreshResult) {
  if (result.status !== "online") {
    console.warn(`Не удалось обновить данные сервера (${result.status}): ${result.error.message}`);
    if (result.status === "offline") statusChannelUpdater.update(formatStatusChannelName(false));
    return;
  }

  const { snapshot, event } = result;
  statusChannelUpdater.update(formatStatusChannelName(true, snapshot.onlineCount, snapshot.maxPlayers, snapshot.map));
  if (event) {
    // Preserve event order without making polling or TAB wait for Discord requests.
    eventDelivery = eventDelivery.then(() => sendToDiscord(event)).catch((error) => {
      console.error("Ошибка отправки изменений активности:", error);
    });
  }
}

function checkServer() {
  return serverMonitor.refresh();
}

client.once("clientReady", () => {
  console.log(`Discord bot logged in as ${client.user?.tag}`);

  void checkServer().catch(console.error);

  setInterval(() => void checkServer().catch(console.error), 60_000);
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton() || interaction.customId !== ONLINE_PLAYERS_BUTTON_ID) {
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const result = await checkServer();
    if (result.status !== "online") {
      await interaction.editReply(result.status === "offline"
        ? "Игровой сервер сейчас не отвечает. Попробуйте нажать TAB чуть позже."
        : "Не удалось получить согласованный список игроков. Попробуйте нажать TAB чуть позже.");
      return;
    }

    await interaction.editReply(formatOnlinePlayersMessage(result.snapshot));
  } catch (error) {
    console.error("Ошибка обработки TAB:", error);
  }
});

client.login(DISCORD_TOKEN);
