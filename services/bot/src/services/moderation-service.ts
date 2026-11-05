import {
  AuditLogEvent,
  ChatInputCommandInteraction,
  GuildMember,
  Message,
  type Guild,
  type GuildAuditLogsEntry
} from "discord.js";
import type { Logger } from "pino";
import type { Sql } from "postgres";

import type { SupervisorConfig } from "../../../../packages/shared/src";
import type { MemberService } from "./member-service";

export class ModerationService {
  constructor(
    private readonly sql: Sql,
    private readonly logger: Logger,
    private readonly memberService: MemberService,
    private readonly getConfig: () => SupervisorConfig
  ) {}

  async handleBan(interaction: ChatInputCommandInteraction<"cached">) {
    const member = interaction.member;
    if (!(member instanceof GuildMember) || !this.memberService.canBan(member)) {
      await interaction.reply({
        content: "Ban komutunu kullanma yetkin yok.",
        ephemeral: true
      });
      return;
    }

    const target = interaction.options.getUser("uye", true);
    const reason = interaction.options.getString("sebep") ?? "Sebep belirtilmedi";

    await interaction.guild.members.ban(target, { reason });
    await this.memberService.syncMember(member);
    await this.memberService.syncUserShell(interaction.guildId, target, "user");

    await this.sql`
      INSERT INTO moderation_actions (
        guild_id,
        action_type,
        target_id,
        actor_id,
        reason,
        source
      )
      VALUES (${interaction.guildId}, 'ban', ${target.id}, ${member.id}, ${reason}, 'bot')
    `;

    await interaction.reply({
      content: `${target.tag} banlandi.`
    });
  }

  async handleKick(interaction: ChatInputCommandInteraction<"cached">) {
    const member = interaction.member;
    if (!(member instanceof GuildMember) || !this.memberService.canKick(member)) {
      await interaction.reply({
        content: "Kick komutunu kullanma yetkin yok.",
        ephemeral: true
      });
      return;
    }

    const target = interaction.options.getUser("uye", true);
    const reason = interaction.options.getString("sebep") ?? "Sebep belirtilmedi";
    const targetMember = await interaction.guild.members.fetch(target.id);

    await targetMember.kick(reason);
    await this.memberService.syncMember(member);
    await this.memberService.syncUserShell(interaction.guildId, target, "user");

    await this.sql`
      INSERT INTO moderation_actions (
        guild_id,
        action_type,
        target_id,
        actor_id,
        reason,
        source
      )
      VALUES (${interaction.guildId}, 'kick', ${target.id}, ${member.id}, ${reason}, 'bot')
    `;

    await interaction.reply({
      content: `${target.tag} sunucudan atildi.`
    });
  }

