import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  Guild,
  GuildMember,
  ModalBuilder,
  ModalSubmitInteraction,
  TextInputBuilder,
  TextInputStyle,
  escapeMarkdown,
  type GuildBasedChannel,
  type Message,
  type User
} from "discord.js";
import type { Logger } from "pino";
import type { Sql } from "postgres";

import type {
  ModerationCaseStatus,
  ModerationCaseType,
  ModerationTargetType,
  SupervisorConfig
} from "../../../../packages/shared/src";
import { createCommandEmbed } from "../lib/command-ui";
import type { MemberService } from "./member-service";
import type { PolicyService } from "./policy-service";

type CommandName =
  | "ban"
  | "unban"
  | "kick"
  | "timeout"
  | "untimeout"
  | "softban"
  | "warn"
  | "unwarn"
  | "history"
  | "jail"
  | "unjail"
  | "purge"
  | "lock"
  | "unlock"
  | "slowmode";

interface CaseRow {
  id: number;
  guild_id: string;
  case_type: ModerationCaseType;
  status: ModerationCaseStatus;
  target_type: ModerationTargetType;
  target_id: string;
  actor_id: string;
  reason: string | null;
  dm_requested: boolean;
  dm_status: "sent" | "failed" | "skipped" | null;
  proof_url: string | null;
  points: number;
  duration_seconds: number | null;
  expires_at: Date | null;
  metadata: unknown;
  created_at: Date;
  resolved_at: Date | null;
}

interface Draft {
  caseType: Exclude<ModerationCaseType, "history">;
  targetType: ModerationTargetType;
  targetId: string;
  targetLabel: string;
  reason: string;
  dmRequested: boolean;
  proofUrl: string | null;
  points: number;
  durationSeconds: number | null;
  expiresAt: Date | null;
  title: string;
  description: string;
  tone: "critical" | "warning" | "neutral";
  metadata: Record<string, unknown>;
}

interface ExecResult {
  status: ModerationCaseStatus;
  summary: string;
  extra?: Record<string, unknown>;
  dm?: { status: "sent" | "failed" | "skipped"; note: string };
}

const LABELS: Record<ModerationCaseType, string> = {
  ban: "Ban",
  unban: "Ban Kaldır",
  kick: "Kick",
  timeout: "Timeout",
  untimeout: "Timeout Kaldır",
  softban: "Softban",
  warn: "Warn",
  unwarn: "Warn Kaldır",
  jail: "Jail",
  unjail: "Jail Kaldır",
  purge: "Purge",
  lock: "Lock",
  unlock: "Unlock",
  slowmode: "Slowmode"
};

export class ModerationCommandService {
  constructor(
    private readonly sql: Sql,
    private readonly logger: Logger,
    private readonly memberService: MemberService,
    private readonly getConfig: () => SupervisorConfig,
    private readonly policyService: PolicyService | null = null
  ) {}

  async handleCommand(interaction: ChatInputCommandInteraction<"cached">) {
    const commandName = this.resolveCommandName(interaction);
    if (!commandName) {
      return;
    }

    const actor = interaction.member;
    if (!(actor instanceof GuildMember)) {
      await interaction.reply({ content: "Uye bilgisi alinamadi.", ephemeral: true });
      return;
    }

    if (commandName === "history") {
      await this.handleHistory(interaction, actor);
      return;
    }

    // Role-based policy check (new RBAC system)
    if (this.policyService) {
      const policyResult = await this.policyService.checkAction(actor, commandName as ModerationCaseType);
      if (!policyResult.allowed) {
        await interaction.reply({
          embeds: [
            createCommandEmbed({
              tone: "critical",
              title: "Yetki Reddedildi",
              description: policyResult.reason ?? "Bu işlem için yetkiniz yok."
            })
          ],
          ephemeral: true
        });
        return;
      }
    }

    const limitError = await this.checkLimits(actor, commandName);
    if (limitError) {
      await interaction.reply({
        embeds: [
          createCommandEmbed({
            tone: "critical",
            title: "Limit Aşıldı",
            description: limitError
          })
        ],
        ephemeral: true
      });
      return;
    }

    const draft = await this.buildDraft(interaction, actor, commandName);
    if (!draft) {
      return;
    }

    const caseId = await this.createPendingCase(interaction.guildId, actor.id, draft);
    const row = await this.getCase(caseId);
    if (!row) {
      await interaction.reply({ content: "Vaka olusturulamadi.", ephemeral: true });
      return;
    }

    if (!this.getConfig().moderation.safeFlowEnabled) {
      const result = await this.executeCase(interaction.guild, actor, row);
      await interaction.reply({
        embeds: [this.resultEmbed(row, result)],
        ephemeral: true
      });
      return;
    }

    await interaction.reply({
      embeds: [this.previewEmbed(row)],
      components: [this.previewButtons(caseId)],
      ephemeral: true
    });
  }

  private async checkLimits(actor: GuildMember, actionType: ModerationCaseType): Promise<string | null> {
    const config = this.getConfig().moderation;
    let allowedLimit = -1;

    if (config.userLimits) {
      const userLimitEntry = config.userLimits.find((entry) => entry.targetId === actor.id);
      const userLimit = userLimitEntry?.limits.find((l) => l.actionType === actionType);
      if (userLimit !== undefined) {
        allowedLimit = userLimit.maxDaily;
      }
    }

    if (allowedLimit === -1 && config.roleLimits) {
      for (const roleId of actor.roles.cache.keys()) {
        const roleLimitEntry = config.roleLimits.find((entry) => entry.targetId === roleId);
        const roleLimit = roleLimitEntry?.limits.find((l) => l.actionType === actionType);
        if (roleLimit !== undefined && roleLimit.maxDaily > allowedLimit) {
          allowedLimit = roleLimit.maxDaily;
        }
      }
    }

    if (allowedLimit < 0) {
      return null;
    }

    const [row] = await this.sql<{ count: number }[]>`
      SELECT COUNT(*)::int as count 
      FROM moderation_actions 
      WHERE actor_id = ${actor.id} 
      AND action_type = ${actionType} 
      AND created_at >= (NOW() AT TIME ZONE 'UTC')::date
    `;

    const usage = row?.count ?? 0;
    if (usage >= allowedLimit) {
      return `Bugün için belirlenen max ${allowedLimit} ${LABELS[actionType]} limitinize ulaştınız. Gün bitene kadar daha fazla işlem yapamazsınız.`;
    }

    return null;
  }

