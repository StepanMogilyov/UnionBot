const query = require("source-server-query");
require("dotenv").config();

import axios from "axios";

const {WEBHOOK_URL = "", HOST = "", PORT = ""} = process.env;

let previousPlayers: number | null = null;

async function checkServer() {
  try {
    const info = await query.info(HOST, PORT, 5000);

    const currentPlayers = info.players;

    console.log(`[${new Date().toLocaleTimeString()}] Players: ${currentPlayers}/${info.max_players}`);

    if (previousPlayers === null) {
      previousPlayers = currentPlayers;
      return;
    }

    if (currentPlayers === previousPlayers) {
      return;
    }

    const difference = currentPlayers - previousPlayers;

    if (difference > 0) {
      await axios.post(WEBHOOK_URL, {
        content: `🟢 Игрок зашёл на сервер. Онлайн: **${currentPlayers}/${info.max_players}**`,
      });
    } else {
      await axios.post(WEBHOOK_URL, {
        content: `🔴 Игрок вышел с сервера. Онлайн: **${currentPlayers}/${info.max_players}**`,
      });
    }

    previousPlayers = currentPlayers;
  } catch (error) {
    console.error("Ошибка запроса:", error);
  }
}

checkServer();

setInterval(checkServer, 60_000);