  async handleChannelAnalysisMessage(message: Message) {
    if (!message.inGuild() || message.author.bot || !message.member) {
      return;
    }

    const rule = this.getConfig().channelAnalysis.rules.find(
      (item) => item.channelId === message.channelId
    );
    if (!rule) {
      return;
    }

    const maxMessagesPerHour = Number(rule.maxMessagesPerHour);
    const timeoutMinutes = Number(rule.timeoutMinutes);
    if (
      !Number.isInteger(maxMessagesPerHour) ||
      !Number.isInteger(timeoutMinutes) ||
      maxMessagesPerHour <= 0 ||
      timeoutMinutes <= 0
    ) {
      return;
    }

    const member = message.member;
    const cutoff = new Date(message.createdTimestamp - 60 * 60 * 1000);
    const pruneBefore = new Date(message.createdTimestamp - 2 * 60 * 60 * 1000);

    await this.sql`
      DELETE FROM channel_analysis_message_events
      WHERE guild_id = ${message.guildId}
        AND channel_id = ${message.channelId}
        AND created_at < ${pruneBefore}
    `;

    await this.sql`
      INSERT INTO channel_analysis_message_events (
        message_id,
        guild_id,
        channel_id,
        user_id,
        created_at
      )
      VALUES (
        ${message.id},
        ${message.guildId},
        ${message.channelId},
        ${message.author.id},
        ${message.createdAt}
      )
      ON CONFLICT (message_id) DO NOTHING
    `;

    const [countRow] = await this.sql<{ message_count: number }[]>`
      SELECT COUNT(*)::int AS message_count
      FROM channel_analysis_message_events
      WHERE guild_id = ${message.guildId}
        AND channel_id = ${message.channelId}
        AND user_id = ${message.author.id}
        AND created_at >= ${cutoff}
    `;

    const messageCount = countRow?.message_count ?? 0;
    if (messageCount <= maxMessagesPerHour) {
      return;
    }

    if (
      member.communicationDisabledUntilTimestamp &&
      member.communicationDisabledUntilTimestamp > Date.now()
    ) {
      return;
    }

    const channelName =
      "name" in message.channel && typeof message.channel.name === "string"
        ? message.channel.name
        : message.channelId;

    if (!member.moderatable) {
      const blockedReason =
        message.guild.ownerId === message.author.id
          ? "Sunucu sahibine timeout uygulanamaz."
          : "Rol hiyerarşisi nedeniyle bu üyeye timeout uygulanamıyor.";

      await this.recordChannelAnalysisBlockedAlert(
        message,
        member,
        channelName,
        messageCount,
        maxMessagesPerHour,
        blockedReason
      );
      this.logger.warn(
        {
          guildId: message.guildId,
          channelId: message.channelId,
          userId: message.author.id,
          blockedReason
        },
        "Channel analysis timeout skipped because member is not moderatable."
      );
      return;
    }

    const botUser = message.client.user;
    const actorId = botUser?.id ?? "0";

    const [recentAction] = await this.sql<{ id: number }[]>`
      SELECT id
      FROM moderation_actions
      WHERE guild_id = ${message.guildId}
        AND action_type = 'timeout'
        AND target_id = ${message.author.id}
        AND actor_id = ${actorId}
        AND source = 'bot'
        AND reason LIKE 'Kanal Analizi:%'
        AND created_at >= NOW() - INTERVAL '10 minutes'
      LIMIT 1
    `;
    if (recentAction) {
      return;
    }
    const reason = `Kanal Analizi: #${channelName} kanalında son 1 saatte ${messageCount} mesaj gönderildi (eşik: ${maxMessagesPerHour}).`;

    await member.timeout(timeoutMinutes * 60 * 1000, reason);

    if (botUser) {
      await this.memberService.syncUserShell(message.guildId, botUser, "user");
    }
    await this.memberService.syncMember(member);

    await this.sql`
      INSERT INTO moderation_actions (
        guild_id,
        action_type,
        target_id,
        actor_id,
        reason,
        source
      )
      VALUES (
        ${message.guildId},
        'timeout',
        ${message.author.id},
        ${actorId},
        ${reason},
        'bot'
      )
    `;
  }

  private async recordChannelAnalysisBlockedAlert(
    message: Message,
    member: GuildMember,
    channelName: string,
    messageCount: number,
    threshold: number,
    blockedReason: string
  ) {
    const [recentAlert] = await this.sql<{ id: number }[]>`
      SELECT id
      FROM alerts
      WHERE guild_id = ${message.guildId}
        AND alert_type = 'channel_analysis_blocked'
        AND member_id = ${message.author.id}
        AND payload ->> 'channelId' = ${message.channelId}
        AND created_at >= NOW() - INTERVAL '10 minutes'
      LIMIT 1
    `;

    if (recentAlert) {
      return;
    }

    await this.sql`
      INSERT INTO alerts (
        guild_id,
        alert_type,
        severity,
        member_id,
        payload
      )
      VALUES (
        ${message.guildId},
        'channel_analysis_blocked',
        'warning',
        ${message.author.id},
        ${JSON.stringify({
          channelId: message.channelId,
          channelName,
          userId: message.author.id,
          userName: member.displayName,
          messageCount,
          threshold,
          blockedReason
        })}::jsonb
      )
    `;
  }

  async pollAuditLogs(guild: Guild) {
    const _config = this.getConfig();
    await Promise.all([
      this.collectAuditEntries(guild, AuditLogEvent.MemberBanAdd, "ban"),
      this.collectAuditEntries(guild, AuditLogEvent.MemberKick, "kick"),
      this.collectTimeoutEntries(guild)
    ]);
  }