  async handleButton(interaction: ButtonInteraction<"cached">) {
    const [prefix, action, rawCaseId] = interaction.customId.split(":");
    if (prefix !== "modcase") {
      return;
    }

    const caseId = Number(rawCaseId);
    if (!Number.isInteger(caseId) || caseId <= 0) {
      await interaction.reply({ content: "Vaka ID gecersiz.", ephemeral: true });
      return;
    }

    const row = await this.getCase(caseId);
    if (!row) {
      await interaction.reply({ content: "Vaka bulunamadi.", ephemeral: true });
      return;
    }

    if (row.actor_id !== interaction.user.id) {
      await interaction.reply({
        content: "Bu vaka sadece olusturan moderator tarafindan yonetilebilir.",
        ephemeral: true
      });
      return;
    }

    if (action === "edit") {
      if (row.status !== "pending") {
        await interaction.reply({ content: "Vaka artik duzenlenemez.", ephemeral: true });
        return;
      }
      const modal = new ModalBuilder()
        .setCustomId(`modreason:${caseId}`)
        .setTitle("Sebebi Düzenle")
        .addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId("reason")
              .setLabel("Yeni sebep")
              .setRequired(true)
              .setStyle(TextInputStyle.Paragraph)
              .setValue(row.reason ?? "Sebep belirtilmedi.")
          )
        );
      await interaction.showModal(modal);
      return;
    }

    if (action === "cancel") {
      await this.updateCaseStatus(caseId, "cancelled", interaction.user.id, { note: "İşlem iptal edildi." });
      await interaction.update({
        embeds: [this.staticEmbed(row, "İşlem iptal edildi.", "cancelled")],
        components: []
      });
      return;
    }

    if (action !== "confirm") {
      await interaction.reply({ content: "Bilinmeyen aksiyon.", ephemeral: true });
      return;
    }

    if (row.status !== "pending") {
      await interaction.reply({ content: "Bu vaka zaten islenmis.", ephemeral: true });
      return;
    }

    const actor = interaction.member;
    if (!(actor instanceof GuildMember)) {
      await interaction.reply({ content: "Moderatör bilgisi alınamadı.", ephemeral: true });
      return;
    }

    if (this.policyService) {
      const policyResult = await this.policyService.checkAction(actor, row.case_type);
      if (!policyResult.allowed) {
        await interaction.reply({ content: policyResult.reason ?? "Bu işlem için yetkiniz yok.", ephemeral: true });
        return;
      }
    }

    const limitError = await this.checkLimits(actor, row.case_type);
    if (limitError) {
      await interaction.reply({ content: limitError, ephemeral: true });
      return;
    }

    await interaction.deferUpdate();
    const result = await this.executeCase(interaction.guild, actor, row);
    await interaction.editReply({
      embeds: [this.resultEmbed(row, result)],
      components: []
    });
  }

  async handleModal(interaction: ModalSubmitInteraction<"cached">) {
    const [prefix, rawCaseId] = interaction.customId.split(":");
    if (prefix !== "modreason") {
      return;
    }

    const caseId = Number(rawCaseId);
    if (!Number.isInteger(caseId) || caseId <= 0) {
      await interaction.reply({ content: "Vaka ID gecersiz.", ephemeral: true });
      return;
    }

    const row = await this.getCase(caseId);
    if (!row || row.actor_id !== interaction.user.id || row.status !== "pending") {
      await interaction.reply({ content: "Vaka artik duzenlenemez.", ephemeral: true });
      return;
    }

    const reason = this.normalizeReason(interaction.fields.getTextInputValue("reason"));
    await this.sql`
      UPDATE moderation_cases
      SET reason = ${reason}
      WHERE id = ${caseId}
    `;
    await this.recordEvent(caseId, row.guild_id, "reason_updated", interaction.user.id, { reason });

    const refreshed = await this.getCase(caseId);
    await interaction.reply({
      embeds: [this.previewEmbed(refreshed ?? row)],
      components: [this.previewButtons(caseId)],
      ephemeral: true
    });
  }

  async processExpiredJails(guild: Guild) {
    const rows = await this.sql<CaseRow[]>`
      SELECT
        id,
        guild_id::text,
        case_type,
        status,
        target_type,
        target_id::text,
        actor_id::text,
        reason,
        dm_requested,
        dm_status,
        proof_url,
        points,
        duration_seconds,
        expires_at,
        metadata,
        created_at,
        resolved_at
      FROM moderation_cases
      WHERE guild_id = ${guild.id}
        AND case_type = 'jail'
        AND status = 'active'
        AND expires_at IS NOT NULL
        AND expires_at <= NOW()
      ORDER BY expires_at ASC
      LIMIT 10
    `;

    for (const row of rows) {
      try {
        await this.releaseExpiredJail(guild, row);
      } catch (error) {
        this.logger.error({ error, guildId: guild.id, caseId: row.id }, "Expired jail release failed.");
      }
    }
  }

  private resolveCommandName(interaction: ChatInputCommandInteraction<"cached">): CommandName | null {
    if (interaction.commandName === "mod") {
      const subcommand = interaction.options.getSubcommand();
      if (subcommand === "ban" || subcommand === "kick") {
        return subcommand;
      }
      return null;
    }

    const raw = interaction.commandName as CommandName;
    return [
      "ban",
      "unban",
      "kick",
      "timeout",
      "untimeout",
      "softban",
      "warn",
      "unwarn",
      "history",
      "jail",
      "unjail",
      "purge",
      "lock",
      "unlock",
      "slowmode"
    ].includes(raw)
      ? raw
      : null;
  }

  private async handleHistory(
    interaction: ChatInputCommandInteraction<"cached">,
    actor: GuildMember
  ) {
    if (!this.memberService.canViewHistory(actor)) {
      await interaction.reply({ content: "Bu komutu kullanma yetkin yok.", ephemeral: true });
      return;
    }

    const target = interaction.options.getUser("uye", true);
    const [summary] = await this.sql<{ active_cases: number; warn_points: number }[]>`
      SELECT
        COUNT(*) FILTER (WHERE status = 'active')::int AS active_cases,
        COALESCE(SUM(points) FILTER (WHERE case_type = 'warn' AND status = 'active'), 0)::int AS warn_points
      FROM moderation_cases
      WHERE guild_id = ${interaction.guildId}
        AND target_type = 'member'
        AND target_id = ${target.id}
    `;
    const cases = await this.sql<{
      id: number;
      case_type: ModerationCaseType;
      status: ModerationCaseStatus;
      reason: string | null;
      points: number;
      duration_seconds: number | null;
      created_at: Date;
    }[]>`
      SELECT id, case_type, status, reason, points, duration_seconds, created_at
      FROM moderation_cases
      WHERE guild_id = ${interaction.guildId}
        AND target_type = 'member'
        AND target_id = ${target.id}
      ORDER BY created_at DESC
      LIMIT 10
    `;
    const actions = await this.sql<{
      id: number;
      action_type: ModerationCaseType;
      reason: string | null;
      created_at: Date;
    }[]>`
      SELECT id, action_type, reason, created_at
      FROM moderation_actions
      WHERE guild_id = ${interaction.guildId}
        AND target_type = 'member'
        AND target_id = ${target.id}
      ORDER BY created_at DESC
      LIMIT 10
    `;

    const embed = createCommandEmbed({
      tone: "neutral",
      title: `${target.displayName ?? target.username} • Moderasyon Geçmişi`,
      description: "Aktif vakalar, warn puanı ve son işlem kayıtları tek kartta toplandı.",
      authorName: actor.displayName,
      authorIcon: actor.displayAvatarURL(),
      thumbnail: target.displayAvatarURL(),
      fields: [
        { name: "Aktif Vaka", value: String(summary?.active_cases ?? 0), inline: true },
        { name: "Aktif Warn Puanı", value: String(summary?.warn_points ?? 0), inline: true },
        {
          name: "Son Vakalar",
          value:
            cases.length > 0
              ? cases
                  .map((item) => {
                    const bits = [`#${item.id}`, LABELS[item.case_type], this.statusLabel(item.status)];
                    if (item.points > 0) bits.push(`${item.points} puan`);
                    if (item.duration_seconds) bits.push(this.formatDuration(item.duration_seconds));
                    return `${bits.join(" • ")}\n${item.reason ?? "Sebep belirtilmedi."}`;
                  })
                  .join("\n\n")
              : "Kayıt bulunmuyor."
        },
        {
          name: "Son İşlem Kayıtları",
          value:
            actions.length > 0
              ? actions
                  .map(
                    (item) =>
                      `#${item.id} • ${LABELS[item.action_type]} • ${this.formatDate(item.created_at)}\n${item.reason ?? "Sebep belirtilmedi."}`
                  )
                  .join("\n\n")
              : "İşlem bulunmuyor."
        }
      ],
      footer: "Supervisor Discord Bot • Moderasyon Arşivi"
    });

    await interaction.reply({ embeds: [embed], ephemeral: true });
  }

  private async buildDraft(
    interaction: ChatInputCommandInteraction<"cached">,
    actor: GuildMember,
    commandName: Exclude<CommandName, "history">
  ): Promise<Draft | null> {
    switch (commandName) {
      case "ban":
        return this.buildBanDraft(interaction, actor);
      case "unban":
        return this.buildUnbanDraft(interaction, actor);
      case "kick":
        return this.buildKickDraft(interaction, actor);
      case "timeout":
        return this.buildTimeoutDraft(interaction, actor);
      case "untimeout":
        return this.buildUntimeoutDraft(interaction, actor);
      case "softban":
        return this.buildSoftbanDraft(interaction, actor);
      case "warn":
        return this.buildWarnDraft(interaction, actor);
      case "unwarn":
        return this.buildUnwarnDraft(interaction, actor);
      case "jail":
        return this.buildJailDraft(interaction, actor);
      case "unjail":
        return this.buildUnjailDraft(interaction, actor);
      case "purge":
        return this.buildPurgeDraft(interaction, actor);
      case "lock":
        return this.buildLockDraft(interaction, actor);
      case "unlock":
        return this.buildUnlockDraft(interaction, actor);
      case "slowmode":
        return this.buildSlowmodeDraft(interaction, actor);
      default:
        return null;
    }
  }

  private async buildBanDraft(interaction: ChatInputCommandInteraction<"cached">, actor: GuildMember): Promise<Draft | null> {
    if (!this.memberService.canBan(actor)) {
      await this.noPermission(interaction);
      return null;
    }
    const targetUser = interaction.options.getUser("uye", true);
    const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
    if (targetMember && !this.checkTarget(interaction, actor, targetMember, "ban")) {
      return null;
    }
    const isBanned = await interaction.guild.bans.fetch(targetUser.id).catch(() => null);
    if (isBanned) {
      await interaction.reply({ content: "Bu kullanici zaten banli.", ephemeral: true });
      return null;
    }
    const deleteDays = interaction.options.getInteger("mesaj_silme_gunu") ?? 0;
    const isGlobal = interaction.options.getBoolean("global") ?? false;
    return {
      caseType: "ban",
      targetType: "member",
      targetId: targetUser.id,
      targetLabel: targetMember?.displayName ?? targetUser.tag,
      reason: this.normalizeReason(interaction.options.getString("sebep")),
      dmRequested: this.dmPreference(interaction.options.getBoolean("dm_bildir")),
      proofUrl: this.optionalValue(interaction.options.getString("kanit")),
      points: 0,
      durationSeconds: null,
      expiresAt: null,
      title: "Ban onayı",
      description: `${targetMember?.displayName ?? targetUser.tag} kullanıcısı banlanacak.`,
      tone: "critical",
      metadata: { deleteMessageDays: deleteDays, global: isGlobal }
    };
  }

  private async buildUnbanDraft(interaction: ChatInputCommandInteraction<"cached">, actor: GuildMember): Promise<Draft | null> {
    if (!this.memberService.canUnban(actor)) {
      await this.noPermission(interaction);
      return null;
    }
    const userId = this.snowflake(interaction.options.getString("kullanici_id", true));
    if (!userId) {
      await interaction.reply({ content: "Gecerli bir kullanici ID gir.", ephemeral: true });
      return null;
    }
    const ban = await interaction.guild.bans.fetch(userId).catch(() => null);
    if (!ban) {
      await interaction.reply({ content: "Bu kullanici banli degil.", ephemeral: true });
      return null;
    }
    const activeCase = await this.findActiveCase(interaction.guildId, "member", userId, "ban");
    return {
      caseType: "unban",
      targetType: "member",
      targetId: userId,
      targetLabel: ban.user.tag,
      reason: this.normalizeReason(interaction.options.getString("sebep")),
      dmRequested: this.dmPreference(interaction.options.getBoolean("dm_bildir")),
      proofUrl: null,
      points: 0,
      durationSeconds: null,
      expiresAt: null,
      title: "Ban kaldırma onayı",
      description: `${ban.user.tag} kullanıcısının banı kaldırılacak.`,
      tone: "neutral",
      metadata: { revertedCaseId: activeCase?.id ?? null }
    };
  }

  private async buildKickDraft(interaction: ChatInputCommandInteraction<"cached">, actor: GuildMember): Promise<Draft | null> {
    if (!this.memberService.canKick(actor)) {
      await this.noPermission(interaction);
      return null;
    }
    const targetUser = interaction.options.getUser("uye", true);
    const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
    if (!targetMember) {
      await interaction.reply({ content: "Kick icin uye sunucuda bulunmali.", ephemeral: true });
      return null;
    }
    if (!this.checkTarget(interaction, actor, targetMember, "kick")) {
      return null;
    }
    return {
      caseType: "kick",
      targetType: "member",
      targetId: targetMember.id,
      targetLabel: targetMember.displayName,
      reason: this.normalizeReason(interaction.options.getString("sebep")),
      dmRequested: this.dmPreference(interaction.options.getBoolean("dm_bildir")),
      proofUrl: this.optionalValue(interaction.options.getString("kanit")),
      points: 0,
      durationSeconds: null,
      expiresAt: null,
      title: "Kick onayı",
      description: `${targetMember.displayName} sunucudan atılacak.`,
      tone: "critical",
      metadata: {}
    };
  }

  private async buildTimeoutDraft(interaction: ChatInputCommandInteraction<"cached">, actor: GuildMember): Promise<Draft | null> {
    if (!this.memberService.canTimeout(actor)) {
      await this.noPermission(interaction);
      return null;
    }
    const targetUser = interaction.options.getUser("uye", true);
    const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
    if (!targetMember) {
      await interaction.reply({ content: "Timeout icin uye sunucuda bulunmali.", ephemeral: true });
      return null;
    }
    if (!this.checkTarget(interaction, actor, targetMember, "timeout")) {
      return null;
    }
    const durationMinutes =
      interaction.options.getInteger("sure_dakika") ?? this.getConfig().moderation.defaultTimeoutMinutes;
    return {
      caseType: "timeout",
      targetType: "member",
      targetId: targetMember.id,
      targetLabel: targetMember.displayName,
      reason: this.normalizeReason(interaction.options.getString("sebep")),
      dmRequested: this.dmPreference(interaction.options.getBoolean("dm_bildir")),
      proofUrl: this.optionalValue(interaction.options.getString("kanit")),
      points: 0,
      durationSeconds: durationMinutes * 60,
      expiresAt: new Date(Date.now() + durationMinutes * 60 * 1000),
      title: "Timeout onayı",
      description: `${targetMember.displayName} ${durationMinutes} dakika timeout alacak.`,
      tone: "warning",
      metadata: { durationMinutes }
    };
  }

  private async buildUntimeoutDraft(interaction: ChatInputCommandInteraction<"cached">, actor: GuildMember): Promise<Draft | null> {
    if (!this.memberService.canTimeout(actor)) {
      await this.noPermission(interaction);
      return null;
    }
    const targetUser = interaction.options.getUser("uye", true);
    const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
    if (!targetMember) {
      await interaction.reply({ content: "Uye sunucuda bulunmuyor.", ephemeral: true });
      return null;
    }
    const activeCase = await this.findActiveCase(interaction.guildId, "member", targetMember.id, "timeout");
    const live = (targetMember.communicationDisabledUntilTimestamp ?? 0) > Date.now();
    if (!activeCase && !live) {
      await interaction.reply({ content: "Bu uyede aktif timeout yok.", ephemeral: true });
      return null;
    }
    return {
      caseType: "untimeout",
      targetType: "member",
      targetId: targetMember.id,
      targetLabel: targetMember.displayName,
      reason: this.normalizeReason(interaction.options.getString("sebep")),
      dmRequested: false,
      proofUrl: null,
      points: 0,
      durationSeconds: null,
      expiresAt: null,
      title: "Timeout kaldırma onayı",
      description: `${targetMember.displayName} üyesindeki timeout kaldırılacak.`,
      tone: "neutral",
      metadata: { revertedCaseId: activeCase?.id ?? null }
    };
  }

  private async buildSoftbanDraft(interaction: ChatInputCommandInteraction<"cached">, actor: GuildMember): Promise<Draft | null> {
    if (!this.memberService.canBan(actor)) {
      await this.noPermission(interaction);
      return null;
    }
    const targetUser = interaction.options.getUser("uye", true);
    const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
    if (!targetMember) {
      await interaction.reply({ content: "Softban icin uye sunucuda bulunmali.", ephemeral: true });
      return null;
    }
    if (!this.checkTarget(interaction, actor, targetMember, "ban")) {
      return null;
    }
    const deleteDays = interaction.options.getInteger("mesaj_silme_gunu") ?? 1;
    return {
      caseType: "softban",
      targetType: "member",
      targetId: targetMember.id,
      targetLabel: targetMember.displayName,
      reason: this.normalizeReason(interaction.options.getString("sebep")),
      dmRequested: this.dmPreference(interaction.options.getBoolean("dm_bildir")),
      proofUrl: null,
      points: 0,
      durationSeconds: null,
      expiresAt: null,
      title: "Softban onayı",
      description: `${targetMember.displayName} banlanıp hemen banı kaldırılacak.`,
      tone: "warning",
      metadata: { deleteMessageDays: deleteDays }
    };
  }

  private async buildWarnDraft(interaction: ChatInputCommandInteraction<"cached">, actor: GuildMember): Promise<Draft | null> {
    if (!this.memberService.canWarn(actor)) {
      await this.noPermission(interaction);
      return null;
    }
    const targetUser = interaction.options.getUser("uye", true);
    const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
    if (!targetMember) {
      await interaction.reply({ content: "Warn icin uye sunucuda bulunmali.", ephemeral: true });
      return null;
    }
    if (!this.checkTarget(interaction, actor, targetMember, "timeout")) {
      return null;
    }
    const points = interaction.options.getInteger("puan") ?? this.getConfig().moderation.defaultWarnPoints;
    return {
      caseType: "warn",
      targetType: "member",
      targetId: targetMember.id,
      targetLabel: targetMember.displayName,
      reason: this.normalizeReason(interaction.options.getString("sebep")),
      dmRequested: this.dmPreference(interaction.options.getBoolean("dm_bildir")),
      proofUrl: this.optionalValue(interaction.options.getString("kanit")),
      points,
      durationSeconds: null,
      expiresAt: null,
      title: "Warn onayı",
      description: `${targetMember.displayName} kullanıcısına ${points} puanlık warn verilecek.`,
      tone: "warning",
      metadata: {}
    };
  }

  private async buildUnwarnDraft(interaction: ChatInputCommandInteraction<"cached">, actor: GuildMember): Promise<Draft | null> {
    if (!this.memberService.canWarn(actor)) {
      await this.noPermission(interaction);
      return null;
    }
    const targetCase = await this.getCase(interaction.options.getInteger("vaka_id", true));
    if (!targetCase || targetCase.case_type !== "warn" || targetCase.status !== "active") {
      await interaction.reply({ content: "Aktif warn vakasi bulunamadi.", ephemeral: true });
      return null;
    }
    return {
      caseType: "unwarn",
      targetType: "member",
      targetId: targetCase.target_id,
      targetLabel: `<@${targetCase.target_id}>`,
      reason: this.normalizeReason(interaction.options.getString("sebep")),
      dmRequested: false,
      proofUrl: null,
      points: 0,
      durationSeconds: null,
      expiresAt: null,
      title: "Warn kaldırma onayı",
      description: `#${targetCase.id} warn vakası kaldırılacak.`,
      tone: "neutral",
      metadata: { revertedCaseId: targetCase.id }
    };
  }

  private async buildJailDraft(interaction: ChatInputCommandInteraction<"cached">, actor: GuildMember): Promise<Draft | null> {
    if (!this.memberService.canJail(actor)) {
      await this.noPermission(interaction);
      return null;
    }
    const jailRoleId = this.getConfig().moderation.jailRoleId;
    if (!jailRoleId) {
      await interaction.reply({ content: "Jail rolu ayarlarda secilmemis.", ephemeral: true });
      return null;
    }
    const targetUser = interaction.options.getUser("uye", true);
    const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
    if (!targetMember) {
      await interaction.reply({ content: "Jail icin uye sunucuda bulunmali.", ephemeral: true });
      return null;
    }
    if (!this.checkTarget(interaction, actor, targetMember, "jail")) {
      return null;
    }
    if (await this.findActiveCase(interaction.guildId, "member", targetMember.id, "jail")) {
      await interaction.reply({ content: "Bu uyede zaten aktif jail var.", ephemeral: true });
      return null;
    }
    const durationMinutes = interaction.options.getInteger("sure_dakika");
    return {
      caseType: "jail",
      targetType: "member",
      targetId: targetMember.id,
      targetLabel: targetMember.displayName,
      reason: this.normalizeReason(interaction.options.getString("sebep")),
      dmRequested: this.dmPreference(interaction.options.getBoolean("dm_bildir")),
      proofUrl: null,
      points: 0,
      durationSeconds: durationMinutes ? durationMinutes * 60 : null,
      expiresAt: durationMinutes ? new Date(Date.now() + durationMinutes * 60 * 1000) : null,
      title: "Jail onayı",
      description: durationMinutes
        ? `${targetMember.displayName} ${durationMinutes} dakika jail alacak.`
        : `${targetMember.displayName} süresiz jail alacak.`,
      tone: "warning",
      metadata: {
        jailRoleId,
        snapshotRoleIds: targetMember.roles.cache
          .filter((role) => role.id !== interaction.guild.id)
          .map((role) => role.id)
      }
    };
  }

  private async buildUnjailDraft(interaction: ChatInputCommandInteraction<"cached">, actor: GuildMember): Promise<Draft | null> {
    if (!this.memberService.canJail(actor)) {
      await this.noPermission(interaction);
      return null;
    }
    const targetUser = interaction.options.getUser("uye", true);
    const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
    if (!targetMember) {
      await interaction.reply({ content: "Uye sunucuda bulunmuyor.", ephemeral: true });
      return null;
    }
    const activeCase = await this.findActiveCase(interaction.guildId, "member", targetMember.id, "jail");
    if (!activeCase) {
      await interaction.reply({ content: "Bu uyede aktif jail yok.", ephemeral: true });
      return null;
    }
    const metadata = this.meta(activeCase);
    if (!Array.isArray(metadata.snapshotRoleIds)) {
      await interaction.reply({ content: "Jail snapshot kaydi bulunamadi.", ephemeral: true });
      return null;
    }
    return {
      caseType: "unjail",
      targetType: "member",
      targetId: targetMember.id,
      targetLabel: targetMember.displayName,
      reason: this.normalizeReason(interaction.options.getString("sebep")),
      dmRequested: false,
      proofUrl: null,
      points: 0,
      durationSeconds: null,
      expiresAt: null,
      title: "Jail kaldırma onayı",
      description: `${targetMember.displayName} üyesindeki jail kaldırılacak.`,
      tone: "neutral",
      metadata: { revertedCaseId: activeCase.id, snapshotRoleIds: metadata.snapshotRoleIds }
    };
  }

  private async buildPurgeDraft(interaction: ChatInputCommandInteraction<"cached">, actor: GuildMember): Promise<Draft | null> {
    if (!this.memberService.canModerateMessages(actor)) {
      await this.noPermission(interaction);
      return null;
    }
    const channel = this.purgeChannel(interaction);
    if (!channel) {
      return null;
    }
    const count = interaction.options.getInteger("sayi", true);
    const maxLimit = Math.max(1, this.getConfig().moderation.purgeMaxLimit);
    return {
      caseType: "purge",
      targetType: "channel",
      targetId: channel.id,
      targetLabel: `#${this.channelName(channel)}`,
      reason: "Mesaj temizliği uygulanacak.",
      dmRequested: false,
      proofUrl: null,
      points: 0,
      durationSeconds: null,
      expiresAt: null,
      title: "Purge onayı",
      description: `${this.channelName(channel)} kanalında mesaj temizliği uygulanacak.`,
      tone: "critical",
      metadata: {
        limit: Math.min(count, maxLimit),
        filterUserId: interaction.options.getUser("uye")?.id ?? null,
        onlyBots: Boolean(interaction.options.getBoolean("sadece_bot")),
        onlyLinks: Boolean(interaction.options.getBoolean("link_icerikleri")),
        onlyFiles: Boolean(interaction.options.getBoolean("dosya_icerikleri"))
      }
    };
  }

  private async buildLockDraft(interaction: ChatInputCommandInteraction<"cached">, actor: GuildMember): Promise<Draft | null> {
    if (!this.memberService.canModerateChannels(actor)) {
      await this.noPermission(interaction);
      return null;
    }
    const channel = this.lockChannel(interaction);
    if (!channel) {
      return null;
    }
    if (await this.findActiveCase(interaction.guildId, "channel", channel.id, "lock")) {
      await interaction.reply({ content: "Bu kanalda zaten aktif lock var.", ephemeral: true });
      return null;
    }
    return {
      caseType: "lock",
      targetType: "channel",
      targetId: channel.id,
      targetLabel: `#${this.channelName(channel)}`,
      reason: this.normalizeReason(interaction.options.getString("sebep")),
      dmRequested: false,
      proofUrl: null,
      points: 0,
      durationSeconds: null,
      expiresAt: null,
      title: "Lock onayı",
      description: `${this.channelName(channel)} kanalına lock uygulanacak.`,
      tone: "warning",
      metadata: {
        snapshot: channel.permissionOverwrites.cache.map((item) => ({
          id: item.id,
          type: item.type,
          allow: item.allow.bitfield.toString(),
          deny: item.deny.bitfield.toString()
        })),
        channelType: channel.type
      }
    };
  }

  private async buildUnlockDraft(interaction: ChatInputCommandInteraction<"cached">, actor: GuildMember): Promise<Draft | null> {
    if (!this.memberService.canModerateChannels(actor)) {
      await this.noPermission(interaction);
      return null;
    }
    const channel = this.lockChannel(interaction);
    if (!channel) {
      return null;
    }
    const activeCase = await this.findActiveCase(interaction.guildId, "channel", channel.id, "lock");
    if (!activeCase) {
      await interaction.reply({ content: "Bu kanalda aktif lock yok.", ephemeral: true });
      return null;
    }
    return {
      caseType: "unlock",
      targetType: "channel",
      targetId: channel.id,
      targetLabel: `#${this.channelName(channel)}`,
      reason: this.normalizeReason(interaction.options.getString("sebep")),
      dmRequested: false,
      proofUrl: null,
      points: 0,
      durationSeconds: null,
      expiresAt: null,
      title: "Unlock onayı",
      description: `${this.channelName(channel)} kanalındaki lock kaldırılacak.`,
      tone: "neutral",
      metadata: { revertedCaseId: activeCase.id, snapshot: this.meta(activeCase).snapshot ?? [] }
    };
  }

  private async buildSlowmodeDraft(interaction: ChatInputCommandInteraction<"cached">, actor: GuildMember): Promise<Draft | null> {
    if (!this.memberService.canModerateChannels(actor)) {
      await this.noPermission(interaction);
      return null;
    }
    const channel = this.slowmodeChannel(interaction);
    if (!channel) {
      return null;
    }
    const nextSlowmode = interaction.options.getInteger("saniye", true);
    return {
      caseType: "slowmode",
      targetType: "channel",
      targetId: channel.id,
      targetLabel: `#${this.channelName(channel)}`,
      reason: this.normalizeReason(interaction.options.getString("sebep")),
      dmRequested: false,
      proofUrl: null,
      points: 0,
      durationSeconds: null,
      expiresAt: null,
      title: "Slowmode onayı",
      description:
        nextSlowmode > 0
          ? `${this.channelName(channel)} kanalının slowmode değeri ${nextSlowmode} saniye olacak.`
          : `${this.channelName(channel)} kanalındaki slowmode kapatılacak.`,
      tone: "warning",
      metadata: { previousSlowmode: channel.rateLimitPerUser ?? 0, nextSlowmode }
    };
  }

  private async executeCase(guild: Guild, actor: GuildMember, row: CaseRow): Promise<ExecResult> {
    try {
      await this.recordEvent(row.id, row.guild_id, "confirmed", actor.id, {});
      const result = await this.applyCase(guild, actor, row);
      await this.logCase(guild, actor, row, result.summary, result.status);

      // Record policy action usage for RBAC tracking
      if (this.policyService && (result.status === "active" || result.status === "completed")) {
        try {
          await this.policyService.recordAction(actor, row.case_type);
        } catch {
          // Non-fatal: policy recording failure should not break moderation
        }
      }

      return result;
    } catch (error) {
      this.logger.error({ error, guildId: guild.id, caseId: row.id }, "Moderation case failed.");
      await this.updateCaseStatus(row.id, "failed", actor.id, { error: "Sunucu hatası" });
      return { status: "failed", summary: "İşlem sırasında sunucu taraflı bir hata oluştu." };
    }
  }

  private async applyCase(guild: Guild, actor: GuildMember, row: CaseRow): Promise<ExecResult> {
    switch (row.case_type) {
      case "ban":
        return this.applyBan(guild, actor, row);
      case "unban":
        return this.applyUnban(guild, actor, row);
      case "kick":
        return this.applyKick(guild, actor, row);
      case "timeout":
        return this.applyTimeout(guild, actor, row);
      case "untimeout":
        return this.applyUntimeout(guild, actor, row);
      case "softban":
        return this.applySoftban(guild, actor, row);
      case "warn":
        return this.applyWarn(guild, actor, row);
      case "unwarn":
        return this.applyUnwarn(guild, actor, row);
      case "jail":
        return this.applyJail(guild, actor, row);
      case "unjail":
        return this.applyUnjail(guild, actor, row);
      case "purge":
        return this.applyPurge(guild, actor, row);
      case "lock":
        return this.applyLock(guild, actor, row);
      case "unlock":
        return this.applyUnlock(guild, actor, row);
      case "slowmode":
        return this.applySlowmode(guild, actor, row);
      default:
        throw new Error("Desteklenmeyen vaka tipi.");
    }
  }

  private async applyBan(guild: Guild, actor: GuildMember, row: CaseRow): Promise<ExecResult> {
    const metadata = this.meta(row);
    const targetUser = await guild.client.users.fetch(row.target_id);
    const targetMember = await guild.members.fetch(row.target_id).catch(() => null);
    if (targetMember && !this.checkRuntimeTarget(actor, targetMember, "ban")) {
      throw new Error("Hedef uye banlanamiyor.");
    }
    const dm = await this.sendDm(guild, actor, targetUser, row);

    const isGlobal = Boolean(metadata.global);
    const globalBanEnabled = this.getConfig().moderation.globalBanEnabled;
    const shouldGlobalBan = isGlobal && globalBanEnabled;
    let summaryText = `${targetUser.tag} banlandi.`;

    if (shouldGlobalBan) {
      let successCount = 0;
      await Promise.allSettled(
        guild.client.guilds.cache.map(async (g) => {
          try {
            await g.members.ban(targetUser, {
              reason: row.reason ?? "Global ban",
              deleteMessageSeconds: Math.max(0, Number(metadata.deleteMessageDays ?? 0)) * 24 * 60 * 60
            });
            successCount++;
          } catch {
            // sessiz gec
          }
        })
      );
      summaryText = `${targetUser.tag} global olarak (${successCount} sunucudan) banlandi.`;
    } else {
      await guild.members.ban(targetUser, {
        reason: row.reason ?? undefined,
        deleteMessageSeconds: Math.max(0, Number(metadata.deleteMessageDays ?? 0)) * 24 * 60 * 60
      });
    }

    await this.memberService.syncMember(actor);
    await this.memberService.syncUserShell(guild.id, targetUser, "user");
    await this.completeCase(row, "active", actor.id, dm, metadata);
    await this.insertAction(row, actor.id, "member", metadata);
    return { status: "active", summary: summaryText, dm, extra: metadata };
  }

  private async applyUnban(guild: Guild, actor: GuildMember, row: CaseRow): Promise<ExecResult> {
    const metadata = this.meta(row);
    const targetUser = await guild.client.users.fetch(row.target_id);
    const dm = await this.sendDm(guild, actor, targetUser, row);
    await guild.bans.remove(row.target_id, row.reason ?? undefined);
    if (metadata.revertedCaseId) {
      await this.updateCaseStatus(Number(metadata.revertedCaseId), "removed", actor.id, { revertedBy: row.id });
    }
    await this.completeCase(row, "completed", actor.id, dm, metadata);
    await this.insertAction(row, actor.id, "member", metadata);
    return { status: "completed", summary: `${targetUser.tag} kullanıcısındaki ban kaldırıldı.`, dm, extra: metadata };
  }

  private async applyKick(guild: Guild, actor: GuildMember, row: CaseRow): Promise<ExecResult> {
    const targetMember = await guild.members.fetch(row.target_id);
    if (!this.checkRuntimeTarget(actor, targetMember, "kick")) {
      throw new Error("Hedef uye kicklenemiyor.");
    }
    const dm = await this.sendDm(guild, actor, targetMember.user, row);
    await targetMember.kick(row.reason ?? undefined);
    await this.completeCase(row, "completed", actor.id, dm, {});
    await this.insertAction(row, actor.id, "member", {});
    return { status: "completed", summary: `${targetMember.displayName} sunucudan atildi.`, dm };
  }

  private async applyTimeout(guild: Guild, actor: GuildMember, row: CaseRow): Promise<ExecResult> {
    const targetMember = await guild.members.fetch(row.target_id);
    if (!this.checkRuntimeTarget(actor, targetMember, "timeout")) {
      throw new Error("Hedef uye timeout alamiyor.");
    }
    const dm = await this.sendDm(guild, actor, targetMember.user, row);
    await targetMember.timeout(Math.max(60, row.duration_seconds ?? 60) * 1000, row.reason ?? undefined);
    await this.completeCase(row, "active", actor.id, dm, { durationSeconds: row.duration_seconds });
    await this.insertAction(row, actor.id, "member", { durationSeconds: row.duration_seconds });
    return {
      status: "active",
      summary: `${targetMember.displayName} ${this.formatDuration(row.duration_seconds)} timeout aldi.`,
      dm,
      extra: { durationSeconds: row.duration_seconds }
    };
  }

  private async applyUntimeout(guild: Guild, actor: GuildMember, row: CaseRow): Promise<ExecResult> {
    const targetMember = await guild.members.fetch(row.target_id);
    await targetMember.timeout(null, row.reason ?? undefined);
    const metadata = this.meta(row);
    if (metadata.revertedCaseId) {
      await this.updateCaseStatus(Number(metadata.revertedCaseId), "removed", actor.id, { revertedBy: row.id });
    }
    await this.completeCase(row, "completed", actor.id, { status: "skipped", note: "DM gönderilmedi." }, metadata);
    await this.insertAction(row, actor.id, "member", metadata);
    return { status: "completed", summary: `${targetMember.displayName} kullanıcısındaki timeout kaldırıldı.`, extra: metadata };
  }

  private async applySoftban(guild: Guild, actor: GuildMember, row: CaseRow): Promise<ExecResult> {
    const metadata = this.meta(row);
    const targetMember = await guild.members.fetch(row.target_id);
    if (!this.checkRuntimeTarget(actor, targetMember, "ban")) {
      throw new Error("Hedef uye softban alamiyor.");
    }
    const dm = await this.sendDm(guild, actor, targetMember.user, row);
    const deleteMessageDays = Math.max(0, Number(metadata.deleteMessageDays ?? 1));
    await guild.members.ban(targetMember.user, {
      reason: row.reason ?? undefined,
      deleteMessageSeconds: deleteMessageDays * 24 * 60 * 60
    });
    await guild.bans.remove(targetMember.id, `Softban kaldirildi: ${row.reason ?? "Sebep belirtilmedi."}`);
    await this.completeCase(row, "completed", actor.id, dm, { deleteMessageDays });
    await this.insertAction(row, actor.id, "member", { deleteMessageDays });
    return { status: "completed", summary: `${targetMember.displayName} kullanıcısına softban uygulandı.`, dm, extra: { deleteMessageDays } };
  }

  private async applyWarn(guild: Guild, actor: GuildMember, row: CaseRow): Promise<ExecResult> {
    const targetMember = await guild.members.fetch(row.target_id);
    const dm = await this.sendDm(guild, actor, targetMember.user, row);
    await this.completeCase(row, "active", actor.id, dm, { points: row.points });
    await this.insertAction(row, actor.id, "member", { points: row.points });
    return { status: "active", summary: `${targetMember.displayName} kullanıcısına ${row.points} puan warn verildi.`, dm, extra: { points: row.points } };
  }

  private async applyUnwarn(_guild: Guild, actor: GuildMember, row: CaseRow): Promise<ExecResult> {
    const metadata = this.meta(row);
    if (metadata.revertedCaseId) {
      await this.updateCaseStatus(Number(metadata.revertedCaseId), "removed", actor.id, { revertedBy: row.id });
    }
    await this.completeCase(row, "completed", actor.id, { status: "skipped", note: "DM gönderilmedi." }, metadata);
    await this.insertAction(row, actor.id, "member", metadata);
    return { status: "completed", summary: `Warn vakasi kaldirildi.`, extra: metadata };
  }

  private async applyJail(guild: Guild, actor: GuildMember, row: CaseRow): Promise<ExecResult> {
    const metadata = this.meta(row);
    const targetMember = await guild.members.fetch(row.target_id);
    if (!this.checkRuntimeTarget(actor, targetMember, "jail")) {
      throw new Error("Hedef uye jail alamiyor.");
    }
    const jailRoleId = String(metadata.jailRoleId ?? this.getConfig().moderation.jailRoleId ?? "");
    const snapshotRoleIds = Array.isArray(metadata.snapshotRoleIds) ? metadata.snapshotRoleIds.map(String) : [];
    if (!jailRoleId || snapshotRoleIds.length === 0) {
      throw new Error("Jail snapshot kaydi eksik.");
    }
    const botMember = guild.members.me;
    const preserved = targetMember.roles.cache
      .filter((role) => role.id !== guild.id && (role.id === jailRoleId || role.managed || Boolean(botMember && role.position >= botMember.roles.highest.position)))
      .map((role) => role.id);
    const nextRoles = Array.from(new Set([...preserved, jailRoleId]));
    const dm = await this.sendDm(guild, actor, targetMember.user, row);
    await targetMember.roles.set(nextRoles, row.reason ?? undefined);
    await this.completeCase(row, "active", actor.id, dm, { preservedRoleIds: preserved, appliedRoleIds: nextRoles });
    await this.insertAction(row, actor.id, "member", { durationSeconds: row.duration_seconds, jailRoleId });
    return {
      status: "active",
      summary: row.duration_seconds
        ? `${targetMember.displayName} ${this.formatDuration(row.duration_seconds)} jail aldi.`
        : `${targetMember.displayName} süresiz jail aldı.`,
      dm,
      extra: { jailRoleId }
    };
  }

  private async applyUnjail(guild: Guild, actor: GuildMember, row: CaseRow): Promise<ExecResult> {
    const metadata = this.meta(row);
    const targetMember = await guild.members.fetch(row.target_id);
    const snapshotRoleIds = Array.isArray(metadata.snapshotRoleIds) ? metadata.snapshotRoleIds.map(String) : [];
    if (snapshotRoleIds.length === 0) {
      throw new Error("Jail snapshot kaydi bulunamadi.");
    }
    const botMember = guild.members.me;
    const preserved = targetMember.roles.cache
      .filter((role) => role.id !== guild.id && (role.managed || Boolean(botMember && role.position >= botMember.roles.highest.position)))
      .map((role) => role.id);
    const restorable = snapshotRoleIds.filter((roleId) => guild.roles.cache.has(roleId));
    const nextRoles = Array.from(new Set([...preserved, ...restorable]));
    await targetMember.roles.set(nextRoles, row.reason ?? undefined);
    if (metadata.revertedCaseId) {
      await this.updateCaseStatus(Number(metadata.revertedCaseId), "removed", actor.id, { revertedBy: row.id });
    }
    await this.completeCase(row, "completed", actor.id, { status: "skipped", note: "DM gönderilmedi." }, { restoredRoleCount: nextRoles.length });
    await this.insertAction(row, actor.id, "member", { restoredRoleCount: nextRoles.length });
    return { status: "completed", summary: `${targetMember.displayName} kullanıcısındaki jail kaldırıldı.`, extra: { restoredRoleCount: nextRoles.length } };
  }

  private async applyPurge(guild: Guild, actor: GuildMember, row: CaseRow): Promise<ExecResult> {
    const metadata = this.meta(row);
    const channel = await guild.channels.fetch(row.target_id);
    if (!channel || !this.isMessageChannel(channel)) {
      throw new Error("Kanal mesaj temizligi icin uygun degil.");
    }
    const limit = Math.max(1, Number(metadata.limit ?? 1));
    const filterUserId = metadata.filterUserId ? String(metadata.filterUserId) : null;
    const onlyBots = Boolean(metadata.onlyBots);
    const onlyLinks = Boolean(metadata.onlyLinks);
    const onlyFiles = Boolean(metadata.onlyFiles);
    const matches: Message[] = [];
    let before: string | undefined;
    let scannedCount = 0;
    for (let cycle = 0; cycle < 10 && matches.length < limit; cycle += 1) {
      const batch = await channel.messages.fetch({ limit: 100, before });
      if (!batch.size) break;
      for (const message of batch.values()) {
        scannedCount += 1;
        if (this.matchesPurge(message, filterUserId, onlyBots, onlyLinks, onlyFiles)) {
          matches.push(message);
        }
        if (matches.length >= limit) break;
      }
      before = batch.last()?.id;
      if (!before || batch.size < 100) break;
    }
    const threshold = Date.now() - 14 * 24 * 60 * 60 * 1000;
    const deletable = matches.filter((item) => item.createdTimestamp >= threshold);
    const skippedOld = matches.length - deletable.length;
    let deletedCount = 0;
    for (let i = 0; i < deletable.length; i += 100) {
      const chunk = deletable.slice(i, i + 100);
      if (chunk.length === 1) {
        await chunk[0].delete().catch(() => undefined);
        deletedCount += 1;
      } else if (chunk.length > 1) {
        const result = await channel.bulkDelete(chunk, true);
        deletedCount += result.size;
      }
    }
    const payload = { scannedCount, deletedCount, skippedOld, limit, filterUserId, onlyBots, onlyLinks, onlyFiles };
    await this.completeCase(row, "completed", actor.id, { status: "skipped", note: "DM gönderilmedi." }, payload);
    await this.insertAction(row, actor.id, "channel", payload);
    return {
      status: "completed",
      summary: `${deletedCount} mesaj silindi.${skippedOld > 0 ? ` ${skippedOld} eski mesaj atlandi.` : ""}`,
      extra: payload
    };
  }

  private async applyLock(guild: Guild, actor: GuildMember, row: CaseRow): Promise<ExecResult> {
    const channel = await guild.channels.fetch(row.target_id);
    if (!channel || !("permissionOverwrites" in channel)) {
      throw new Error("Kanal lock icin uygun degil.");
    }
    await channel.permissionOverwrites.edit(guild.roles.everyone, this.lockOverwrite(channel.type), { reason: row.reason ?? undefined });
    await this.completeCase(row, "active", actor.id, { status: "skipped", note: "DM gönderilmedi." }, {});
    await this.insertAction(row, actor.id, "channel", {});
    return { status: "active", summary: `${this.target(row)} kanalına lock uygulandı.` };
  }

  private async applyUnlock(guild: Guild, actor: GuildMember, row: CaseRow): Promise<ExecResult> {
    const metadata = this.meta(row);
    const channel = await guild.channels.fetch(row.target_id);
    if (!channel || !("permissionOverwrites" in channel)) {
      throw new Error("Kanal unlock icin uygun degil.");
    }
    const snapshot = Array.isArray(metadata.snapshot) ? metadata.snapshot : [];
    await channel.permissionOverwrites.set(
      snapshot.map((item) => {
        const value = item as Record<string, unknown>;
        return {
          id: String(value.id ?? ""),
          type: Number(value.type ?? 0),
          allow: BigInt(String(value.allow ?? "0")),
          deny: BigInt(String(value.deny ?? "0"))
        };
      }),
      row.reason ?? undefined
    );
    if (metadata.revertedCaseId) {
      await this.updateCaseStatus(Number(metadata.revertedCaseId), "removed", actor.id, { revertedBy: row.id });
    }
    await this.completeCase(row, "completed", actor.id, { status: "skipped", note: "DM gönderilmedi." }, metadata);
    await this.insertAction(row, actor.id, "channel", metadata);
    return { status: "completed", summary: `${this.target(row)} kanalındaki lock kaldırıldı.`, extra: metadata };
  }

  private async applySlowmode(guild: Guild, actor: GuildMember, row: CaseRow): Promise<ExecResult> {
    const metadata = this.meta(row);
    const channel = await guild.channels.fetch(row.target_id);
    if (!channel || !("setRateLimitPerUser" in channel)) {
      throw new Error("Bu kanal slowmode desteklemiyor.");
    }
    const nextSlowmode = Math.max(0, Math.min(21600, Number(metadata.nextSlowmode ?? 0)));
    await channel.setRateLimitPerUser(nextSlowmode, row.reason ?? undefined);
    await this.completeCase(row, "completed", actor.id, { status: "skipped", note: "DM gönderilmedi." }, metadata);
    await this.insertAction(row, actor.id, "channel", metadata);
    return {
      status: "completed",
      summary: nextSlowmode > 0 ? `${this.target(row)} kanalının slowmode değeri ${nextSlowmode} saniye oldu.` : `${this.target(row)} kanalındaki slowmode kapatıldı.`,
      extra: metadata
    };
  }

  private async releaseExpiredJail(guild: Guild, row: CaseRow) {
    const member = await guild.members.fetch(row.target_id).catch(() => null);
    if (!member) {
      await this.updateCaseStatus(row.id, "expired", guild.client.user?.id ?? "0", { note: "Uye bulunamadi." });
      return;
    }
    const metadata = this.meta(row);
    const snapshotRoleIds = Array.isArray(metadata.snapshotRoleIds) ? metadata.snapshotRoleIds.map(String) : [];
    if (snapshotRoleIds.length === 0) {
      await this.updateCaseStatus(row.id, "expired", guild.client.user?.id ?? "0", { note: "Snapshot kaydi eksik." });
      return;
    }
    const botMember = guild.members.me;
    const preserved = member.roles.cache
      .filter((role) => role.id !== guild.id && (role.managed || Boolean(botMember && role.position >= botMember.roles.highest.position)))
      .map((role) => role.id);
    const nextRoles = Array.from(new Set([...preserved, ...snapshotRoleIds.filter((roleId) => guild.roles.cache.has(roleId))]));
    await member.roles.set(nextRoles, "Jail süresi doldu");
    await this.updateCaseStatus(row.id, "expired", guild.client.user?.id ?? "0", { restoredRoleCount: nextRoles.length });
    await this.sql`
      INSERT INTO moderation_actions (
        guild_id,
        case_id,
        action_type,
        target_id,
        target_type,
        actor_id,
        reason,
        source,
        payload
      )
      VALUES (
        ${row.guild_id},
        ${row.id},
        'unjail',
        ${row.target_id},
        'member',
        ${guild.client.user?.id ?? "0"},
        ${"Jail süresi doldu"},
        'worker',
        ${JSON.stringify({ expired: true, restoredRoleCount: nextRoles.length })}::jsonb
      )
    `;
  }

  private async createPendingCase(guildId: string, actorId: string, draft: Draft) {
    const [row] = await this.sql<{ id: number }[]>`
      INSERT INTO moderation_cases (
        guild_id,
        case_type,
        status,
        target_type,
        target_id,
        actor_id,
        reason,
        dm_requested,
        proof_url,
        points,
        duration_seconds,
        expires_at,
        metadata
      )
      VALUES (
        ${guildId},
        ${draft.caseType},
        'pending',
        ${draft.targetType},
        ${draft.targetId},
        ${actorId},
        ${draft.reason},
        ${draft.dmRequested},
        ${draft.proofUrl},
        ${draft.points},
        ${draft.durationSeconds},
        ${draft.expiresAt},
        ${JSON.stringify({
          ...draft.metadata,
          targetLabel: draft.targetLabel,
          title: draft.title,
          description: draft.description,
          tone: draft.tone
        })}::jsonb
      )
      RETURNING id
    `;
    await this.recordEvent(row.id, guildId, "preview_created", actorId, { targetLabel: draft.targetLabel });
    return row.id;
  }

  private async getCase(caseId: number) {
    const [row] = await this.sql<CaseRow[]>`
      SELECT
        id,
        guild_id::text,
        case_type,
        status,
        target_type,
        target_id::text,
        actor_id::text,
        reason,
        dm_requested,
        dm_status,
        proof_url,
        points,
        duration_seconds,
        expires_at,
        metadata,
        created_at,
        resolved_at
      FROM moderation_cases
      WHERE id = ${caseId}
      LIMIT 1
    `;
    return row ?? null;
  }

  private async findActiveCase(guildId: string, targetType: ModerationTargetType, targetId: string, caseType: ModerationCaseType) {
    const [row] = await this.sql<CaseRow[]>`
      SELECT
        id,
        guild_id::text,
        case_type,
        status,
        target_type,
        target_id::text,
        actor_id::text,
        reason,
        dm_requested,
        dm_status,
        proof_url,
        points,
        duration_seconds,
        expires_at,
        metadata,
        created_at,
        resolved_at
      FROM moderation_cases
      WHERE guild_id = ${guildId}
        AND target_type = ${targetType}
        AND target_id = ${targetId}
        AND case_type = ${caseType}
        AND status = 'active'
      ORDER BY created_at DESC
      LIMIT 1
    `;
    return row ?? null;
  }

  private async completeCase(row: CaseRow, status: ModerationCaseStatus, actorId: string, dm: { status: "sent" | "failed" | "skipped"; note: string }, extra: Record<string, unknown>) {
    const shouldResolve = ["completed", "removed", "cancelled", "failed", "expired"].includes(status);
    await this.sql`
      UPDATE moderation_cases
      SET
        status = ${status},
        dm_status = ${dm.status},
        metadata = metadata || ${JSON.stringify(extra)}::jsonb,
        resolved_at = ${shouldResolve ? new Date() : null}
      WHERE id = ${row.id}
    `;
    await this.recordEvent(row.id, row.guild_id, "applied", actorId, {
      status,
      dmStatus: dm.status,
      dmNote: dm.note,
      ...extra
    });
  }

  private async updateCaseStatus(caseId: number, status: ModerationCaseStatus, actorId: string, payload: Record<string, unknown>) {
    const row = await this.getCase(caseId);
    if (!row) {
      return;
    }
    const shouldResolve = ["completed", "removed", "cancelled", "failed", "expired"].includes(status);
    await this.sql`
      UPDATE moderation_cases
      SET
        status = ${status},
        metadata = metadata || ${JSON.stringify(payload)}::jsonb,
        resolved_at = ${shouldResolve ? new Date() : null}
      WHERE id = ${caseId}
    `;
    await this.recordEvent(caseId, row.guild_id, `status_${status}`, actorId, payload);
  }

  private async insertAction(row: CaseRow, actorId: string, targetType: ModerationTargetType, payload: Record<string, unknown>) {
    await this.sql`
      INSERT INTO moderation_actions (
        guild_id,
        case_id,
        action_type,
        target_id,
        target_type,
        actor_id,
        reason,
        source,
        payload
      )
      VALUES (
        ${row.guild_id},
        ${row.id},
        ${row.case_type},
        ${row.target_id},
        ${targetType},
        ${actorId},
        ${row.reason},
        'bot',
        ${JSON.stringify(payload)}::jsonb
      )
    `;
  }

  private async recordEvent(caseId: number, guildId: string, eventType: string, actorId: string | null, payload: Record<string, unknown>) {
    await this.sql`
      INSERT INTO moderation_case_events (
        case_id,
        guild_id,
        event_type,
        actor_id,
        payload
      )
      VALUES (
        ${caseId},
        ${guildId},
        ${eventType},
        ${actorId},
        ${JSON.stringify(payload)}::jsonb
      )
    `;
  }

  private async sendDm(guild: Guild, actor: GuildMember, user: User, row: CaseRow) {
    if (!row.dm_requested) {
      return { status: "skipped" as const, note: "DM kapalı." };
    }
    try {
      const fields = [
        { name: "İşlem", value: LABELS[row.case_type], inline: true },
        { name: "Moderatör", value: actor.displayName, inline: true },
        { name: "Sebep", value: row.reason ?? "Sebep belirtilmedi.", inline: false }
      ];
      if (row.duration_seconds) {
        fields.push({ name: "Süre", value: this.formatDuration(row.duration_seconds), inline: true });
      }
      if (row.proof_url) {
        fields.push({ name: "Kanıt", value: row.proof_url, inline: false });
      }
      const embed = createCommandEmbed({
        tone: this.tone(row.case_type),
        title: `${LABELS[row.case_type]} Bildirimi`,
        description: `${guild.name} sunucusunda bir moderasyon işlemi uygulandı.`,
        authorName: actor.displayName,
        authorIcon: actor.displayAvatarURL(),
        thumbnail: guild.iconURL(),
        fields,
        footer: "Supervisor Discord Bot • Kullanıcı Bildirimi"
      });
      await user.send({ embeds: [embed] });
      return { status: "sent" as const, note: "DM gönderildi." };
    } catch (error) {
      this.logger.warn({ error, userId: user.id, caseId: row.id }, "Moderation DM failed.");
      return { status: "failed" as const, note: "DM gönderilemedi." };
    }
  }

  private async logCase(guild: Guild, actor: GuildMember, row: CaseRow, summary: string, status: ModerationCaseStatus) {
    const logChannelId = this.getConfig().moderation.logChannelId;
    if (!logChannelId) {
      return;
    }
    const channel = await guild.channels.fetch(logChannelId).catch(() => null);
    if (!channel || !channel.isTextBased() || !("send" in channel)) {
      return;
    }
    const fields = [
      { name: "Vaka", value: `#${row.id}`, inline: true },
      { name: "Durum", value: this.statusLabel(status), inline: true },
      { name: "Moderatör", value: `<@${actor.id}>`, inline: true },
      { name: "Hedef", value: this.target(row), inline: true }
    ];
    if (row.reason) {
      fields.push({ name: "Sebep", value: row.reason, inline: false });
    }
    if (row.proof_url) {
      fields.push({ name: "Kanıt", value: row.proof_url, inline: false });
    }
    const embed = createCommandEmbed({
      tone: this.tone(row.case_type),
      title: `${LABELS[row.case_type]} Logu`,
      description: summary,
      authorName: guild.name,
      authorIcon: guild.iconURL(),
      fields,
      footer: "Supervisor Discord Bot • Moderasyon Logu"
    });
    await channel.send({ embeds: [embed] });
  }

  private previewButtons(caseId: number) {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`modcase:confirm:${caseId}`)
        .setLabel("Onayla")
        .setEmoji("✅")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`modcase:edit:${caseId}`)
        .setLabel("Sebebi Düzenle")
        .setEmoji("✏️")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`modcase:cancel:${caseId}`)
        .setLabel("Vazgeç")
        .setEmoji("🛑")
        .setStyle(ButtonStyle.Secondary)
    );
  }

  private previewEmbed(row: CaseRow) {
    const metadata = this.meta(row);
    const fields = [
      { name: "Hedef", value: String(metadata.targetLabel ?? this.target(row)), inline: true },
      { name: "İşlem", value: LABELS[row.case_type], inline: true },
      { name: "DM", value: row.dm_requested ? "Açık" : "Kapalı", inline: true },
      { name: "Sebep", value: row.reason ?? "Sebep belirtilmedi.", inline: false }
    ];
    if (row.duration_seconds) {
      fields.push({ name: "Süre", value: this.formatDuration(row.duration_seconds), inline: true });
    }
    if (row.proof_url) {
      fields.push({ name: "Kanıt", value: row.proof_url, inline: false });
    }
    return createCommandEmbed({
      tone: this.tone(row.case_type),
      title: `${String(metadata.title ?? `${LABELS[row.case_type]} onayı`)} • Vaka #${row.id}`,
      description: String(metadata.description ?? "İşlem onay bekliyor."),
      fields,
      footer: "Supervisor Discord Bot • Güvenli Önizleme"
    });
  }

  private resultEmbed(row: CaseRow, result: ExecResult) {
    const fields = [
      { name: "Vaka", value: `#${row.id}`, inline: true },
      { name: "Durum", value: this.statusLabel(result.status), inline: true },
      { name: "Hedef", value: this.target(row), inline: true }
    ];
    if (row.reason) {
      fields.push({ name: "Sebep", value: row.reason, inline: false });
    }
    if (result.dm) {
      fields.push({ name: "DM Durumu", value: result.dm.note, inline: true });
    }
    return createCommandEmbed({
      tone: result.status === "failed" ? "critical" : this.tone(row.case_type),
      title: `${LABELS[row.case_type]} Sonucu`,
      description: result.summary,
      fields,
      footer: "Supervisor Discord Bot • Moderasyon Sonucu"
    });
  }

  private staticEmbed(row: CaseRow, summary: string, status: ModerationCaseStatus) {
    return createCommandEmbed({
      tone: status === "cancelled" ? "warning" : this.tone(row.case_type),
      title: `${LABELS[row.case_type]} Durumu`,
      description: summary,
      fields: [
        { name: "Vaka", value: `#${row.id}`, inline: true },
        { name: "Durum", value: this.statusLabel(status), inline: true }
      ],
      footer: "Supervisor Discord Bot • Vaka Durumu"
    });
  }

  private noPermission(interaction: ChatInputCommandInteraction<"cached">) {
    return interaction.reply({
      embeds: [
        createCommandEmbed({
          tone: "critical",
          title: "Yetki Engeli",
          description: "Bu komutu kullanma yetkin bulunmuyor."
        })
      ],
      ephemeral: true
    });
  }

  private normalizeReason(value: string | null) {
    let text = (value ?? "").trim();
    if (text) {
      text = escapeMarkdown(text);
    }
    return text || "Sebep belirtilmedi.";
  }

  private optionalValue(value: string | null) {
    const text = (value ?? "").trim();
    return text || null;
  }

  private snowflake(value: string | null) {
    const text = (value ?? "").trim();
    return /^\d{15,21}$/.test(text) ? text : null;
  }

  private dmPreference(value: boolean | null) {
    return typeof value === "boolean" ? value : this.getConfig().moderation.defaultDmEnabled;
  }

  private meta(row: CaseRow) {
    if (typeof row.metadata === "string") {
      try {
        return JSON.parse(row.metadata) as Record<string, unknown>;
      } catch {
        return {};
      }
    }
    return typeof row.metadata === "object" && row.metadata !== null ? (row.metadata as Record<string, unknown>) : {};
  }

  private tone(caseType: ModerationCaseType) {
    if (["ban", "kick", "softban", "purge"].includes(caseType)) return "critical" as const;
    if (["timeout", "warn", "jail", "lock", "slowmode"].includes(caseType)) return "warning" as const;
    return "neutral" as const;
  }

  private statusLabel(status: ModerationCaseStatus) {
    return (
      {
        pending: "Beklemede",
        active: "Aktif",
        completed: "Tamamlandı",
        removed: "Kaldırıldı",
        cancelled: "İptal Edildi",
        failed: "Başarısız",
        expired: "Süresi Doldu"
      }[status] ?? status
    );
  }

  private target(row: CaseRow) {
    return row.target_type === "member" ? `<@${row.target_id}>` : `<#${row.target_id}>`;
  }

  private formatDuration(seconds: number | null) {
    const safe = Math.max(0, Number(seconds ?? 0));
    const minutes = Math.ceil(safe / 60);
    const hours = Math.floor(minutes / 60);
    const remain = minutes % 60;
    if (hours > 0 && remain > 0) return `${hours} sa ${remain} dk`;
    if (hours > 0) return `${hours} saat`;
    return `${minutes} dakika`;
  }

  private formatDate(date: Date | null) {
    return date ? date.toLocaleString("tr-TR", { hour12: false }) : "-";
  }

  private checkTarget(
    interaction: ChatInputCommandInteraction<"cached">,
    actor: GuildMember,
    target: GuildMember,
    action: "ban" | "kick" | "timeout" | "jail"
  ) {
    if (target.id === actor.id) {
      interaction.reply({ content: "Kendine islem uygulayamazsin.", ephemeral: true }).catch(() => undefined);
      return false;
    }
    if (target.id === interaction.guild.ownerId) {
      interaction.reply({ content: "Sunucu sahibine islem uygulanamaz.", ephemeral: true }).catch(() => undefined);
      return false;
    }
    if (interaction.guild.ownerId !== actor.id && actor.roles.highest.position <= target.roles.highest.position) {
      interaction.reply({ content: "Rol hiyerarsisi nedeniyle bu hedefe islem yapamazsin.", ephemeral: true }).catch(() => undefined);
      return false;
    }
    if (!this.checkRuntimeTarget(actor, target, action)) {
      interaction.reply({ content: "Bot rol hiyerarsisi nedeniyle bu hedefe islem yapamiyor.", ephemeral: true }).catch(() => undefined);
      return false;
    }
    return true;
  }

  private checkRuntimeTarget(actor: GuildMember, target: GuildMember, action: "ban" | "kick" | "timeout" | "jail") {
    if (target.id === actor.guild.ownerId) return false;
    if (action === "ban") return target.bannable;
    if (action === "kick") return target.kickable;
    if (action === "timeout") return target.moderatable;
    return target.manageable;
  }

  private purgeChannel(interaction: ChatInputCommandInteraction<"cached">) {
    const channel = (interaction.options.getChannel("kanal") ?? interaction.channel) as GuildBasedChannel | null;
    if (!channel || !this.isMessageChannel(channel)) {
      interaction.reply({ content: "Purge icin mesaj yoneticisi olan bir kanal sec.", ephemeral: true }).catch(() => undefined);
      return null;
    }
    return channel;
  }

  private lockChannel(interaction: ChatInputCommandInteraction<"cached">) {
    const channel = (interaction.options.getChannel("kanal") ?? interaction.channel) as GuildBasedChannel | null;
    if (!channel || !("permissionOverwrites" in channel)) {
      interaction.reply({ content: "Lock islemi icin uygun bir kanal sec.", ephemeral: true }).catch(() => undefined);
      return null;
    }
    return channel;
  }

  private slowmodeChannel(interaction: ChatInputCommandInteraction<"cached">) {
    const channel = (interaction.options.getChannel("kanal") ?? interaction.channel) as GuildBasedChannel | null;
    if (!channel || !("setRateLimitPerUser" in channel)) {
      interaction.reply({ content: "Slowmode yalnizca yazi kanallarinda kullanilabilir.", ephemeral: true }).catch(() => undefined);
      return null;
    }
    return channel as GuildBasedChannel & { rateLimitPerUser: number; setRateLimitPerUser: (seconds: number, reason?: string) => Promise<unknown> };
  }

  private isMessageChannel(channel: GuildBasedChannel): channel is GuildBasedChannel & {
    messages: { fetch: (options?: { limit?: number; before?: string }) => Promise<any> };
    bulkDelete: (messages: Iterable<string | Message>, filterOld?: boolean) => Promise<any>;
  } {
    return "messages" in channel && typeof (channel as { messages?: { fetch?: unknown } }).messages?.fetch === "function" && "bulkDelete" in channel;
  }

  private matchesPurge(message: Message, filterUserId: string | null, onlyBots: boolean, onlyLinks: boolean, onlyFiles: boolean) {
    if (filterUserId && message.author.id !== filterUserId) return false;
    if (onlyBots && !message.author.bot) return false;
    if (onlyLinks && !/(https?:\/\/|discord\.gg\/)/i.test(message.content)) return false;
    if (onlyFiles && message.attachments.size <= 0) return false;
    return true;
  }

  private lockOverwrite(channelType: number) {
    if (channelType === 2 || channelType === 13) {
      return { Connect: false, Speak: false };
    }
    return {
      SendMessages: false,
      AddReactions: false,
      SendMessagesInThreads: false,
      CreatePublicThreads: false,
      CreatePrivateThreads: false
    };
  }

  private channelName(channel: GuildBasedChannel) {
    return "name" in channel && typeof channel.name === "string" ? channel.name : channel.id;
  }
}
