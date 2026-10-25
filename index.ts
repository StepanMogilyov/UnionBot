const query = require("source-server-query") as SourceServerQuery;
require("dotenv").config();

import { join } from "node:path";
import { Client, GatewayIntentBits, MessageFlags } from "discord.js";
import { ServerMonitor, type ServerRefreshResult, type SourceServerQuery } from "./src/server-monitor";
import { StatusChannelUpdater, isStatusChannelRateLimit } from "./src/status-channel-updater";
import { ONLINE_PLAYERS_BUTTON_ID, formatOnlinePlayersMessage } from "./src/discord-messages";
import { EventStatusStore } from "./src/event-status";
import { ActivityNotifications } from "./src/activity-notifications";
import { getServerCommandName, handleEventCommand, registerEventCommands } from "./src/event-command";
import { NitradoClient } from "./src/nitrado-client";
import { ServerRestartCommand } from "./src/server-restart-command";
import { LtsSchedule } from "./src/lts-schedule";

const { DISCORD_TOKEN = "", CHANNEL_IDS = "", HOST = "", PORT = "", SERVER_QUERY_TIMEOUT_MS = "10000", EVENT_MANAGER_ROLE_IDS = "", SERVER_DISPLAY_NAME = "" } = process.env;
const serverCommandName = getServerCommandName(SERVER_DISPLAY_NAME);

const channelIds = CHANNEL_IDS.split(",")
  .map((id) => id.trim())
  .filter(Boolean);
const eventManagerRoleIds = EVENT_MANAGER_ROLE_IDS.split(",").map((id) => id.trim()).filter(Boolean);
const { NITRADO_API_TOKEN = "", NITRADO_SERVICE_ID = "" } = process.env;

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  rest: {
    // Retry renames ourselves so discord.js cannot replay an old count after a long wait.
    rejectOnRateLimit: (limit) => isStatusChannelRateLimit(limit, channelIds),
  },
});

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
  checkServer,
  (closed) => statusChannelUpdater.setEventClosed(closed));
const serverMonitor = new ServerMonitor(query, {
  host: HOST,
  port: Number(PORT),
  timeout: serverQueryTimeout,
  onRefresh: publishServerRefresh,
});
const serverRestartCommand = new ServerRestartCommand({
  commandName: serverCommandName,
  roleIds: eventManagerRoleIds,
  nitrado: new NitradoClient({ token: NITRADO_API_TOKEN, serviceId: NITRADO_SERVICE_ID }),
  refresh: checkServer,
});
const ltsSchedule = new LtsSchedule({
  filePath: join(__dirname, "lts-schedule.json"),
  setPreset: (preset, options) => serverRestartCommand.setPresetAutomatically(preset, options),
  refresh: checkServer,
  onError: (error) => console.error("Ошибка автоматического расписания LTS; проверьте панель Nitrado:", error),
  onApplied: (preset, result) => console.log(`Расписание LTS (Europe/Moscow): set ${preset}: ${result}`),
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
  void ltsSchedule.check(result).catch((error) => {
    console.error("Ошибка автоматического расписания LTS; проверьте панель Nitrado:", error);
  });
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
  ltsSchedule.start();
  void activityNotifications.restoreAutoOpen().catch((error) => {
    console.error("Ошибка восстановления таймера открытия сервера:", error);
  });
  void registerEventCommands(client, channelIds, serverCommandName).catch(console.error);

  void checkServer().catch(console.error);

  setInterval(() => void checkServer().catch(console.error), 60_000);
});

client.on("interactionCreate", async (interaction) => {
  if (interaction.isChatInputCommand()) {
    try {
      if (await serverRestartCommand.handle(interaction)) return;
      await handleEventCommand(interaction, eventManagerRoleIds, (closed) => activityNotifications.setEventClosed(closed), serverCommandName);
    } catch (error) {
      console.error("Ошибка обработки команды сервера:", error);
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
        ? "Игровой сервер сейчас не отвечает. Попробуйте нажать TAB чуть позже"
        : "Не удалось обновить список игроков. Попробуйте нажать TAB чуть позже");
      return;
    }

    await interaction.editReply(formatOnlinePlayersMessage(result.snapshot));
  } catch (error) {
    console.error("Ошибка обработки TAB:", error);
  }
});

async function start() {
  await eventStatus.load();
  await ltsSchedule.load();
  await client.login(DISCORD_TOKEN);
}

void start().catch((error) => {
  console.error("Ошибка запуска бота:", error);
  process.exitCode = 1;
});
