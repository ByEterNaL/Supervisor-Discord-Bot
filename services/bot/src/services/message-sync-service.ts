import {
  ChannelType,
  Client,
  Guild,
  GuildBasedChannel,
  GuildMember,
  Message,
  NewsChannel,
  PermissionFlagsBits,
  type TextChannel,
  type User
} from "discord.js";
import { formatInTimeZone } from "date-fns-tz";
import type { Logger } from "pino";
import type { Sql } from "postgres";

import type { MemberService } from "./member-service";
import type { ModerationService } from "./moderation-service";

const MESSAGE_HISTORY_TASK = "message_history";
const CHANNEL_BATCH_SIZE = 100;
const POLL_INTERVAL_MS = 15_000;
const BATCH_DELAY_MS = 350;

type SyncableChannel = TextChannel | NewsChannel;

interface SyncJobRow {
  guild_id: string;
  status: "requested" | "running" | "completed" | "failed";
  cutoff_at: Date | null;
}

interface SyncChannelRow {
  channel_id: string;
  channel_name: string;
  status: "pending" | "running" | "completed" | "skipped" | "failed";
  next_before_message_id: string | null;
}

interface BatchAuthor {
  user: User;
  member: GuildMember | null;
}

function isSyncableChannel(channel: GuildBasedChannel | null | undefined): channel is SyncableChannel {
  return (
    channel?.type === ChannelType.GuildText || channel?.type === ChannelType.GuildAnnouncement
  );
}

