const query = require("source-server-query") as SourceServerQuery;
require("dotenv").config();

import { Client, GatewayIntentBits } from "discord.js";

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

const { DISCORD_TOKEN = "", CHANNEL_IDS = "", HOST = "", PORT = "" } = process.env;

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

const channelIds = CHANNEL_IDS.split(",")
  .map((id) => id.trim())
  .filter(Boolean);

let previousPlayers: string[] | null = null;

async function sendToDiscord(message: string) {
  for (const channelId of channelIds) {
    try {
      const channel = await client.channels.fetch(channelId);

      if (!channel || !channel.isSendable()) {
        console.error(`Канал ${channelId} не найден или в него нельзя отправлять сообщения`);
        continue;
      }

      await channel.send(message);
    } catch (error) {
      console.error(`Ошибка отправки в канал ${channelId}:`, error);
    }
  }
}

async function checkServer() {
  try {
    const info = await query.info(HOST, Number(PORT), 5000);

    const players = await query.players(HOST, Number(PORT), 5000);
    console.log('players: ', players[0]);

    const currentPlayers: string[] = players.map((player) => player.name).filter((name: string) => name.trim().length > 0);

    // console.log(`[${new Date().toLocaleTimeString()}] Players: ${info.players}/${info.max_players}`);

    // console.log("Players:", currentPlayers);

    if (previousPlayers === null) {
      previousPlayers = currentPlayers;
      return;
    }

    const joinedPlayers = currentPlayers.filter((name) => !previousPlayers!.includes(name));

    const leftPlayers = previousPlayers.filter((name) => !currentPlayers.includes(name));

    previousPlayers = currentPlayers;

    for (const name of joinedPlayers) {
      await sendToDiscord(`🟢 **${name}** зашёл на сервер. Онлайн: **${info.players}/${info.max_players}**. Карта: **${info.map}**`);
    }

    for (const name of leftPlayers) {
      await sendToDiscord(`🔴 **${name}** зашёл на сервер. Онлайн: **${info.players}/${info.max_players}**. Карта: **${info.map}**`);
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

client.login(DISCORD_TOKEN);