  async backfillAvailableAuditLogs(guild: Guild) {
    await Promise.all([
      this.collectAuditEntriesBackfill(guild, AuditLogEvent.MemberBanAdd, "ban"),
      this.collectAuditEntriesBackfill(guild, AuditLogEvent.MemberKick, "kick"),
      this.collectTimeoutEntriesBackfill(guild)
    ]);
  }

  private async collectAuditEntries(
    guild: Guild,
    eventType: AuditLogEvent.MemberBanAdd | AuditLogEvent.MemberKick,
    actionType: "ban" | "kick"
  ) {
    const audit = await guild.fetchAuditLogs({
      type: eventType,
      limit: 25
    });

    for (const [, entry] of audit.entries) {
      const actorId = entry.executorId;
      const targetId =
        entry.target && "id" in entry.target ? String(entry.target.id) : undefined;

      if (!actorId || !targetId) {
        continue;
      }

      const [recentBotAction] = await this.sql<{ id: number }[]>`
        SELECT id
        FROM moderation_actions
        WHERE guild_id = ${guild.id}
          AND action_type = ${actionType}
          AND actor_id = ${actorId}
          AND target_id = ${targetId}
          AND source = 'bot'
          AND created_at >= NOW() - INTERVAL '30 seconds'
        LIMIT 1
      `;

      if (recentBotAction) {
        continue;
      }

      await this.syncAuditActor(guild, actorId, entry.executor ?? null);
      await this.syncAuditTarget(guild, targetId);

      const createdAt = entry.createdAt ?? new Date();
      await this.sql`
        INSERT INTO moderation_actions (
          guild_id,
          action_type,
          target_id,
          actor_id,
          reason,
          source,
          external_action_id,
          created_at
        )
        VALUES (
          ${guild.id},
          ${actionType},
          ${targetId},
          ${actorId},
          ${entry.reason ?? null},
          'audit-log',
          ${entry.id},
          ${createdAt}
        )
        ON CONFLICT (external_action_id) DO NOTHING
      `;
    }

    this.logger.debug({ guildId: guild.id, actionType }, "Audit log polling finished.");
  }

  private async collectAuditEntriesBackfill(
    guild: Guild,
    eventType: AuditLogEvent.MemberBanAdd | AuditLogEvent.MemberKick,
    actionType: "ban" | "kick"
  ) {
    let before: string | undefined;

    for (let page = 0; page < 5; page += 1) {
      const audit = await guild.fetchAuditLogs({
        type: eventType,
        limit: 100,
        before
      });

      if (!audit.entries.size) {
        break;
      }

      for (const [, entry] of audit.entries) {
        const actorId = entry.executorId;
        const targetId =
          entry.target && "id" in entry.target ? String(entry.target.id) : undefined;

        if (!actorId || !targetId) {
          continue;
        }

        await this.syncAuditActor(guild, actorId, entry.executor ?? null);
        await this.syncAuditTarget(guild, targetId);

        const createdAt = entry.createdAt ?? new Date();
        await this.sql`
          INSERT INTO moderation_actions (
            guild_id,
            action_type,
            target_id,
            actor_id,
            reason,
            source,
            external_action_id,
            created_at
          )
          VALUES (
            ${guild.id},
            ${actionType},
            ${targetId},
            ${actorId},
            ${entry.reason ?? null},
            'audit-log',
            ${entry.id},
            ${createdAt}
          )
          ON CONFLICT (external_action_id) DO NOTHING
        `;
      }

      before = audit.entries.last()?.id;
      if (audit.entries.size < 100 || !before) {
        break;
      }
    }

    this.logger.info({ guildId: guild.id, actionType }, "Audit log backfill finished.");
  }

  private isTimeoutEntry(entry: GuildAuditLogsEntry): boolean {
    return entry.changes.some((change) => {
      if (change.key !== "communication_disabled_until") {
        return false;
      }

      return Boolean(change.new);
    });
  }

