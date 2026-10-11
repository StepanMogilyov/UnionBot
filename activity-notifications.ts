import { Client, type EmbedBuilder } from "discord.js";
import { createEventStatusEmbed, createOnlinePlayersButtonRow, createPlayerEventEmbed } from "./discord-messages";
import { EventStatusStore } from "./event-status";
import type { PlayerEventBatchMessage, ServerRefreshResult, ServerSnapshot } from "./server-monitor";

export interface EventNotificationResult {
  sent: number;
  failed: number;
}

export class ActivityNotifications {
  private delivery: Promise<void> = Promise.resolve();

  constructor(
    private readonly client: Client,
    private readonly channelIds: string[],
    private readonly eventStatus: EventStatusStore,
    private readonly onError: (channelId: string, error: unknown) => void,
    private readonly refreshServer: () => Promise<ServerRefreshResult>,
  ) {}

  publish(event: PlayerEventBatchMessage) {
    return this.enqueue(() => this.sendToChannels(createPlayerEventEmbed(event, this.eventStatus.closed)));
  }

  setEventClosed(closed: boolean): Promise<EventNotificationResult> {
    return this.enqueue(async () => {
      // Save first so a restart and all subsequent notices retain the requested status.
      await this.eventStatus.setClosed(closed);
      let snapshot: ServerSnapshot | undefined;
      if (closed) {
        try {
          const result = await this.refreshServer();
          if (result.status === "online") snapshot = result.snapshot;
        } catch (error) {
          console.error("Не удалось получить данные сервера для уведомления об ивенте:", error);
        }
      }
      return this.sendToChannels(createEventStatusEmbed(closed, snapshot));
    });
  }

  private async fetchChannel(channelId: string) {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel?.isSendable()) throw new Error("Канал не найден или в него нельзя отправлять сообщения");
    return channel;
  }

  private async sendToChannels(embed: EmbedBuilder): Promise<EventNotificationResult> {
    const result = { sent: 0, failed: 0 };
    for (const channelId of this.channelIds) {
      try {
        const channel = await this.fetchChannel(channelId);
        await channel.send({ embeds: [embed], components: [createOnlinePlayersButtonRow()] });
        result.sent++;
      } catch (error) {
        result.failed++;
        this.onError(channelId, error);
      }
    }
    return result;
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    // Commands and new notices share an order, without blocking server polling or TAB.
    const result = this.delivery.then(work);
    this.delivery = result.then(() => {}, () => {});
    return result;
  }
}