function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class MessageSyncService {
  private runningGuildId: string | null = null;

  constructor(
    private readonly sql: Sql,
    private readonly logger: Logger,
    private readonly memberService: MemberService,
    private readonly moderationService: ModerationService,
    private readonly timezone: string
  ) {}

  start(client: Client) {
    void this.poll(client);
    setInterval(() => {
      void this.poll(client);
    }, POLL_INTERVAL_MS).unref();
  }

  async trackServerMessage(message: Message) {
    if (!message.inGuild() || message.author.bot) {
      return;
    }

    await this.incrementMessageCount(
      message.guildId,
      message.author.id,
      formatInTimeZone(message.createdAt, this.timezone, "yyyy-MM-dd"),
      1
    );
  }

  private async poll(client: Client) {
    if (this.runningGuildId) {
      return;
    }

    const [job] = await this.sql<SyncJobRow[]>`
      SELECT guild_id, status, cutoff_at
      FROM guild_sync_jobs
      WHERE task_type = ${MESSAGE_HISTORY_TASK}
        AND status IN ('requested', 'running')
      ORDER BY
        CASE status WHEN 'running' THEN 0 ELSE 1 END,
        requested_at ASC
      LIMIT 1
    `;

    if (!job) {
      return;
    }

    this.runningGuildId = job.guild_id;

    try {
      const guild =
        client.guilds.cache.get(job.guild_id) ??
        (await client.guilds.fetch(job.guild_id).then((value) => value.fetch()).catch(() => null));

      if (!guild) {
        await this.failJob(job.guild_id, "Sunucu bulunamadi veya bot sunucuya erisemiyor.");
        return;
      }

      await this.runMessageHistorySync(guild);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Bilinmeyen senkron hatasi.";
      await this.failJob(job.guild_id, message);
      this.logger.error({ error, guildId: job.guild_id }, "Message history sync failed.");
    } finally {
      this.runningGuildId = null;
    }
  }

  private async runMessageHistorySync(guild: Guild) {
    const cutoffAt = await this.markJobRunning(guild.id);
    await this.seedSyncChannels(guild);
    await this.refreshJobProgress(guild.id, null);

    try {
      await this.moderationService.backfillAvailableAuditLogs(guild);
    } catch (error) {
      this.logger.warn({ error, guildId: guild.id }, "Audit log backfill failed during sync.");
    }

    while (true) {
      const [nextChannel] = await this.sql<SyncChannelRow[]>`
        SELECT channel_id, channel_name, status, next_before_message_id
        FROM guild_message_sync_channels
        WHERE guild_id = ${guild.id}
          AND status IN ('pending', 'running')
        ORDER BY
          CASE status WHEN 'running' THEN 0 ELSE 1 END,
          updated_at ASC
        LIMIT 1
      `;

      if (!nextChannel) {
        break;
      }

      const channel =
        guild.channels.cache.get(nextChannel.channel_id) ??
        (await guild.channels.fetch(nextChannel.channel_id).catch(() => null));

      if (!isSyncableChannel(channel)) {
        await this.markChannelSkipped(
          guild.id,
          nextChannel.channel_id,
          "Kanal bulunamadi veya gecmis okunabilir text kanali degil."
        );
        await this.refreshJobProgress(guild.id, null);
        continue;
      }

      const syncChannel: SyncableChannel = channel;

      const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
      const canRead = me?.permissionsIn(syncChannel).has([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ReadMessageHistory
      ]);

      if (!canRead) {
        await this.markChannelSkipped(
          guild.id,
          syncChannel.id,
          "Bot bu kanalda gecmis okuma yetkisine sahip degil."
        );
        await this.refreshJobProgress(guild.id, null);
        continue;
      }

      await this.sql`
        UPDATE guild_message_sync_channels
        SET status = 'running',
            last_error = NULL
        WHERE guild_id = ${guild.id}
          AND channel_id = ${syncChannel.id}
      `;
      await this.refreshJobProgress(guild.id, syncChannel);

      try {
        const rawMessages = nextChannel.next_before_message_id
          ? await syncChannel.messages.fetch({
              limit: CHANNEL_BATCH_SIZE,
              before: nextChannel.next_before_message_id
            })
          : await syncChannel.messages.fetch({ limit: CHANNEL_BATCH_SIZE });

        const messages = [...rawMessages.values()];
        const oldestMessage = messages.at(-1) ?? null;

        if (!messages.length) {
          await this.markChannelCompleted(guild.id, syncChannel.id);
          await this.refreshJobProgress(guild.id, null);
          continue;
        }

        const aggregates = new Map<string, { userId: string; bucketDate: string; count: number }>();
        const authors = new Map<string, BatchAuthor>();

        let nonBotMessageCount = 0;

        for (const message of messages) {
          if (message.author.bot) {
            continue;
          }
          
          nonBotMessageCount++;

          if (message.createdAt >= cutoffAt) {
            continue;
          }

          const bucketDate = formatInTimeZone(message.createdAt, this.timezone, "yyyy-MM-dd");
          const aggregateKey = `${message.author.id}:${bucketDate}`;
          const current = aggregates.get(aggregateKey);

          if (current) {
            current.count += 1;
          } else {
            aggregates.set(aggregateKey, {
              userId: message.author.id,
              bucketDate,
              count: 1
            });
          }

          const resolvedMember =
            message.member ??
            guild.members.cache.get(message.author.id) ??
            null;

          if (!authors.has(message.author.id)) {
            authors.set(message.author.id, {
              user: message.author,
              member: resolvedMember
            });
          }
        }

        await this.persistBatch(guild, authors, aggregates);

        await this.sql`
          UPDATE guild_message_sync_channels
          SET
            next_before_message_id = ${oldestMessage?.id ?? null},
            scanned_messages = scanned_messages + ${nonBotMessageCount},
            last_message_at = ${oldestMessage?.createdAt ?? null},
            last_error = NULL
          WHERE guild_id = ${guild.id}
            AND channel_id = ${syncChannel.id}
        `;

        if (messages.length < CHANNEL_BATCH_SIZE) {
          await this.markChannelCompleted(guild.id, syncChannel.id);
        }

        await this.refreshJobProgress(guild.id, syncChannel);
        await sleep(BATCH_DELAY_MS);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Kanal mesajlari cekilemedi.";
        await this.markChannelFailed(guild.id, syncChannel.id, message);
        await this.refreshJobProgress(guild.id, null);
        this.logger.warn(
          { error, guildId: guild.id, channelId: syncChannel.id },
          "Channel message sync failed."
        );
      }
    }

    const [failedCounts] = await this.sql<{ failed_count: number }[]>`
      SELECT COUNT(*)::int AS failed_count
      FROM guild_message_sync_channels
      WHERE guild_id = ${guild.id}
        AND status = 'failed'
    `;

    if ((failedCounts?.failed_count ?? 0) > 0) {
      await this.failJob(guild.id, "Bazi kanallar senkronize edilemedi. Tekrar deneyebilirsin.");
      return;
    }

    await this.sql`
      UPDATE guild_sync_jobs
      SET
        status = 'completed',
        completed_at = NOW(),
        current_channel_id = NULL,
        current_channel_name = NULL,
        last_error = NULL
      WHERE guild_id = ${guild.id}
        AND task_type = ${MESSAGE_HISTORY_TASK}
    `;
    await this.refreshJobProgress(guild.id, null);
  }

  private async markJobRunning(guildId: string) {
    const [job] = await this.sql<{ cutoff_at: Date }[]>`
      UPDATE guild_sync_jobs
      SET
        status = 'running',
        started_at = COALESCE(started_at, NOW()),
        cutoff_at = COALESCE(cutoff_at, NOW()),
        completed_at = NULL,
        last_error = NULL
      WHERE guild_id = ${guildId}
        AND task_type = ${MESSAGE_HISTORY_TASK}
      RETURNING cutoff_at
    `;

    return job?.cutoff_at ?? new Date();
  }

  private async failJob(guildId: string, errorMessage: string) {
    await this.sql`
      UPDATE guild_sync_jobs
      SET
        status = 'failed',
        current_channel_id = NULL,
        current_channel_name = NULL,
        last_error = ${errorMessage}
      WHERE guild_id = ${guildId}
        AND task_type = ${MESSAGE_HISTORY_TASK}
    `;
  }

  private async seedSyncChannels(guild: Guild) {
    const channels = await guild.channels.fetch();

    for (const channel of channels.values()) {
      if (!isSyncableChannel(channel)) {
        continue;
      }

      await this.sql`
        INSERT INTO guild_message_sync_channels (
          guild_id,
          channel_id,
          channel_name,
          status
        )
        VALUES (${guild.id}, ${channel.id}, ${channel.name}, 'pending')
        ON CONFLICT (guild_id, channel_id)
        DO UPDATE SET channel_name = EXCLUDED.channel_name
      `;
    }
  }

  private async refreshJobProgress(guildId: string, currentChannel: SyncableChannel | null) {
    const [progress] = await this.sql<{
      total_channels: number;
      completed_channels: number;
      scanned_messages: string;
    }[]>`
      SELECT
        COUNT(*)::int AS total_channels,
        COUNT(*) FILTER (WHERE status IN ('completed', 'skipped'))::int AS completed_channels,
        COALESCE(SUM(scanned_messages), 0)::bigint::text AS scanned_messages
      FROM guild_message_sync_channels
      WHERE guild_id = ${guildId}
    `;

    await this.sql`
      UPDATE guild_sync_jobs
      SET
        channels_total = ${progress?.total_channels ?? 0},
        channels_completed = ${progress?.completed_channels ?? 0},
        scanned_messages = ${progress?.scanned_messages ?? "0"}::bigint,
        current_channel_id = ${currentChannel?.id ?? null},
        current_channel_name = ${currentChannel?.name ?? null}
      WHERE guild_id = ${guildId}
        AND task_type = ${MESSAGE_HISTORY_TASK}
    `;
  }

  private async markChannelCompleted(guildId: string, channelId: string) {
    await this.sql`
      UPDATE guild_message_sync_channels
      SET
        status = 'completed',
        last_error = NULL
      WHERE guild_id = ${guildId}
        AND channel_id = ${channelId}
    `;
  }

  private async markChannelSkipped(guildId: string, channelId: string, errorMessage: string) {
    await this.sql`
      UPDATE guild_message_sync_channels
      SET
        status = 'skipped',
        last_error = ${errorMessage}
      WHERE guild_id = ${guildId}
        AND channel_id = ${channelId}
    `;
  }

  private async markChannelFailed(guildId: string, channelId: string, errorMessage: string) {
    await this.sql`
      UPDATE guild_message_sync_channels
      SET
        status = 'failed',
        last_error = ${errorMessage}
      WHERE guild_id = ${guildId}
        AND channel_id = ${channelId}
    `;
  }

  private async persistBatch(
    guild: Guild,
    authors: Map<string, BatchAuthor>,
    aggregates: Map<string, { userId: string; bucketDate: string; count: number }>
  ) {
    for (const author of authors.values()) {
      if (author.member) {
        await this.memberService.syncMember(author.member);
        continue;
      }

      await this.memberService.syncUserShell(guild.id, author.user, "user");
    }

    for (const aggregate of aggregates.values()) {
      await this.incrementMessageCount(
        guild.id,
        aggregate.userId,
        aggregate.bucketDate,
        aggregate.count
      );
    }
  }

  private async incrementMessageCount(
    guildId: string,
    userId: string,
    bucketDate: string,
    count: number
  ) {
    await this.sql`
      INSERT INTO guild_message_daily_stats (
        guild_id,
        user_id,
        bucket_date,
        message_count
      )
      VALUES (${guildId}, ${userId}, ${bucketDate}, ${count})
      ON CONFLICT (guild_id, user_id, bucket_date)
      DO UPDATE SET
        message_count = guild_message_daily_stats.message_count + EXCLUDED.message_count,
        updated_at = NOW()
    `;
  }
}
