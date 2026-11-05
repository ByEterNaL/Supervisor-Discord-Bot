import { ChatInputCommandInteraction, GuildMember, Interaction } from "discord.js";

import { createCommandEmbed } from "../lib/command-ui";
import {
  helpCommandName,
  helpCommandSections,
  moderationCommandNames
} from "../lib/register-commands";
import type { BotContext } from "../types";

const supervisorCooldowns = new Map<string, number>();

function toMinutes(seconds: number) {
  if (seconds <= 0) {
    return 0;
  }

  return Math.ceil(seconds / 60);
}

async function handleSupervisorCommand(
  interaction: ChatInputCommandInteraction<"cached">,
  context: BotContext
) {
  const subcommand = interaction.options.getSubcommand();
  if (subcommand === "refresh-config") {
    const member = interaction.member;
    if (!(member instanceof GuildMember) || !context.memberService.canManageConfig(member)) {
      await interaction.reply({
        content: "Config yenileme yetkin yok.",
        ephemeral: true
      });
      return;
    }

    await context.configStore.refresh();
    await context.memberService.syncRoleCatalog(interaction.guild);
    await interaction.reply({
      embeds: [
        createCommandEmbed({
          tone: "success",
          title: "Config yenilendi",
          description: "Veritabanındaki ayarlar belleğe tekrar yüklendi.",
          authorName: interaction.user.displayName ?? interaction.user.username,
          authorIcon: interaction.user.displayAvatarURL()
        })
      ],
      ephemeral: true
    });
    return;
  }

  const now = Date.now();
  const last = supervisorCooldowns.get(interaction.user.id) ?? 0;
  if (now - last < 15000) {
    await interaction.reply({
      content: "Bu komutu çok sık kullanıyorsunuz. Lütfen 15 saniye bekleyin.",
      ephemeral: true
    });
    return;
  }
  supervisorCooldowns.set(interaction.user.id, now);

  const target = interaction.options.getUser("uye") ?? interaction.user;

  await interaction.deferReply({ ephemeral: true });

  const [stats] = await context.sql<{
    voice_active_seconds: number;
    ticket_claim_count: number;
    ticket_message_count: number;
    moderation_ban_count: number;
    moderation_kick_count: number;
    moderation_timeout_count: number;
    server_message_count: string;
    total_message_count: string;
  }[]>`
    WITH period_bounds AS (
      SELECT
        (date_trunc('day', timezone(${context.env.timezone}, now())) AT TIME ZONE ${context.env.timezone}) AS start_at,
        LEAST(
          NOW(),
          ((date_trunc('day', timezone(${context.env.timezone}, now())) + INTERVAL '1 day') AT TIME ZONE ${context.env.timezone})
        ) AS end_at
    ),
    voice_presence AS (
      SELECT
        source.guild_id,
        source.user_id,
        SUM(source.duration_seconds)::int AS total_seconds
      FROM (
        SELECT
          segment.guild_id,
          segment.user_id,
          GREATEST(
            EXTRACT(EPOCH FROM (
              LEAST(segment.ended_at, bounds.end_at) - GREATEST(segment.started_at, bounds.start_at)
            )),
            0
          )::int AS duration_seconds
        FROM voice_active_segments AS segment
        CROSS JOIN period_bounds AS bounds
        WHERE segment.ended_at > bounds.start_at
          AND segment.started_at < bounds.end_at
        UNION ALL
        SELECT
          live.guild_id,
          live.user_id,
          GREATEST(
            EXTRACT(EPOCH FROM (
              LEAST(bounds.end_at, live.last_confirmed_at + INTERVAL '90 seconds')
              - GREATEST(live.started_at, bounds.start_at)
            )),
            0
          )::int AS duration_seconds
        FROM live_presence_sessions AS live
        CROSS JOIN period_bounds AS bounds
        WHERE live.session_type = 'voice'
          AND live.started_at < bounds.end_at
      ) AS source
      WHERE source.duration_seconds > 0
      GROUP BY source.guild_id, source.user_id
    )
    SELECT
      COALESCE(voice_presence.total_seconds, 0) AS voice_active_seconds,
      COALESCE(metrics.ticket_claim_count, 0) AS ticket_claim_count,
      COALESCE(metrics.ticket_message_count, 0) AS ticket_message_count,
      COALESCE(moderation_metrics.moderation_ban_count, 0) AS moderation_ban_count,
      COALESCE(moderation_metrics.moderation_kick_count, 0) AS moderation_kick_count,
      COALESCE(moderation_metrics.moderation_timeout_count, 0) AS moderation_timeout_count,
      COALESCE(day_messages.server_message_count, 0)::bigint::text AS server_message_count,
      COALESCE(total_messages.total_message_count, 0)::bigint::text AS total_message_count
    FROM (
      SELECT ${interaction.guildId}::bigint AS guild_id, ${target.id}::bigint AS user_id
    ) AS scope
    LEFT JOIN member_daily_metrics AS metrics
      ON metrics.guild_id = scope.guild_id
     AND metrics.user_id = scope.user_id
     AND metrics.bucket_date = (timezone(${context.env.timezone}, now()))::date
    LEFT JOIN (
      SELECT
        guild_id,
        actor_id AS user_id,
        COUNT(*) FILTER (WHERE action_type = 'ban')::int AS moderation_ban_count,
        COUNT(*) FILTER (WHERE action_type = 'kick')::int AS moderation_kick_count,
        COUNT(*) FILTER (WHERE action_type = 'timeout')::int AS moderation_timeout_count
      FROM moderation_actions
      WHERE created_at >= (date_trunc('day', timezone(${context.env.timezone}, now())) AT TIME ZONE ${context.env.timezone})
        AND created_at < LEAST(
          NOW(),
          ((date_trunc('day', timezone(${context.env.timezone}, now())) + INTERVAL '1 day') AT TIME ZONE ${context.env.timezone})
        )
      GROUP BY guild_id, actor_id
    ) AS moderation_metrics
      ON moderation_metrics.guild_id = scope.guild_id
     AND moderation_metrics.user_id = scope.user_id
    LEFT JOIN voice_presence
      ON voice_presence.guild_id = scope.guild_id
     AND voice_presence.user_id = scope.user_id
    LEFT JOIN (
      SELECT guild_id, user_id, SUM(message_count)::bigint AS server_message_count
      FROM guild_message_daily_stats
      WHERE bucket_date = (timezone(${context.env.timezone}, now()))::date
      GROUP BY guild_id, user_id
    ) AS day_messages
      ON day_messages.guild_id = scope.guild_id
     AND day_messages.user_id = scope.user_id
    LEFT JOIN (
      SELECT guild_id, user_id, SUM(message_count)::bigint AS total_message_count
      FROM guild_message_daily_stats
      GROUP BY guild_id, user_id
    ) AS total_messages
      ON total_messages.guild_id = scope.guild_id
     AND total_messages.user_id = scope.user_id
    LIMIT 1
  `;

  await interaction.editReply({
    embeds: [
      createCommandEmbed({
        tone: "neutral",
        title: `${target.username} • Günlük Supervisor Özeti`,
        description: "Bugünkü yoğunluk ve moderasyon çıktıları tek görünümde toplandı.",
        authorName: `${interaction.user.displayName ?? interaction.user.username} görüntülüyor`,
        authorIcon: interaction.user.displayAvatarURL(),
        thumbnail: target.displayAvatarURL(),
        fields: [
          { name: "Aktif Ses", value: `${toMinutes(stats?.voice_active_seconds ?? 0)} dk`, inline: true },
          { name: "Günlük Mesaj", value: String(stats?.server_message_count ?? "0"), inline: true },
          { name: "Toplam Mesaj", value: String(stats?.total_message_count ?? "0"), inline: true },
          { name: "Claim", value: String(stats?.ticket_claim_count ?? 0), inline: true },
          { name: "Ticket Mesaj", value: String(stats?.ticket_message_count ?? 0), inline: true },
          {
            name: "Ban / Kick / Timeout",
            value: `${stats?.moderation_ban_count ?? 0} / ${stats?.moderation_kick_count ?? 0} / ${stats?.moderation_timeout_count ?? 0}`,
            inline: false
          }
        ],
        footer: "Supervisor Discord Bot • Günlük Özet"
      })
    ]
  });
}

