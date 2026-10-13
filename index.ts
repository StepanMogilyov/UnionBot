const query = require("source-server-query") as SourceServerQuery;
require("dotenv").config();

import { join } from "node:path";
import { Client, GatewayIntentBits, MessageFlags } from "discord.js";
import { ServerMonitor, type ServerRefreshResult, type SourceServerQuery } from "./server-monitor";
import { StatusChannelUpdater, isStatusChannelRateLimit } from "./status-channel-updater";
import { ONLINE_PLAYERS_BUTTON_ID, formatOnlinePlayersMessage } from "./discord-messages";
import { EventStatusStore } from "./event-status";
import { ActivityNotifications } from "./activity-notifications";
import { handleEventCommand, registerEventCommands } from "./event-command";

const { DISCORD_TOKEN = "", CHANNEL_IDS = "", HOST = "", PORT = "", SERVER_QUERY_TIMEOUT_MS = "10000", EVENT_MANAGER_ROLE_IDS = "" } = process.env;

const channelIds = CHANNEL_IDS.split(",")
  .map((id) => id.trim())
  .filter(Boolean);
const eventManagerRoleIds = EVENT_MANAGER_ROLE_IDS.split(",").map((id) => id.trim()).filter(Boolean);

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  rest: {
    // Retry renames ourselves so discord.js cannot replay an old count after a long wait.
    rejectOnRateLimit: (limit) => isStatusChannelRateLimit(limit, channelIds),
  },
});

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
const eventStatus = new EventStatusStore(join(__dirname, "event-status.json"));
const activityNotifications = new ActivityNotifications(client, channelIds, eventStatus,
  (channelId, error) => console.error(`Ошибка отправки уведомления в канал ${channelId}:`, error),
  checkServer);
const serverMonitor = new ServerMonitor(query, {
  host: HOST,
  port: Number(PORT),
  timeout: serverQueryTimeout,
  onRefresh: publishServerRefresh,
});

function formatStatusChannelName(isOnline: boolean, onlineCount?: number, maxPlayers?: number, map?: string) {
  const statusEmoji = !isOnline ? "🪦" : onlineCount !== undefined && onlineCount > 0 ? "🟢" : "🔴";

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

function publishServerRefresh(result: ServerRefreshResult) {
  if (result.status !== "online") {
    console.warn(`Не удалось обновить данные сервера (${result.status}): ${result.error.message}`);
    if (result.status === "offline") statusChannelUpdater.update(formatStatusChannelName(false));
    return;
  }

  const { snapshot, event } = result;
  statusChannelUpdater.update(formatStatusChannelName(true, snapshot.onlineCount, snapshot.maxPlayers, snapshot.map));
  if (event) {
    void activityNotifications.publish(event).catch((error) => {
      console.error("Ошибка отправки изменений активности:", error);
    });
  }
}

function checkServer() {
  return serverMonitor.refresh();
}

client.once("clientReady", () => {
  console.log(`Discord bot logged in as ${client.user?.tag}`);
  void registerEventCommands(client, channelIds).catch(console.error);

  void checkServer().catch(console.error);

  setInterval(() => void checkServer().catch(console.error), 60_000);
});

client.on("interactionCreate", async (interaction) => {
  if (interaction.isChatInputCommand()) {
    try {
      await handleEventCommand(interaction, eventManagerRoleIds, (closed) => activityNotifications.setEventClosed(closed));
    } catch (error) {
      console.error("Ошибка обработки команды ивента:", error);
    }
    return;
  }
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

async function start() {
  await eventStatus.load();
  await client.login(DISCORD_TOKEN);
}

void start().catch((error) => {
  console.error("Ошибка запуска бота:", error);
  process.exitCode = 1;
});
