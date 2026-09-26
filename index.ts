const query = require("source-server-query");
require("dotenv").config();

import {
  Client,
  GatewayIntentBits,
} from "discord.js";

const {
  DISCORD_TOKEN = "",
  CHANNEL_IDS = "",
  HOST = "",
  PORT = "",
} = process.env;

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

const channelIds = CHANNEL_IDS
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

let previousPlayers: string[] | null = null;

async function sendToDiscord(message: string) {
  for (const channelId of channelIds) {
    try {
      const channel = await client.channels.fetch(channelId);

      if (!channel || !channel.isSendable()) {
        console.error(
          `Канал ${channelId} не найден или в него нельзя отправлять сообщения`
        );
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

    const currentPlayers: string[] = players
      .map((player: any) => player.name)
      .filter(
        (name: string) =>
          typeof name === "string" &&
          name.trim().length > 0
      );

    console.log(
      `[${new Date().toLocaleTimeString()}] Players: ${info.players}/${info.max_players}`
    );

    console.log("Players:", currentPlayers);

    if (previousPlayers === null) {
      previousPlayers = currentPlayers;
      return;
    }

    const joinedPlayers = currentPlayers.filter(
      (name) => !previousPlayers!.includes(name)
    );

    const leftPlayers = previousPlayers.filter(
      (name) => !currentPlayers.includes(name)
    );

    previousPlayers = currentPlayers;

    for (const name of joinedPlayers) {
      await sendToDiscord(
        `🟢 **${name}** зашёл на сервер. Онлайн: **${info.players}/${info.max_players}**`
      );
    }

    for (const name of leftPlayers) {
      await sendToDiscord(
        `🔴 **${name}** вышел с сервера. Онлайн: **${info.players}/${info.max_players}**`
      );
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