  private async collectTimeoutEntries(guild: Guild) {
    const audit = await guild.fetchAuditLogs({
      type: AuditLogEvent.MemberUpdate,
      limit: 50
    });

    for (const [, entry] of audit.entries) {
      if (!this.isTimeoutEntry(entry)) {
        continue;
      }

      const actorId = entry.executorId;
      const targetId =
        entry.target && "id" in entry.target ? String(entry.target.id) : undefined;

      if (!actorId || !targetId) {
        continue;
      }

      const [recentBotAction] = await this.sql<{ id: number }[]>`
        SELECT id
        FROM moderation_actions
        WHERE guild_id = ${guild.id}
          AND action_type = 'timeout'
          AND actor_id = ${actorId}
          AND target_id = ${targetId}
          AND source = 'bot'
          AND created_at >= NOW() - INTERVAL '30 seconds'
        LIMIT 1
      `;

      if (recentBotAction) {
        continue;
      }

      await this.syncAuditActor(guild, actorId, entry.executor ?? null);
      await this.syncAuditTarget(guild, targetId);

      const createdAt = entry.createdAt ?? new Date();
      await this.sql`
        INSERT INTO moderation_actions (
          guild_id,
          action_type,
          target_id,
          actor_id,
          reason,
          source,
          external_action_id,
          created_at
        )
        VALUES (
          ${guild.id},
          'timeout',
          ${targetId},
          ${actorId},
          ${entry.reason ?? null},
          'audit-log',
          ${entry.id},
          ${createdAt}
        )
        ON CONFLICT (external_action_id) DO NOTHING
      `;
    }

    this.logger.debug({ guildId: guild.id, actionType: "timeout" }, "Timeout audit log polling finished.");
  }

  private async collectTimeoutEntriesBackfill(guild: Guild) {
    let before: string | undefined;

    for (let page = 0; page < 5; page += 1) {
      const audit = await guild.fetchAuditLogs({
        type: AuditLogEvent.MemberUpdate,
        limit: 100,
        before
      });

      if (!audit.entries.size) {
        break;
      }

      for (const [, entry] of audit.entries) {
        if (!this.isTimeoutEntry(entry)) {
          continue;
        }

        const actorId = entry.executorId;
        const targetId =
          entry.target && "id" in entry.target ? String(entry.target.id) : undefined;

        if (!actorId || !targetId) {
          continue;
        }

        await this.syncAuditActor(guild, actorId, entry.executor ?? null);
        await this.syncAuditTarget(guild, targetId);

        const createdAt = entry.createdAt ?? new Date();
        await this.sql`
          INSERT INTO moderation_actions (
            guild_id,
            action_type,
            target_id,
            actor_id,
            reason,
            source,
            external_action_id,
            created_at
          )
          VALUES (
            ${guild.id},
            'timeout',
            ${targetId},
            ${actorId},
            ${entry.reason ?? null},
            'audit-log',
            ${entry.id},
            ${createdAt}
          )
          ON CONFLICT (external_action_id) DO NOTHING
        `;
      }

      before = audit.entries.last()?.id;
      if (audit.entries.size < 100 || !before) {
        break;
      }
    }

    this.logger.info({ guildId: guild.id, actionType: "timeout" }, "Timeout audit log backfill finished.");
  }

  private async syncAuditActor(guild: Guild, actorId: string, executor: GuildAuditLogsEntry["executor"] | null) {
    const actorMember = await guild.members.fetch(actorId).catch(() => null);

    if (actorMember) {
      await this.memberService.syncMember(actorMember);
      return;
    }

    if (executor) {
      await this.sql`
        INSERT INTO members (
          guild_id,
          user_id,
          username,
          display_name,
          avatar_url,
          member_type,
          first_seen_at,
          last_seen_at
        )
        VALUES (
          ${guild.id},
          ${executor.id},
          ${executor.username ?? "unknown-user"},
          ${executor.username ?? "unknown-user"},
          ${executor.displayAvatarURL()},
          'user',
          NOW(),
          NOW()
        )
        ON CONFLICT (guild_id, user_id)
        DO UPDATE SET
          username = EXCLUDED.username,
          display_name = EXCLUDED.display_name,
          avatar_url = EXCLUDED.avatar_url,
          last_seen_at = NOW()
      `;
    }
  }

  private async syncAuditTarget(guild: Guild, targetId: string) {
    const targetMember = await guild.members.fetch(targetId).catch(() => null);
    if (targetMember) {
      await this.memberService.syncMember(targetMember);
      return;
    }
    const targetUser = await guild.client.users.fetch(targetId).catch(() => null);
    if (targetUser) {
      await this.memberService.syncUserShell(guild.id, targetUser, "user");
    }
  }
}
