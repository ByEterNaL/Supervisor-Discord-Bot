import {
  AttachmentBuilder,
  ChannelType,
  ChatInputCommandInteraction,
  Guild,
  GuildMember,
  Message
} from "discord.js";
import type { Logger } from "pino";
import type { Sql } from "postgres";

import {
  applyRankXp,
  rankProgress,
  rankTypeLabel,
  resolveRewardRoleIds,
  type SupervisorConfig
} from "../../../../packages/shared/src";
import { compactXp, createCommandEmbed, progressBar } from "../lib/command-ui";
import { renderLeaderboardCard, renderRankCard } from "../lib/rank-graphics";
import type { MemberService } from "./member-service";

interface RankTextStateRow {
  last_eligible_at: Date | null;
  recent_contents: unknown;
  hour_window_started_at: Date | null;
  hour_message_count: number;
}

interface RankProfileSummaryRow {
  user_id: string;
  display_name: string | null;
  member_type: "staff" | "user" | null;
  avatar_url: string | null;
  voice_xp: number | null;
  text_xp: number | null;
  voice_level: number | null;
  text_level: number | null;
}

interface LeaderboardRow {
  user_id: string;
  display_name: string | null;
  avatar_url: string | null;
  xp_value: number;
  level_value: number;
  position: number;
}

interface RankPositionRow {
  voice_rank: number;
  text_rank: number;
}

interface PendingLevelEventRow {
  id: string;
  user_id: string;
  xp_type: "voice" | "text";
  level_after: number;
  source_type: string;
  role_sync_processed_at: Date | null;
  announcement_processed_at: Date | null;
}

interface RewardSyncJobRow {
  status: "pending" | "running" | "completed" | "failed";
}

interface RewardSyncProfileRow {
  user_id: string;
  voice_level: number;
  text_level: number;
}

interface RecentContentItem {
  content: string;
  at: string;
}

export class RankService {
  constructor(
    private readonly sql: Sql,
    private readonly logger: Logger,
    private readonly memberService: MemberService,
    private readonly getConfig: () => SupervisorConfig
  ) {}

  async handleMessageXp(message: Message) {
    if (!message.inGuild() || message.author.bot || !message.member) {
      return;
    }

    const config = this.getConfig();
    if (!config.rankSystem.text.enabled) {
      return;
    }

    if (!this.isEligibleTextChannel(message, config)) {
      return;
    }

    const normalizedContent = this.normalizeContent(message.content);
    if (normalizedContent.length < config.rankSystem.text.minNormalizedLength) {
      return;
    }

    const messageAccepted = await this.consumeTextState(
      message.guildId,
      message.author.id,
      normalizedContent,
      message.createdAt,
      config
    );
    if (!messageAccepted) {
      return;
    }

    const result = await applyRankXp(this.sql, config.rankSystem.curve, {
      guildId: message.guildId,
      userId: message.author.id,
      memberType: this.memberService.getMemberType(message.member),
      xpType: "text",
      xpDelta: config.rankSystem.text.xpPerEligibleMessage,
      sourceType: "message",
      sourceRef: message.id,
      payload: {
        channelId: message.channelId,
        messageId: message.id
      },
      createdAt: message.createdAt
    });

    if (result.applied && result.newLevel > result.oldLevel) {
      this.logger.info(
        {
          guildId: message.guildId,
          userId: message.author.id,
          oldLevel: result.oldLevel,
          newLevel: result.newLevel,
          xpType: "text"
        },
        "Text rank level up recorded."
      );
    }
  }