async function handleHelpCommand(interaction: ChatInputCommandInteraction<"cached">) {
  const member = interaction.member;
  const memberName =
    member instanceof GuildMember
      ? member.displayName
      : interaction.user.displayName ?? interaction.user.username;

  const embed = createCommandEmbed({
    tone: "accent",
    title: "Supervisor Discord Bot Komut Rehberi",
    description:
      "Aktif slash komutlar aşağıda kategori bazlı akışta listelenir. `/` yazdıktan sonra hızlı önerilerden devam edebilirsin.",
    authorName: `${memberName} için hızlı rehber`,
    authorIcon: interaction.user.displayAvatarURL(),
    thumbnail: interaction.guild.iconURL(),
    footer: "İpucu: Eski uyumluluk için /mod ban ve /mod kick komutları da çalışır."
  });

  for (const section of helpCommandSections) {
    embed.addFields({
      name: `${section.icon} ${section.title}`,
      value: section.lines.join("\n"),
      inline: false
    });
  }

  await interaction.reply({
    embeds: [embed],
    ephemeral: true
  });
}

export async function handleInteraction(interaction: Interaction, context: BotContext) {
  if (interaction.isChatInputCommand() && interaction.inCachedGuild()) {
    if (interaction.commandName === helpCommandName) {
      await handleHelpCommand(interaction);
      return;
    }

    if (interaction.commandName === "ticket") {
      const subcommand = interaction.options.getSubcommand();
      if (subcommand === "create") {
        await context.ticketService.createPanel(interaction);
        return;
      }
      if (subcommand === "claim") {
        await context.ticketService.claim(interaction);
        return;
      }
    }

    if (interaction.commandName === "mod" || moderationCommandNames.has(interaction.commandName)) {
      await context.moderationCommandService.handleCommand(interaction);
      return;
    }

    if (interaction.commandName === "supervisor") {
      await handleSupervisorCommand(interaction, context);
      return;
    }

    if (interaction.commandName === "moderson") {
      await context.modersonService.handleCommand(interaction);
      return;
    }

    if (interaction.commandName === "rank") {
      await context.rankService.handleRankCommand(interaction);
      return;
    }

    if (interaction.commandName === "leaderboard") {
      await context.rankService.handleLeaderboardCommand(interaction);
    }

    return;
  }

  if (interaction.isButton() && interaction.inCachedGuild()) {
    if (interaction.customId.startsWith("modcase:")) {
      await context.moderationCommandService.handleButton(interaction);
      return;
    }

    if (interaction.customId === "ticket-open") {
      await context.ticketService.startOpenFlow(interaction);
      return;
    }

    if (interaction.customId.startsWith("ticket-journey:")) {
      await context.ticketService.handleJourneyChoice(interaction);
      return;
    }

    if (interaction.customId.startsWith("ticket-close:")) {
      await context.ticketService.handleCloseButton(interaction);
      return;
    }

    if (interaction.customId.startsWith("ticket-archive:")) {
      await context.ticketService.handleArchiveButton(interaction);
      return;
    }

    if (interaction.customId.startsWith("ticket-call:")) {
      await context.ticketService.handleCallButton(interaction);
    }

    return;
  }

  if (interaction.isModalSubmit() && interaction.inCachedGuild()) {
    if (interaction.customId.startsWith("modreason:")) {
      await context.moderationCommandService.handleModal(interaction);
      return;
    }

    if (interaction.customId === "ticket-onboarding-modal") {
      await context.ticketService.handleOnboardingModal(interaction);
    }
  }
}
