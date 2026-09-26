const query = require("source-server-query");
require("dotenv").config();

import axios from "axios";

const {WEBHOOK_URL = "", HOST = "", PORT = ""} = process.env;

let previousPlayers: string[] | null = null;

async function checkServer() {
  try {
    const info = await query.info(HOST, Number(PORT), 5000);

    const players = await query.players(HOST, Number(PORT), 5000);

    const currentPlayers: string[] = players.map((player: any) => player.name).filter((name: string) => typeof name === "string" && name.trim().length > 0);

    if (previousPlayers === null) {
      previousPlayers = currentPlayers;
      return;
    }

    const joinedPlayers = currentPlayers.filter((name) => !previousPlayers!.includes(name));

    const leftPlayers = previousPlayers.filter((name) => !currentPlayers.includes(name));

    previousPlayers = currentPlayers;

    for (const name of joinedPlayers) {
      await axios.post(WEBHOOK_URL, {
        content: `🟢 **${name}** зашёл на сервер. Онлайн: **${info.players}/${info.max_players}**`,
      });
    }

    for (const name of leftPlayers) {
      await axios.post(WEBHOOK_URL, {
        content: `🔴 **${name}** вышел с сервера. Онлайн: **${info.players}/${info.max_players}**`,
      });
    }
  } catch (error) {
    console.error("Ошибка запроса:", error);
  }
}

checkServer();

setInterval(checkServer, 60_000);