  async handleRankCommand(interaction: ChatInputCommandInteraction<"cached">) {
    {
      const requestedUser = interaction.options.getUser("uye") ?? interaction.user;
      const requestedViewType = (interaction.options.getString("tur") ?? "ikisi") as
        | "ikisi"
        | "ses"
        | "metin";

      await interaction.deferReply();
      await this.memberService.syncUserShell(interaction.guildId, requestedUser, "user");

      const [profileRow] = await this.sql<RankProfileSummaryRow[]>`
        SELECT
          members.user_id::text AS user_id,
          members.display_name,
          members.member_type,
          members.avatar_url,
          rank_profiles.voice_xp,
          rank_profiles.text_xp,
          rank_profiles.voice_level,
          rank_profiles.text_level
        FROM members
        LEFT JOIN rank_profiles
          ON rank_profiles.guild_id = members.guild_id
         AND rank_profiles.user_id = members.user_id
        WHERE members.guild_id = ${interaction.guildId}
          AND members.user_id = ${requestedUser.id}
        LIMIT 1
      `;

      const [positionRow] = await this.sql<RankPositionRow[]>`
        WITH ranked AS (
          SELECT
            members.user_id::text AS user_id,
            ROW_NUMBER() OVER (
              ORDER BY COALESCE(rank_profiles.voice_xp, 0) DESC, members.display_name ASC
            )::int AS voice_rank,
            ROW_NUMBER() OVER (
              ORDER BY COALESCE(rank_profiles.text_xp, 0) DESC, members.display_name ASC
            )::int AS text_rank
          FROM members
          LEFT JOIN rank_profiles
            ON rank_profiles.guild_id = members.guild_id
           AND rank_profiles.user_id = members.user_id
          WHERE members.guild_id = ${interaction.guildId}
        )
        SELECT voice_rank, text_rank
        FROM ranked
        WHERE user_id = ${requestedUser.id}
        LIMIT 1
      `;

      const config = this.getConfig();
      const voiceProgress = rankProgress(
        this.toSafeNumber(profileRow?.voice_xp),
        config.rankSystem.curve
      );
      const textProgress = rankProgress(
        this.toSafeNumber(profileRow?.text_xp),
        config.rankSystem.curve
      );
      const displayName =
        profileRow?.display_name?.trim()
        || requestedUser.displayName
        || requestedUser.globalName
        || requestedUser.username;
      const memberLabel = profileRow?.member_type === "staff" ? "Yetkili" : "\u00dcye";
      const avatarUrl =
        requestedUser.displayAvatarURL({ extension: "png", size: 256 })
        || profileRow?.avatar_url
        || null;
      const trackCards = [
        {
          key: "voice" as const,
          label: "Ses Seviyesi",
          level: voiceProgress.level,
          totalXp: voiceProgress.totalXp,
          currentLevelXp: voiceProgress.currentLevelXp,
          nextLevelXp: voiceProgress.nextLevelXp,
          progressPercent: voiceProgress.progressPercent,
          position: positionRow?.voice_rank ?? null
        },
        {
          key: "text" as const,
          label: "Metin Seviyesi",
          level: textProgress.level,
          totalXp: textProgress.totalXp,
          currentLevelXp: textProgress.currentLevelXp,
          nextLevelXp: textProgress.nextLevelXp,
          progressPercent: textProgress.progressPercent,
          position: positionRow?.text_rank ?? null
        }
      ];
      const fallbackTracks =
        requestedViewType === "ikisi"
          ? trackCards
          : trackCards.filter(
              (item) => item.key === (requestedViewType === "ses" ? "voice" : "text")
            );

      try {
        const image = await renderRankCard({
          name: displayName,
          handle: requestedUser.tag,
          memberLabel,
          avatarUrl,
          guildName: interaction.guild.name,
          focusType: requestedViewType,
          tracks: trackCards
        });
        const attachment = new AttachmentBuilder(image, {
          name: `rank-card-${requestedUser.id}.png`
        });

        await interaction.editReply({ files: [attachment] });
        return;
      } catch (error) {
        this.logger.warn({ error, userId: requestedUser.id }, "Rank card render failed.");
      }

      await interaction.editReply({
        content:
          `${displayName} i\u00e7in g\u00f6rsel rank kart\u0131 haz\u0131rlanamad\u0131.\n` +
          fallbackTracks
            .map(
              (track) =>
                `${track.label}: Seviye ${track.level}, ${compactXp(track.totalXp)} XP, ${
                  track.position ? `S\u0131ra #${track.position}` : "S\u0131ra yok"
                }`
            )
            .join("\n")
      });
      return;
    }

    {
      const target = interaction.options.getUser("uye") ?? interaction.user;
      const viewType = (interaction.options.getString("tur") ?? "ikisi") as
        | "ikisi"
        | "ses"
        | "metin";

      await interaction.deferReply();
      await this.memberService.syncUserShell(interaction.guildId, target, "user");

      const [row] = await this.sql<RankProfileSummaryRow[]>`
        SELECT
          members.user_id::text AS user_id,
          members.display_name,
          members.member_type,
          members.avatar_url,
          rank_profiles.voice_xp,
          rank_profiles.text_xp,
          rank_profiles.voice_level,
          rank_profiles.text_level
        FROM members
        LEFT JOIN rank_profiles
          ON rank_profiles.guild_id = members.guild_id
         AND rank_profiles.user_id = members.user_id
        WHERE members.guild_id = ${interaction.guildId}
          AND members.user_id = ${target.id}
        LIMIT 1
      `;

      const [positions] = await this.sql<RankPositionRow[]>`
        WITH ranked AS (
          SELECT
            members.user_id::text AS user_id,
            ROW_NUMBER() OVER (
              ORDER BY COALESCE(rank_profiles.voice_xp, 0) DESC, members.display_name ASC
            )::int AS voice_rank,
            ROW_NUMBER() OVER (
              ORDER BY COALESCE(rank_profiles.text_xp, 0) DESC, members.display_name ASC
            )::int AS text_rank
          FROM members
          LEFT JOIN rank_profiles
            ON rank_profiles.guild_id = members.guild_id
           AND rank_profiles.user_id = members.user_id
          WHERE members.guild_id = ${interaction.guildId}
        )
        SELECT voice_rank, text_rank
        FROM ranked
        WHERE user_id = ${target.id}
        LIMIT 1
      `;

      const config = this.getConfig();
      const voice = rankProgress(row?.voice_xp ?? 0, config.rankSystem.curve);
      const text = rankProgress(row?.text_xp ?? 0, config.rankSystem.curve);
      const displayName =
        row?.display_name?.trim() || target.displayName || target.globalName || target.username;
      const memberLabel = row?.member_type === "staff" ? "Yetkili" : "Üye";
      const avatarUrl =
        target.displayAvatarURL({ extension: "png", size: 256 }) || row?.avatar_url || null;
      const tracks = [
        {
          key: "voice" as const,
          label: "Ses Seviyesi",
          level: voice.level,
          totalXp: voice.totalXp,
          currentLevelXp: voice.currentLevelXp,
          nextLevelXp: voice.nextLevelXp,
          progressPercent: voice.progressPercent,
          position: positions?.voice_rank ?? null
        },
        {
          key: "text" as const,
          label: "Metin Seviyesi",
          level: text.level,
          totalXp: text.totalXp,
          currentLevelXp: text.currentLevelXp,
          nextLevelXp: text.nextLevelXp,
          progressPercent: text.progressPercent,
          position: positions?.text_rank ?? null
        }
      ];
      const focusedTracks =
        viewType === "ikisi"
          ? tracks
          : tracks.filter((item) => item.key === (viewType === "ses" ? "voice" : "text"));

      try {
        const image = await renderRankCard({
          name: displayName,
          handle: target.tag,
          memberLabel,
          avatarUrl,
          guildName: interaction.guild.name,
          focusType: viewType,
          tracks
        });
        const attachment = new AttachmentBuilder(image, {
          name: `rank-card-${target.id}.png`
        });

        await interaction.editReply({
          files: [attachment]
        });
        return;
      } catch (error) {
        this.logger.warn({ error, userId: target.id }, "Rank card render failed.");
      }

      await interaction.editReply({
        content:
          `${displayName} için görsel rank kartı hazırlanamadı.\n` +
          focusedTracks
            .map(
              (track) =>
                `${track.label}: Seviye ${track.level}, ${compactXp(track.totalXp)} XP, ${track.position ? `Sıra #${track.position}` : "Sıra yok"}`
            )
            .join("\n")
      });
      return;
    }

    const target = interaction.options.getUser("uye") ?? interaction.user;
    const viewType = (interaction.options.getString("tur") ?? "ikisi") as "ikisi" | "ses" | "metin";

    await interaction.deferReply();
    await this.memberService.syncUserShell(interaction.guildId, target, "user");

    const [row] = await this.sql<RankProfileSummaryRow[]>`
      SELECT
        members.user_id::text AS user_id,
        members.display_name,
        members.member_type,
        members.avatar_url,
        rank_profiles.voice_xp,
        rank_profiles.text_xp,
        rank_profiles.voice_level,
        rank_profiles.text_level
      FROM members
      LEFT JOIN rank_profiles
        ON rank_profiles.guild_id = members.guild_id
       AND rank_profiles.user_id = members.user_id
      WHERE members.guild_id = ${interaction.guildId}
        AND members.user_id = ${target.id}
      LIMIT 1
    `;

    const [positions] = await this.sql<RankPositionRow[]>`
      WITH ranked AS (
        SELECT
          members.user_id::text AS user_id,
          ROW_NUMBER() OVER (
            ORDER BY COALESCE(rank_profiles.voice_xp, 0) DESC, members.display_name ASC
          )::int AS voice_rank,
          ROW_NUMBER() OVER (
            ORDER BY COALESCE(rank_profiles.text_xp, 0) DESC, members.display_name ASC
          )::int AS text_rank
        FROM members
        LEFT JOIN rank_profiles
          ON rank_profiles.guild_id = members.guild_id
         AND rank_profiles.user_id = members.user_id
        WHERE members.guild_id = ${interaction.guildId}
      )
      SELECT voice_rank, text_rank
      FROM ranked
      WHERE user_id = ${target.id}
      LIMIT 1
    `;

    const config = this.getConfig();
    const voice = rankProgress(row?.voice_xp ?? 0, config.rankSystem.curve);
    const text = rankProgress(row?.text_xp ?? 0, config.rankSystem.curve);
    const displayName =
      row?.display_name?.trim() || target.displayName || target.globalName || target.username;
    const memberLabel = row?.member_type === "staff" ? "Yetkili" : "Üye";
    const avatarUrl =
      target.displayAvatarURL({ extension: "png", size: 256 }) || row?.avatar_url || null;
    const tracks = [
      {
        key: "voice" as const,
        label: "Ses Seviyesi",
        level: voice.level,
        totalXp: voice.totalXp,
        currentLevelXp: voice.currentLevelXp,
        nextLevelXp: voice.nextLevelXp,
        progressPercent: voice.progressPercent,
        position: positions?.voice_rank ?? null
      },
      {
        key: "text" as const,
        label: "Metin Seviyesi",
        level: text.level,
        totalXp: text.totalXp,
        currentLevelXp: text.currentLevelXp,
        nextLevelXp: text.nextLevelXp,
        progressPercent: text.progressPercent,
        position: positions?.text_rank ?? null
      }
    ];
    const focusedTracks =
      viewType === "ikisi"
        ? tracks
        : tracks.filter((item) => item.key === (viewType === "ses" ? "voice" : "text"));
    const summaryFields = focusedTracks.map((track) => ({
      name: track.label,
      value:
        `Seviye **${track.level}** • **${compactXp(track.totalXp)} XP**\n` +
        `${progressBar(track.progressPercent)} **%${track.progressPercent}**\n` +
        `${track.position ? `Sıra **#${track.position}**` : "Sıra yok"} • Sonraki seviye için **${compactXp(Math.max(track.nextLevelXp - track.currentLevelXp, 0))} XP**`,
      inline: focusedTracks.length === 1
    }));

    try {
      const image = await renderRankCard({
        name: displayName,
        handle: target.tag,
        memberLabel,
        avatarUrl,
        guildName: interaction.guild.name,
        focusType: viewType,
        tracks
      });
      const attachment = new AttachmentBuilder(image, {
        name: `rank-card-${target.id}.png`
      });

      await interaction.editReply({
        embeds: [
          createCommandEmbed({
            tone: "accent",
            title: `${displayName} • Seviye Kartı`,
            description:
              viewType === "ikisi"
                ? "Ses ve metin kulvarlarının toplam XP görünümü tek kartta işlendi."
                : `${viewType === "ses" ? "Ses" : "Metin"} kulvarı için toplam XP görünümü oluşturuldu.`,
            authorName: `${interaction.user.displayName ?? interaction.user.username} görüntülüyor`,
            authorIcon: interaction.user.displayAvatarURL(),
            thumbnail: avatarUrl,
            image: `attachment://rank-card-${target.id}.png`,
            fields: summaryFields,
            footer: "Supervisor Discord Bot • Seviye Kartı"
          })
        ],
        files: [attachment]
      });
      return;
    } catch (error) {
      this.logger.warn({ error, userId: target.id }, "Rank card render failed.");
    }

    await interaction.editReply({
      embeds: [
        createCommandEmbed({
          tone: "accent",
          title: `${displayName} • Seviye Kartı`,
          description: "Görsel kart hazırlanamadı. Yedek embed görünümü kullanılıyor.",
          authorName: `${interaction.user.displayName ?? interaction.user.username} görüntülüyor`,
          authorIcon: interaction.user.displayAvatarURL(),
          thumbnail: avatarUrl,
          fields: summaryFields,
          footer: "Supervisor Discord Bot • Yedek Seviye Görünümü"
        })
      ]
    });
  }

  async handleLeaderboardCommand(interaction: ChatInputCommandInteraction<"cached">) {
    {
      const defaultScope =
        interaction.member instanceof GuildMember
        && this.memberService.getMemberType(interaction.member) === "staff"
          ? "yetkili"
          : "uye";
      const requestedScope = (interaction.options.getString("kapsam") ?? defaultScope) as
        | "uye"
        | "yetkili";
      const requestedRankType = (interaction.options.getString("tur") ?? "ses") as
        | "ses"
        | "metin";
      const requestedMemberType = requestedScope === "yetkili" ? "staff" : "user";
      const requestedXpType = requestedRankType === "metin" ? "text" : "voice";
      const config = this.getConfig();
      const visibleLimit = Math.max(3, config.rankSystem.leaderboard.commandTopSize);
      const orderColumn =
        requestedXpType === "voice" ? "rank_profiles.voice_xp" : "rank_profiles.text_xp";
      const levelColumn =
        requestedXpType === "voice" ? "rank_profiles.voice_level" : "rank_profiles.text_level";

      await interaction.deferReply();

      const leaderboardSourceRows = await this.sql.unsafe<LeaderboardRow[]>(
        `
          WITH ranked AS (
            SELECT
              members.user_id::text AS user_id,
              members.display_name,
              members.avatar_url,
              COALESCE(${orderColumn}, 0)::bigint AS xp_value,
              COALESCE(${levelColumn}, 0)::int AS level_value,
              ROW_NUMBER() OVER (
                ORDER BY COALESCE(${orderColumn}, 0) DESC, members.display_name ASC
              )::int AS position
            FROM members
            LEFT JOIN rank_profiles
              ON rank_profiles.guild_id = members.guild_id
             AND rank_profiles.user_id = members.user_id
            WHERE members.guild_id = $1
              AND members.member_type = $2
          )
          SELECT user_id, display_name, avatar_url, xp_value, level_value, position
          FROM ranked
          WHERE position <= $3 OR user_id = $4
          ORDER BY position ASC
        `,
        [interaction.guildId, requestedMemberType, visibleLimit, interaction.user.id]
      );

      if (leaderboardSourceRows.length === 0) {
        await interaction.editReply({
          content: "Hen\u00fcz s\u0131ralama verisi olu\u015fmad\u0131."
        });
        return;
      }

      const requesterRow =
        leaderboardSourceRows.find((row) => row.user_id === interaction.user.id) ?? null;
      const requesterPosition = requesterRow?.position ?? null;
      const visibleRows = leaderboardSourceRows.slice(0, visibleLimit);
      if (requesterRow && !visibleRows.some((row) => row.user_id === requesterRow.user_id)) {
        visibleRows.push(requesterRow);
      }

      const renderedRows = visibleRows.map((row) => {
        const totalXp = this.toSafeNumber(row.xp_value);
        const progress = rankProgress(totalXp, config.rankSystem.curve);
        return {
          position: row.position,
          name: row.display_name ?? row.user_id,
          avatarUrl: row.avatar_url,
          level: progress.level,
          totalXp,
          progressPercent: progress.progressPercent,
          isRequester: row.user_id === interaction.user.id
        };
      });

      const title = `${requestedScope === "yetkili" ? "Yetkili" : "\u00dcye"} ${
        requestedRankType === "metin" ? "Metin" : "Ses"
      } S\u0131ralamas\u0131`;

      try {
        const image = await renderLeaderboardCard({
          title,
          subtitle:
            (requesterPosition ?? -1) > visibleLimit
              ? `\u0130lk ${visibleLimit} g\u00f6steriliyor - Senin s\u0131ran #${requesterPosition!}`
              : `\u0130lk ${renderedRows.length} s\u0131ra canl\u0131 g\u00f6r\u00fcn\u00fcmde`,
          guildName: interaction.guild.name,
          rows: renderedRows
        });
        const attachment = new AttachmentBuilder(image, {
          name: `leaderboard-${requestedScope}-${requestedRankType}.png`
        });

        await interaction.editReply({ files: [attachment] });
        return;
      } catch (error) {
        this.logger.warn({ error, guildId: interaction.guildId }, "Leaderboard card render failed.");
      }

      await interaction.editReply({
        content:
          `${title}\n` +
          renderedRows
            .map((row) => `#${row.position} ${row.name} - Lv.${row.level} - ${compactXp(row.totalXp)} XP`)
            .join("\n")
      });
      return;
    }

    {
      const defaultScope =
        interaction.member instanceof GuildMember
        && this.memberService.getMemberType(interaction.member) === "staff"
          ? "yetkili"
          : "uye";
      const scope = (interaction.options.getString("kapsam") ?? defaultScope) as
        | "uye"
        | "yetkili";
      const rankType = (interaction.options.getString("tur") ?? "ses") as "ses" | "metin";
      const memberType = scope === "yetkili" ? "staff" : "user";
      const xpType = rankType === "metin" ? "text" : "voice";
      const config = this.getConfig();
      const limit = Math.max(3, config.rankSystem.leaderboard.commandTopSize);
      const orderColumn = xpType === "voice" ? "rank_profiles.voice_xp" : "rank_profiles.text_xp";
      const levelColumn =
        xpType === "voice" ? "rank_profiles.voice_level" : "rank_profiles.text_level";

      await interaction.deferReply();

      const rows = await this.sql.unsafe<LeaderboardRow[]>(
        `
          WITH ranked AS (
            SELECT
              members.user_id::text AS user_id,
              members.display_name,
              members.avatar_url,
              COALESCE(${orderColumn}, 0)::bigint AS xp_value,
              COALESCE(${levelColumn}, 0)::int AS level_value,
              ROW_NUMBER() OVER (
                ORDER BY COALESCE(${orderColumn}, 0) DESC, members.display_name ASC
              )::int AS position
            FROM members
            LEFT JOIN rank_profiles
              ON rank_profiles.guild_id = members.guild_id
             AND rank_profiles.user_id = members.user_id
            WHERE members.guild_id = $1
              AND members.member_type = $2
          )
          SELECT user_id, display_name, avatar_url, xp_value, level_value, position
          FROM ranked
          WHERE position <= $3 OR user_id = $4
          ORDER BY position ASC
        `,
        [interaction.guildId, memberType, limit, interaction.user.id]
      );

      if (rows.length === 0) {
        await interaction.editReply({
          content: "Henüz sıralama verisi oluşmadı."
        });
        return;
      }

      const title = `${scope === "yetkili" ? "Yetkili" : "Üye"} ${rankType === "metin" ? "Metin" : "Ses"} Sıralaması`;
      const requesterRow = rows.find((row) => row.user_id === interaction.user.id) ?? null;
      const requesterPosition = requesterRow?.position ?? null;
      const visibleRows = rows.slice(0, limit);
      if (requesterRow !== null) {
        const requesterUserId = requesterRow!.user_id;
        if (!visibleRows.some((item) => item.user_id === requesterUserId)) {
          visibleRows.push(requesterRow!);
        }
      }

      const leaderboardRows = visibleRows.map((row) => {
        const progress = rankProgress(row.xp_value, config.rankSystem.curve);
        return {
          position: row.position,
          name: row.display_name ?? row.user_id,
          avatarUrl: row.avatar_url,
          level: row.level_value,
          totalXp: row.xp_value,
          progressPercent: progress.progressPercent,
          isRequester: row.user_id === interaction.user.id
        };
      });

      try {
        const image = await renderLeaderboardCard({
          title,
          subtitle:
            (requesterPosition ?? -1) > limit
              ? `İlk ${limit} gösteriliyor - Senin sıran #${requesterPosition!}`
              : `İlk ${leaderboardRows.length} sıra canlı görünümde`,
          guildName: interaction.guild.name,
          rows: leaderboardRows
        });
        const attachment = new AttachmentBuilder(image, {
          name: `leaderboard-${scope}-${rankType}.png`
        });

        await interaction.editReply({
          files: [attachment]
        });
        return;
      } catch (error) {
        this.logger.warn({ error, guildId: interaction.guildId }, "Leaderboard card render failed.");
      }

      await interaction.editReply({
        content:
          `${title}\n` +
          leaderboardRows
            .map((row) => `#${row.position} ${row.name} - Lv.${row.level} - ${compactXp(row.totalXp)} XP`)
            .join("\n")
      });
      return;
    }

    const defaultScope =
      interaction.member instanceof GuildMember
      && this.memberService.getMemberType(interaction.member) === "staff"
        ? "yetkili"
        : "uye";
    const scope = (interaction.options.getString("kapsam") ?? defaultScope) as
      | "uye"
      | "yetkili";
    const rankType = (interaction.options.getString("tur") ?? "ses") as "ses" | "metin";
    const memberType = scope === "yetkili" ? "staff" : "user";
    const xpType = rankType === "metin" ? "text" : "voice";
    const config = this.getConfig();
    const limit = Math.max(3, config.rankSystem.leaderboard.commandTopSize);
    const orderColumn = xpType === "voice" ? "rank_profiles.voice_xp" : "rank_profiles.text_xp";
    const levelColumn = xpType === "voice" ? "rank_profiles.voice_level" : "rank_profiles.text_level";

    await interaction.deferReply();

    const rows = await this.sql.unsafe<LeaderboardRow[]>(
      `
        WITH ranked AS (
          SELECT
            members.user_id::text AS user_id,
            members.display_name,
            members.avatar_url,
            COALESCE(${orderColumn}, 0)::bigint AS xp_value,
            COALESCE(${levelColumn}, 0)::int AS level_value,
            ROW_NUMBER() OVER (
              ORDER BY COALESCE(${orderColumn}, 0) DESC, members.display_name ASC
            )::int AS position
          FROM members
          LEFT JOIN rank_profiles
            ON rank_profiles.guild_id = members.guild_id
           AND rank_profiles.user_id = members.user_id
          WHERE members.guild_id = $1
            AND members.member_type = $2
        )
        SELECT user_id, display_name, avatar_url, xp_value, level_value, position
        FROM ranked
        WHERE position <= $3 OR user_id = $4
        ORDER BY position ASC
      `,
      [interaction.guildId, memberType, limit, interaction.user.id]
    );

    if (rows.length === 0) {
      await interaction.editReply({
        embeds: [
          createCommandEmbed({
            tone: "neutral",
            title: "Seviye Sıralaması",
            description: "Henüz sıralama verisi oluşmadı.",
            authorName: interaction.guild.name,
            authorIcon: interaction.guild.iconURL()
          })
        ]
      });
      return;
    }

    const title = `${scope === "yetkili" ? "Yetkili" : "Üye"} ${rankType === "metin" ? "Metin" : "Ses"} Sıralaması`;
    const requesterRow = rows.find((row) => row.user_id === interaction.user.id) ?? null;
    const requesterPosition = requesterRow?.position ?? null;
    const visibleRows = rows.slice(0, limit);
    if (requesterRow !== null) {
      const requesterUserId = requesterRow!.user_id;
      if (!visibleRows.some((item) => item.user_id === requesterUserId)) {
        visibleRows.push(requesterRow!);
      }
    }

    const leaderboardRows = visibleRows.map((row) => {
      const progress = rankProgress(row.xp_value, config.rankSystem.curve);
      return {
        position: row.position,
        name: row.display_name ?? row.user_id,
        avatarUrl: row.avatar_url,
        level: row.level_value,
        totalXp: row.xp_value,
        progressPercent: progress.progressPercent,
        isRequester: row.user_id === interaction.user.id
      };
    });

    const summary = leaderboardRows
      .slice(0, Math.min(3, leaderboardRows.length))
      .map((row) => `#${row.position} **${row.name}** • Lv.${row.level} • ${compactXp(row.totalXp)} XP`)
      .join("\n");

    try {
      const image = await renderLeaderboardCard({
        title,
        subtitle:
          (requesterPosition ?? -1) > limit
            ? `İlk ${limit} gösteriliyor • Senin sıran #${requesterPosition!}`
            : `İlk ${leaderboardRows.length} sıra canlı görünümde`,
        guildName: interaction.guild.name,
        rows: leaderboardRows
      });
      const attachment = new AttachmentBuilder(image, {
        name: `leaderboard-${scope}-${rankType}.png`
      });

      await interaction.editReply({
        embeds: [
          createCommandEmbed({
            tone: "neutral",
            title,
            description: summary,
            authorName: `${interaction.guild.name} • ${rankTypeLabel(xpType)} kulvarı`,
            authorIcon: interaction.guild.iconURL(),
            image: `attachment://leaderboard-${scope}-${rankType}.png`,
            footer: "Supervisor Discord Bot • Canlı Liderlik Tablosu"
          })
        ],
        files: [attachment]
      });
      return;
    } catch (error) {
      this.logger.warn({ error, guildId: interaction.guildId }, "Leaderboard card render failed.");
    }

    await interaction.editReply({
      embeds: [
        createCommandEmbed({
          tone: "neutral",
          title,
          description:
            `${summary}\n\n` +
            leaderboardRows
              .map((row) => `#${row.position} ${row.name} • Lv.${row.level} • ${compactXp(row.totalXp)} XP`)
              .join("\n"),
          authorName: `${interaction.guild.name} • ${rankTypeLabel(xpType)} kulvarı`,
          authorIcon: interaction.guild.iconURL(),
          footer: "Supervisor Discord Bot • Yedek Sıralama Görünümü"
        })
      ]
    });
  }

  async processPendingLevelEffects(guild: Guild) {
    const config = this.getConfig();
    if (
      !config.rankSystem.rewards.roleRewardsEnabled
      && !config.rankSystem.rewards.levelUpMessagesEnabled
    ) {
      return;
    }

    {
      const pendingRows = await this.sql<PendingLevelEventRow[]>`
        SELECT
          id::text,
          user_id::text,
          xp_type,
          level_after,
          source_type,
          role_sync_processed_at,
          announcement_processed_at
        FROM rank_events
        WHERE guild_id = ${guild.id}
          AND event_type = 'level_up'
          AND source_type <> 'backfill'
          AND (
            role_sync_processed_at IS NULL
            OR announcement_processed_at IS NULL
          )
        ORDER BY created_at ASC, level_after DESC
        LIMIT 50
      `;

      const groupedRows = new Map<string, PendingLevelEventRow[]>();
      for (const row of pendingRows) {
        const key = `${row.user_id}:${row.xp_type}`;
        const current = groupedRows.get(key) ?? [];
        current.push(row);
        groupedRows.set(key, current);
      }

      for (const rows of groupedRows.values()) {
        const sample = rows[0];
        const [profile] = await this.sql<{
          voice_level: number | string | null;
          text_level: number | string | null;
        }[]>`
          SELECT voice_level, text_level
          FROM rank_profiles
          WHERE guild_id = ${guild.id}
            AND user_id = ${sample.user_id}
          LIMIT 1
        `;

        const currentLevel =
          sample.xp_type === "voice"
            ? this.toSafeNumber(profile?.voice_level)
            : this.toSafeNumber(profile?.text_level);
        const highestValidRow =
          [...rows]
            .filter((row) => row.level_after <= currentLevel)
            .sort((left, right) => right.level_after - left.level_after)[0] ?? null;

        try {
          const member = highestValidRow
            ? await guild.members.fetch(sample.user_id).catch(() => null)
            : null;

          if (
            highestValidRow
            && rows.some((row) => !row.role_sync_processed_at)
            && config.rankSystem.rewards.roleRewardsEnabled
            && member
          ) {
            await this.syncRewardRolesForMember(member);
          }

          if (
            highestValidRow
            && rows.some((row) => !row.announcement_processed_at)
            && config.rankSystem.rewards.levelUpMessagesEnabled
            && member
          ) {
            await this.sendLevelAnnouncement(guild, member, highestValidRow.xp_type, currentLevel);
          }

          for (const row of rows) {
            await this.sql`
              UPDATE rank_events
              SET role_sync_processed_at = NOW(),
                  announcement_processed_at = NOW()
              WHERE id = ${row.id}
            `;
          }
        } catch (error) {
          this.logger.error(
            { error, guildId: guild.id, userId: sample.user_id, xpType: sample.xp_type },
            "Rank side effect failed."
          );
        }
      }

      return;
    }

    const rows = await this.sql<PendingLevelEventRow[]>`
      SELECT
        id::text,
        user_id::text,
        xp_type,
        level_after,
        role_sync_processed_at,
        announcement_processed_at
      FROM rank_events
      WHERE guild_id = ${guild.id}
        AND event_type = 'level_up'
        AND (
          role_sync_processed_at IS NULL
          OR announcement_processed_at IS NULL
        )
      ORDER BY created_at ASC
      LIMIT 25
    `;

    for (const row of rows) {
      const member = await guild.members.fetch(row.user_id).catch(() => null);

      try {
        if (!row.role_sync_processed_at) {
          if (config.rankSystem.rewards.roleRewardsEnabled && member) {
            await this.syncRewardRolesForMember(
              member!,
              row.xp_type === "voice" ? row.level_after : undefined,
              row.xp_type === "text" ? row.level_after : undefined
            );
          }

          await this.sql`
            UPDATE rank_events
            SET role_sync_processed_at = NOW()
            WHERE id = ${row.id}
          `;
        }

        if (!row.announcement_processed_at) {
          if (config.rankSystem.rewards.levelUpMessagesEnabled && member) {
            await this.sendLevelAnnouncement(guild, member!, row.xp_type, row.level_after);
          }

          await this.sql`
            UPDATE rank_events
            SET announcement_processed_at = NOW()
            WHERE id = ${row.id}
          `;
        }
      } catch (error) {
        this.logger.error({ error, guildId: guild.id, userId: row.user_id }, "Rank side effect failed.");
      }
    }
  }

  async processRewardSyncJobs(guild: Guild) {
    const [job] = await this.sql<RewardSyncJobRow[]>`
      SELECT status
      FROM rank_reward_sync_jobs
      WHERE guild_id = ${guild.id}
        AND status IN ('pending', 'running')
      LIMIT 1
    `;

    if (!job) {
      return;
    }

    await this.sql`
      INSERT INTO rank_reward_sync_jobs (guild_id, status, requested_at, started_at, completed_at, last_error)
      VALUES (${guild.id}, 'running', NOW(), NOW(), NULL, NULL)
      ON CONFLICT (guild_id)
      DO UPDATE SET
        status = 'running',
        started_at = NOW(),
        completed_at = NULL,
        last_error = NULL
    `;

    try {
      const profiles = await this.sql<RewardSyncProfileRow[]>`
        SELECT
          user_id::text,
          voice_level,
          text_level
        FROM rank_profiles
        WHERE guild_id = ${guild.id}
      `;

      for (const profile of profiles) {
        const member = await guild.members.fetch(profile.user_id).catch(() => null);
        if (!member) {
          continue;
        }

        await this.syncRewardRolesForMember(member, profile.voice_level, profile.text_level);
      }

      await this.sql`
        UPDATE rank_reward_sync_jobs
        SET status = 'completed',
            completed_at = NOW(),
            last_error = NULL
        WHERE guild_id = ${guild.id}
      `;
    } catch (error) {
      await this.sql`
        UPDATE rank_reward_sync_jobs
        SET status = 'failed',
            last_error = ${error instanceof Error ? error.message : String(error)}
        WHERE guild_id = ${guild.id}
      `;
      this.logger.error({ error, guildId: guild.id }, "Reward sync job failed.");
    }
  }

  private async consumeTextState(
    guildId: string,
    userId: string,
    normalizedContent: string,
    createdAt: Date,
    config: SupervisorConfig
  ) {
    return this.sql.begin(async (transaction) => {
      const tx = transaction as unknown as Sql;
      const [state] = await tx<RankTextStateRow[]>`
        SELECT last_eligible_at, recent_contents, hour_window_started_at, hour_message_count
        FROM rank_text_state
        WHERE guild_id = ${guildId}
          AND user_id = ${userId}
        FOR UPDATE
      `;

      const duplicateWindowMs = config.rankSystem.text.duplicateWindowMinutes * 60 * 1000;
      const cooldownMs = config.rankSystem.text.cooldownSeconds * 1000;
      const recentContents = this.parseRecentContents(state?.recent_contents).filter((item) => {
        const itemTime = new Date(item.at).getTime();
        return Number.isFinite(itemTime) && createdAt.getTime() - itemTime <= duplicateWindowMs;
      });

      const lastEligibleAt = state?.last_eligible_at ? new Date(state.last_eligible_at) : null;
      const cooldownBlocked =
        lastEligibleAt !== null && createdAt.getTime() - lastEligibleAt.getTime() < cooldownMs;
      const duplicateBlocked = recentContents.some((item) => item.content === normalizedContent);

      let hourWindowStartedAt =
        state?.hour_window_started_at ? new Date(state.hour_window_started_at) : null;
      let hourMessageCount = state?.hour_message_count ?? 0;
      if (
        !hourWindowStartedAt ||
        createdAt.getTime() - hourWindowStartedAt.getTime() >= 60 * 60 * 1000
      ) {
        hourWindowStartedAt = createdAt;
        hourMessageCount = 0;
      }

      const hourlyBlocked = hourMessageCount >= config.rankSystem.text.hourlyEligibleCap;
      const eligible = !cooldownBlocked && !duplicateBlocked && !hourlyBlocked;
      const nextContents = eligible
        ? [...recentContents, { content: normalizedContent, at: createdAt.toISOString() }]
        : recentContents;
      const nextHourCount = eligible ? hourMessageCount + 1 : hourMessageCount;

      await tx`
        INSERT INTO rank_text_state (
          guild_id,
          user_id,
          last_eligible_at,
          recent_contents,
          hour_window_started_at,
          hour_message_count
        )
        VALUES (
          ${guildId},
          ${userId},
          ${eligible ? createdAt : lastEligibleAt},
          CAST(${JSON.stringify(nextContents)} AS jsonb),
          ${hourWindowStartedAt},
          ${nextHourCount}
        )
        ON CONFLICT (guild_id, user_id)
        DO UPDATE SET
          last_eligible_at = EXCLUDED.last_eligible_at,
          recent_contents = EXCLUDED.recent_contents,
          hour_window_started_at = EXCLUDED.hour_window_started_at,
          hour_message_count = EXCLUDED.hour_message_count,
          updated_at = NOW()
      `;

      return eligible;
    });
  }

  private parseRecentContents(value: unknown): RecentContentItem[] {
    const list = typeof value === "string" ? JSON.parse(value) : value;
    if (!Array.isArray(list)) {
      return [];
    }

    return list
      .filter((item): item is RecentContentItem => {
        return Boolean(
          item &&
            typeof item === "object" &&
            "content" in item &&
            "at" in item &&
            typeof (item as { content?: unknown }).content === "string" &&
            typeof (item as { at?: unknown }).at === "string"
        );
      })
      .slice(-20);
  }

  private normalizeContent(content: string) {
    return content
      .toLocaleLowerCase("tr-TR")
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  private isEligibleTextChannel(message: Message, config: SupervisorConfig) {
    const ignoredChannels = new Set(config.rankSystem.text.ignoredChannelIds);
    const ignoredCategories = new Set(config.rankSystem.text.ignoredCategoryIds);

    if (ignoredChannels.has(message.channelId)) {
      return false;
    }

    if (!message.channel.isTextBased()) {
      return false;
    }

    const parentId = "parentId" in message.channel ? message.channel.parentId : null;
    if (parentId && ignoredCategories.has(parentId)) {
      return false;
    }

    return true;
  }

  private async syncRewardRolesForMember(
    member: GuildMember,
    voiceLevelOverride?: number,
    textLevelOverride?: number
  ) {
    const config = this.getConfig();
    const [profile] = await this.sql<{
      voice_level: number;
      text_level: number;
    }[]>`
      SELECT voice_level, text_level
      FROM rank_profiles
      WHERE guild_id = ${member.guild.id}
        AND user_id = ${member.id}
      LIMIT 1
    `;

    const voiceLevel = voiceLevelOverride ?? profile?.voice_level ?? 0;
    const textLevel = textLevelOverride ?? profile?.text_level ?? 0;
    const rewardConfig = config.rankSystem.rewards;
    const voiceTargets = resolveRewardRoleIds(
      voiceLevel,
      rewardConfig.voiceRewards,
      rewardConfig.roleMode
    );
    const textTargets = resolveRewardRoleIds(
      textLevel,
      rewardConfig.textRewards,
      rewardConfig.roleMode
    );
    const allRewardRoleIds = new Set(
      [...rewardConfig.voiceRewards, ...rewardConfig.textRewards].map((item) => item.roleId)
    );
    const targetRoleIds = new Set([...voiceTargets, ...textTargets]);

    if (!member.manageable) {
      return;
    }

    for (const roleId of allRewardRoleIds) {
      if (!targetRoleIds.has(roleId) && member.roles.cache.has(roleId)) {
        await member.roles.remove(roleId).catch(() => undefined);
      }
    }

    for (const roleId of targetRoleIds) {
      if (!member.roles.cache.has(roleId)) {
        await member.roles.add(roleId).catch(() => undefined);
      }
    }
  }

  private async sendLevelAnnouncement(
    guild: Guild,
    member: GuildMember,
    xpType: "voice" | "text",
    level: number
  ) {
    {
      const announcementChannelId = this.getConfig().rankSystem.rewards.announcementChannelId;
      if (!announcementChannelId) {
        return;
      }

      const textChannel = await guild.channels.fetch(announcementChannelId).catch(() => null);
      if (!textChannel || !textChannel.isTextBased() || !("send" in textChannel)) {
        return;
      }

      await textChannel.send({
        embeds: [
          createCommandEmbed({
            tone: "success",
            title: `${member.displayName} seviye atladı`,
            description: `${member} ${rankTypeLabel(xpType)} kulvarında **${level}. seviyeye** ulaştı.`,
            thumbnail: member.displayAvatarURL(),
            footer: "Supervisor Discord Bot • Seviye Duyurusu"
          })
        ]
      });
      return;
    }

    const announcementChannelId = this.getConfig().rankSystem.rewards.announcementChannelId;
    if (!announcementChannelId) {
      return;
    }

    const rawChannel: unknown = await guild.channels.fetch(announcementChannelId as string).catch(() => null);
    if (!rawChannel || typeof rawChannel !== "object") {
      return;
    }

    const channelLike = rawChannel as Record<string, unknown>;
    if (!("isTextBased" in channelLike) || !("send" in channelLike)) {
      return;
    }

    const sendableChannel = rawChannel as {
      isTextBased: () => boolean;
      send: (payload: unknown) => Promise<unknown>;
    };
    if (!sendableChannel.isTextBased()) {
      return;
    }

    await sendableChannel.send({
      embeds: [
        createCommandEmbed({
          tone: "success",
          title: `${member.displayName} seviye atladı`,
          description: `${member} ${rankTypeLabel(xpType)} kulvarında **${level}. seviyeye** ulaştı.`,
          thumbnail: member.displayAvatarURL(),
          footer: "Supervisor Discord Bot • Seviye Duyurusu"
        })
      ]
    });
  }

  private toSafeNumber(value: number | string | null | undefined) {
    const numeric = typeof value === "string" ? Number(value) : (value ?? 0);
    if (!Number.isFinite(numeric)) {
      return 0;
    }

    return Math.max(0, Math.floor(numeric));
  }
}
