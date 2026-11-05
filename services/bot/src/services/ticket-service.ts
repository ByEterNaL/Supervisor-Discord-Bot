import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChannelType,
  ChatInputCommandInteraction,
  EmbedBuilder,
  type Guild,
  GuildMember,
  ModalBuilder,
  ModalSubmitInteraction,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
  type OverwriteData,
  type TextChannel
} from "discord.js";
import type { Logger } from "pino";
import type { Sql } from "postgres";

import { CONFIG_KEY, mergeConfig, type SupervisorConfig } from "../../../../packages/shared/src";
import type { MemberService } from "./member-service";

interface TicketRow {
  id: number;
  guild_id: string;
  channel_id: string | null;
  owner_id: string;
  claimed_by: string | null;
  claimed_at: Date | null;
  first_response_at: Date | null;
  last_called_at: Date | null;
  status: "open" | "archived" | "deleted";
}

const AUTO_ACTIVE_CATEGORY_NAME = "Supervisor Active Tickets";
const AUTO_ARCHIVE_CATEGORY_NAME = "Supervisor Archive Tickets";
const TICKET_STAFF_ROLE_NAME = "Ticket Yetkilisi";
const TICKET_STAFF_ROLE_COLOR = 0xf59e0b;

export function buildBaseTicketOverwrites(
  everyoneRoleId: string,
  ownerId: string,
  config: SupervisorConfig
): OverwriteData[] {
  const allowRoles = new Set([
    ...config.roles.ticketRoleIds,
    ...config.roles.staffRoleIds,
    ...config.roles.upperStaffRoleIds,
    ...config.roles.supervisorRoleIds
  ]);

  return [
    {
      id: everyoneRoleId,
      deny: [PermissionFlagsBits.ViewChannel]
    },
    {
      id: ownerId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks
      ]
    },
    ...[...allowRoles].map((roleId) => ({
      id: roleId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles
      ]
    }))
  ];
}

export function buildClaimedTicketOverwrites(
  everyoneRoleId: string,
  ownerId: string,
  claimerId: string,
  config: SupervisorConfig
): OverwriteData[] {
  const upperRoles = new Set([
    ...config.roles.upperStaffRoleIds,
    ...config.roles.supervisorRoleIds
  ]);
  const allStaffBase = [
    ...config.roles.staffRoleIds,
    ...config.roles.ticketRoleIds
  ];
  const hiddenRoles = [...new Set(allStaffBase)].filter((roleId) => !upperRoles.has(roleId));

  return [
    {
      id: everyoneRoleId,
      deny: [PermissionFlagsBits.ViewChannel]
    },
    {
      id: ownerId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks
      ]
    },
    {
      id: claimerId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.ManageChannels
      ]
    },
    ...[...upperRoles].map((roleId) => ({
      id: roleId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.ManageChannels
      ]
    })),
    ...hiddenRoles.map((roleId) => ({
      id: roleId,
      deny: [PermissionFlagsBits.ViewChannel]
    }))
  ];
}

export class TicketService {
  // In-Memory lock for preventing TOCTOU in ticket creation (spam click bypass)
  private readonly creationLocks = new Set<string>();

  constructor(
    private readonly sql: Sql,
    private readonly logger: Logger,
    private readonly memberService: MemberService,
    private readonly getConfig: () => SupervisorConfig
  ) {}

  async createPanel(interaction: ChatInputCommandInteraction<"cached">) {
    const member = interaction.member;
    if (!(member instanceof GuildMember) || !this.memberService.canManageConfig(member)) {
      await interaction.reply({
        content: "Bu komutu kullanmak icin ust yetkili olman gerekiyor.",
        ephemeral: true
      });
      return;
    }

    const channel = interaction.options.getChannel("kanal", true);
    if (channel.type !== ChannelType.GuildText) {
      await interaction.reply({
        content: "Yalnizca yazi kanali secilebilir.",
        ephemeral: true
      });
      return;
    }

    const config = this.getConfig();
    const embed = new EmbedBuilder()
      .setColor(0xf59e0b)
      .setTitle(config.ticket.embedTitle)
      .setDescription(config.ticket.embedDescription)
      .setFooter({ text: "Supervisor Discord Bot" });

    if (config.ticket.embedImageUrl) {
      embed.setImage(config.ticket.embedImageUrl);
    }

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("ticket-open")
        .setLabel("Ticket Olustur")
        .setStyle(ButtonStyle.Primary)
    );

    await (channel as TextChannel).send({
      embeds: [embed],
      components: [row]
    });

    await interaction.reply({
      content: `Ticket paneli <#${channel.id}> kanalina gonderildi.`,
      ephemeral: true
    });
  }

  async startOpenFlow(interaction: ButtonInteraction<"cached">) {
    const config = this.getConfig();
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("ticket-journey:yes")
        .setLabel(config.ticket.onboardingYesLabel)
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId("ticket-journey:no")
        .setLabel(config.ticket.onboardingNoLabel)
        .setStyle(ButtonStyle.Secondary)
    );

    await interaction.reply({
      content: config.ticket.onboardingQuestion,
      components: [row],
      ephemeral: true
    });
  }

  async handleJourneyChoice(interaction: ButtonInteraction<"cached">) {
    const choice = interaction.customId.split(":")[1];
    if (choice === "yes") {
      const modal = new ModalBuilder()
        .setCustomId("ticket-onboarding-modal")
        .setTitle("Katilim Bilgileri");

      const youtubeInput = new TextInputBuilder()
        .setCustomId("youtubeUsername")
        .setLabel("YouTube kullanici adi")
        .setRequired(true)
        .setStyle(TextInputStyle.Short);

      const githubInput = new TextInputBuilder()
        .setCustomId("githubUsername")
        .setLabel("GitHub kullanici adi")
        .setRequired(true)
        .setStyle(TextInputStyle.Short);

      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(youtubeInput),
        new ActionRowBuilder<TextInputBuilder>().addComponents(githubInput)
      );

      await interaction.showModal(modal);
      return;
    }

    await this.createTicketChannel(interaction, {
      joinRequest: false
    });
  }

  async handleOnboardingModal(interaction: ModalSubmitInteraction<"cached">) {
    await this.createTicketChannel(interaction, {
      joinRequest: true,
      youtubeUsername: interaction.fields.getTextInputValue("youtubeUsername"),
      githubUsername: interaction.fields.getTextInputValue("githubUsername")
    });
  }

  async claim(interaction: ChatInputCommandInteraction<"cached">) {
    const member = interaction.member;
    if (!(member instanceof GuildMember)) {
      await interaction.reply({
        content: "Üye bilgisi alınamadı.",
        ephemeral: true
      });
      return;
    }

    const config = this.getConfig();
    const hasTicketRole = (config.roles.ticketRoleIds?.length ?? 0) > 0 
      ? this.memberService.hasAnyRole(member, config.roles.ticketRoleIds)
      : this.memberService.isStaff(member);

    if (!hasTicketRole) {
      await interaction.reply({
        content: "Bu komutu kullanmak için Ticket Yetkilisi olmalısın.",
        ephemeral: true
      });
      return;
    }

    const ticket = await this.findByChannel(interaction.channelId);
    if (!ticket || ticket.status !== "open") {
      await interaction.reply({
        content: "Bu kanal aktif bir ticket kanali degil.",
        ephemeral: true
      });
      return;
    }

    if (ticket.claimed_by && ticket.claimed_by !== member.id) {
      await interaction.reply({
        content: `Bu ticket zaten <@${ticket.claimed_by}> tarafindan claim alinmis.`,
        ephemeral: true
      });
      return;
    }

    const channel = interaction.channel;
    if (!channel || !("permissionOverwrites" in channel)) {
      await interaction.reply({
        content: "Bu kanalda izinler guncellenemedi.",
        ephemeral: true
      });
      return;
    }

    await channel.permissionOverwrites.set(
      buildClaimedTicketOverwrites(
        interaction.guild.roles.everyone.id,
        ticket.owner_id,
        member.id,
        config
      )
    );

    await this.sql`
      INSERT INTO ticket_claims (ticket_id, claimer_id)
      VALUES (${ticket.id}, ${member.id})
    `;

    await this.sql`
      UPDATE ticket_sessions
      SET claimed_by = ${member.id}, claimed_at = NOW()
      WHERE id = ${ticket.id}
    `;

    await interaction.reply({
      content: "Ticket claim alindi. Kanal gorunurlugu guncellendi."
    });
  }

  async handleCloseButton(interaction: ButtonInteraction<"cached">) {
    await this.archiveTicket(interaction, "close");
  }

  async handleArchiveButton(interaction: ButtonInteraction<"cached">) {
    const member = interaction.member;
    if (!(member instanceof GuildMember) || !this.memberService.isStaff(member)) {
      await interaction.reply({
        content: "Arsivleme butonu yalnizca yetkililer icindir.",
        ephemeral: true
      });
      return;
    }

    await this.archiveTicket(interaction, "archive");
  }

  async handleCallButton(interaction: ButtonInteraction<"cached">) {
    const ticket = await this.findByChannel(interaction.channelId);
    if (!ticket) {
      await interaction.reply({
        content: "Ticket bulunamadi.",
        ephemeral: true
      });
      return;
    }

    const config = this.getConfig();
    const cooldownSeconds = config.ticket.callCooldownSeconds;
    
    // Acquire a row-level lock using a transaction to prevent TOCTOU spam
    const canCall = await this.sql.begin(async (transaction) => {
      const tx = transaction as unknown as Sql;
      const [lockedTicket] = await tx<{ last_called_at: Date | null }[]>`
        SELECT last_called_at
        FROM ticket_sessions
        WHERE id = ${ticket.id}
        FOR UPDATE
      `;
      
      if (!lockedTicket) return false;

      if (lockedTicket.last_called_at) {
        const elapsedSeconds = Math.floor(
          (Date.now() - new Date(lockedTicket.last_called_at).getTime()) / 1000
        );
        if (elapsedSeconds < cooldownSeconds) {
          return false;
        }
      }

      await tx`
        UPDATE ticket_sessions
        SET last_called_at = NOW()
        WHERE id = ${ticket.id}
      `;
      
      return true;
    });

    if (!canCall) {
      // Find remaining time if it was rejected due to cooldown
      const elapsedSeconds = ticket.last_called_at 
        ? Math.floor((Date.now() - new Date(ticket.last_called_at).getTime()) / 1000) 
        : 0;
      await interaction.reply({
        content: `Yetkili cagirma yeniden kullanilamaz. Lutfen bekleyin.`,
        ephemeral: true
      });
      return;
    }

    await interaction.deferReply();

    const ticketRoleIds = await this.resolveTicketStaffRoleIds(interaction.guild, config);

    const ownerMention = `<@${ticket.owner_id}>`;
    const channelLink = `https://discord.com/channels/${interaction.guild.id}/${interaction.channelId}`;
    const categoryLabel =
      interaction.channel && "parent" in interaction.channel && interaction.channel.parent
        ? interaction.channel.parent.name
        : "Ticket";
    const callerMention = `<@${interaction.user.id}>`;

    const embed = new EmbedBuilder()
      .setColor(0xf59e0b)
      .setTitle("Ticket destegi bekleniyor")
      .setDescription(
        `${callerMention} **${interaction.guild.name}** sunucusundaki bir ticket kanalinda yardim cagirdi.\n\nTicket sahibi destek bekliyor, musait isen mudahale et.`
      )
      .addFields(
        { name: "Ticket Sahibi", value: ownerMention, inline: true },
        { name: "Ticket No", value: `#${ticket.id}`, inline: true },
        { name: "Kategori", value: categoryLabel, inline: true },
        { name: "Kanal", value: `<#${interaction.channelId}>`, inline: false }
      )
      .setFooter({ text: `Supervisor Discord Bot · ${interaction.guild.name}` })
      .setTimestamp(new Date());

    const jumpRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setLabel("Ticket Kanalina Git")
        .setURL(channelLink)
    );

    // Collect every member holding one of the ticket staff roles.
    const recipients = new Map<string, GuildMember>();
    for (const roleId of ticketRoleIds) {
      const role =
        interaction.guild.roles.cache.get(roleId) ??
        (await interaction.guild.roles.fetch(roleId).catch(() => null));
      if (!role) continue;
      // Ensure member cache is fresh for this role's members.
      if (role.members.size === 0) {
        try {
          await interaction.guild.members.fetch();
        } catch (error) {
          this.logger.warn({ error, roleId }, "Failed to fetch members for ticket role.");
        }
      }
      role.members.forEach((member) => {
        if (member.user.bot) return;
        recipients.set(member.id, member);
      });
    }

    let dmSent = 0;
    let dmFailed = 0;
    await Promise.all(
      [...recipients.values()].map(async (member) => {
        try {
          await member.send({
            embeds: [embed],
            components: [jumpRow]
          });
          dmSent += 1;
        } catch (error) {
          dmFailed += 1;
          this.logger.debug(
            { error, memberId: member.id, ticketId: ticket.id },
            "Unable to deliver ticket call DM (member likely has DMs closed)."
          );
        }
      })
    );

    // `last_called_at` was already updated atomically in the transaction block above.

    // Also fire a light-weight in-channel mention so DM-off staff still see it.
    const mentionParts = ticketRoleIds.map((roleId) => `<@&${roleId}>`);
    const dmSummary =
      dmSent === 0 && dmFailed === 0
        ? "Yetkili bulunamadi. Lutfen sunucu sahibine haber verin."
        : `${dmSent} yetkiliye DM gonderildi${dmFailed > 0 ? `, ${dmFailed} DM teslim edilemedi` : ""}.`;

    await interaction.editReply({
      content: mentionParts.length
        ? `${mentionParts.join(" ")} ${dmSummary}`
        : dmSummary,
      allowedMentions: {
        roles: ticketRoleIds
      }
    });
  }

  private async resolveTicketStaffRoleIds(
    guild: Guild,
    config: SupervisorConfig
  ): Promise<string[]> {
    const configured = (config.roles.ticketRoleIds ?? []).filter(Boolean);
    if (configured.length > 0) {
      // Drop any IDs that no longer resolve to a real role on the guild.
      const alive: string[] = [];
      for (const roleId of configured) {
        const role =
          guild.roles.cache.get(roleId) ??
          (await guild.roles.fetch(roleId).catch(() => null));
        if (role) alive.push(role.id);
      }
      if (alive.length > 0) return alive;
    }

    // Nothing configured — look for an existing "Ticket Yetkilisi" role.
    await guild.roles.fetch().catch(() => null);
    const existing = guild.roles.cache.find(
      (role) => role.name === TICKET_STAFF_ROLE_NAME && !role.managed
    );
    if (existing) {
      await this.persistTicketStaffRoleIds(config, [existing.id]);
      return [existing.id];
    }

    // Create the role on demand so /yetkili-cagir always has an audience.
    try {
      const created = await guild.roles.create({
        name: TICKET_STAFF_ROLE_NAME,
        color: TICKET_STAFF_ROLE_COLOR,
        mentionable: true,
        reason: "Ticket sistemi icin otomatik olusturulan yetkili rolu."
      });
      await this.persistTicketStaffRoleIds(config, [created.id]);
      this.logger.info(
        { guildId: guild.id, roleId: created.id },
        "Ticket staff role auto-created."
      );
      return [created.id];
    } catch (error) {
      this.logger.error({ error, guildId: guild.id }, "Failed to auto-create ticket staff role.");
      // Fall back to legacy mention list so the flow still alerts somebody.
      return [...new Set([
        ...config.roles.staffRoleIds,
        ...config.roles.upperStaffRoleIds,
        ...config.roles.supervisorRoleIds
      ])];
    }
  }

  private async persistTicketStaffRoleIds(
    config: SupervisorConfig,
    roleIds: string[]
  ): Promise<void> {
    const [row] = await this.sql<{ value: unknown }[]>`
      SELECT value FROM config_entries WHERE key = ${CONFIG_KEY} LIMIT 1
    `;
    
    const latestConfig = mergeConfig(row?.value ?? {});
    const finalConfig = mergeConfig({
      ...latestConfig,
      roles: {
        ...latestConfig.roles,
        ticketRoleIds: roleIds
      }
    });

    await this.sql`
      INSERT INTO config_entries (key, value, updated_at)
      VALUES (${CONFIG_KEY}, ${JSON.stringify(finalConfig)}::jsonb, NOW())
      ON CONFLICT (key)
      DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `;

    config.roles.ticketRoleIds = roleIds;
  }

  async logTicketMessage(message: {
    guildId: string;
    channelId: string;
    messageId: string;
    authorId: string | null;
    authorType: "staff" | "user" | "system";
    contentLength: number;
  }) {
    const ticket = await this.findByChannel(message.channelId);
    if (!ticket) {
      return;
    }

    await this.sql`
      INSERT INTO ticket_messages (
        ticket_id,
        guild_id,
        channel_id,
        message_id,
        author_id,
        author_type,
        content_length,
        created_at
      )
      VALUES (
        ${ticket.id},
        ${message.guildId},
        ${message.channelId},
        ${message.messageId},
        ${message.authorId},
        ${message.authorType},
        ${message.contentLength},
        NOW()
      )
    `;

    if (message.authorType === "staff" && !ticket.first_response_at) {
      await this.sql`
        UPDATE ticket_sessions
        SET first_response_at = NOW()
        WHERE id = ${ticket.id}
          AND first_response_at IS NULL
      `;
    }
  }

  async markDeleted(channelId: string) {
    await this.sql`
      UPDATE ticket_sessions
      SET status = 'deleted', deleted_at = NOW()
      WHERE channel_id = ${channelId}
        AND status <> 'deleted'
    `;
  }

  private async createTicketChannel(
    interaction: ButtonInteraction<"cached"> | ModalSubmitInteraction<"cached">,
    payload: {
      joinRequest: boolean;
      youtubeUsername?: string;
      githubUsername?: string;
    }
  ) {
    await interaction.deferReply({ ephemeral: true });

    const guild = interaction.guild;
    const member = interaction.member;

    if (!guild || !(member instanceof GuildMember)) {
      await interaction.editReply({
        content: "Ticket yalnizca sunucu icinde olusturulabilir."
      });
      return;
    }

    const lockKey = `${guild.id}:${member.id}`;
    if (this.creationLocks.has(lockKey)) {
      await interaction.editReply({
        content: "İşleminiz devam ediyor, lütfen bekleyin..."
      });
      return;
    }
    
    this.creationLocks.add(lockKey);
    try {
      await this.memberService.syncMember(member);

    const [existing] = await this.sql<{ id: number }[]>`
      SELECT id
      FROM ticket_sessions
      WHERE guild_id = ${guild.id}
        AND owner_id = ${member.id}
        AND status = 'open'
      LIMIT 1
    `;

    if (existing) {
      await interaction.editReply({
        content: "Zaten acik bir ticketin bulunuyor."
      });
      return;
    }

    const config = this.getConfig();
    const safeName =
      member.user.username.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12) || member.id;
    let activeCategoryId: string | null = null;
    try {
      activeCategoryId = await this.resolveTicketCategoryId(guild, "active", config);
    } catch (error) {
      await interaction.editReply({
        content:
          error instanceof Error
            ? error.message
            : "Aktif ticket kategorisi ayari dogrulanamadi."
      });
      return;
    }
    const channel = await guild.channels.create({
      name: `ticket-${safeName}`,
      type: ChannelType.GuildText,
      parent: activeCategoryId ?? undefined,
      permissionOverwrites: buildBaseTicketOverwrites(guild.roles.everyone.id, member.id, config)
    });

    const [ticket] = await this.sql<{ id: number }[]>`
      INSERT INTO ticket_sessions (
        guild_id,
        channel_id,
        owner_id,
        category_key,
        join_request,
        youtube_username,
        github_username,
        status
      )
      VALUES (
        ${guild.id},
        ${channel.id},
        ${member.id},
        ${payload.joinRequest ? "join" : "general"},
        ${payload.joinRequest},
        ${payload.youtubeUsername ?? null},
        ${payload.githubUsername ?? null},
        'open'
      )
      RETURNING id
    `;

    const embedTitle = payload.joinRequest ? config.ticket.joinWelcomeTitle : config.ticket.welcomeTitle;
    const embedDesc = payload.joinRequest ? config.ticket.joinWelcomeDescription : config.ticket.welcomeDescription;

    const welcomeEmbed = new EmbedBuilder()
      .setColor(0x22c55e)
      .setTitle(embedTitle.replace("{user}", member.toString()))
      .setDescription(embedDesc)
      .setFooter({ text: `Ticket #${ticket.id}` });

    if (payload.joinRequest) {
      welcomeEmbed.addFields(
        { name: "🐙 GitHub", value: payload.githubUsername || "*Belirtilmedi*", inline: true },
        { name: "▶️ YouTube", value: payload.youtubeUsername || "*Belirtilmedi*", inline: true }
      );
    }

    if (config.ticket.embedImageUrl) {
      welcomeEmbed.setImage(config.ticket.embedImageUrl);
    }

    const controls = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`ticket-close:${ticket.id}`)
        .setLabel("Kapat")
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`ticket-archive:${ticket.id}`)
        .setLabel("Arsivle")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`ticket-call:${ticket.id}`)
        .setLabel("Yetkili Cagir")
        .setStyle(ButtonStyle.Primary)
    );

    await (channel as TextChannel).send({
      content: `${member}`,
      embeds: [welcomeEmbed],
      components: [controls]
    });

    this.logger.info({ ticketId: ticket.id, ownerId: member.id }, "Ticket created.");

    await interaction.editReply({
      content: `Ticketin olusturuldu: <#${channel.id}>`
    });
    } finally {
      this.creationLocks.delete(lockKey);
    }
  }

  private async archiveTicket(
    interaction: ButtonInteraction<"cached">,
    source: "close" | "archive"
  ) {
    const ticket = await this.findByChannel(interaction.channelId);
    if (!ticket) {
      await interaction.reply({
        content: "Ticket kaydi bulunamadi.",
        ephemeral: true
      });
      return;
    }

    const member = interaction.member;
    const isStaff = member instanceof GuildMember && this.memberService.isStaff(member);
    const isOwner = ticket.owner_id === interaction.user.id;

    if (!isStaff && !isOwner) {
      await interaction.reply({
        content: "Bu ticket uzerinde islem yapamazsin.",
        ephemeral: true
      });
      return;
    }

    await interaction.deferReply({ ephemeral: false });

    const channel = interaction.channel;
    const config = this.getConfig();
    let archiveCategoryId: string | null = null;
    try {
      archiveCategoryId = await this.resolveTicketCategoryId(
        interaction.guild,
        "archive",
        config
      );
    } catch (error) {
      await interaction.editReply({
        content:
          error instanceof Error ? error.message : "Arsiv kategorisi ayari dogrulanamadi."
      });
      return;
    }

    // Build overwrites that (a) deny @everyone view, (b) explicitly deny the
    // owner and prevent them from seeing the archived channel, (c) grant
    // staff/ticket roles view + read history. The owner's original ALLOW is
    // wiped on set(), but we add an explicit DENY as belt-and-suspenders in
    // case the owner carries any role that might otherwise grant view.
    const allowRoleIds = new Set<string>([
      ...config.roles.staffRoleIds,
      ...config.roles.upperStaffRoleIds,
      ...config.roles.supervisorRoleIds,
      ...(config.roles.ticketRoleIds || [])
    ]);

    // If the owner themselves holds a staff/ticket role we still want them
    // to be able to view the archive (same behaviour as other staff). Only
    // apply the explicit owner deny when the owner is NOT any kind of staff.
    const ownerIsStaff = member instanceof GuildMember && this.memberService.isStaff(member)
      ? interaction.user.id === ticket.owner_id
      : false;

    const overwrites: OverwriteData[] = [
      {
        id: interaction.guild.roles.everyone.id,
        deny: [PermissionFlagsBits.ViewChannel]
      },
      ...[...allowRoleIds].map((roleId) => ({
        id: roleId,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.ReadMessageHistory
        ]
      }))
    ];

    if (!ownerIsStaff) {
      overwrites.push({
        id: ticket.owner_id,
        deny: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory
        ]
      });
    }

    // 1. Apply the restricted permission overwrites FIRST so that even if
    //    a later step fails the owner can no longer see the channel.
    if (channel && "permissionOverwrites" in channel) {
      try {
        await channel.permissionOverwrites.set(overwrites);
      } catch (error) {
        this.logger.error({ error, ticketId: ticket.id }, "Failed to update permissions on archive.");
        await interaction.editReply({
          content: "Arsivlerken kanal izinleri guncellenemedi. Lutfen tekrar deneyin."
        });
        return;
      }
    }

    // 2. Move into the archive category (without inheriting its permission
    //    overwrites — we explicitly keep our own overwrites).
    if (channel && "setParent" in channel && archiveCategoryId && channel.parentId !== archiveCategoryId) {
      try {
        await channel.setParent(archiveCategoryId, { lockPermissions: false });
      } catch (error) {
        this.logger.error({ error, ticketId: ticket.id }, "Failed to set parent category on archive.");
        // Not fatal — permissions have already locked the owner out.
      }
    }

    // 3. Persist state last so DB reflects the verified archived channel.
    await this.sql`
      UPDATE ticket_sessions
      SET status = 'archived',
          archived_at = NOW(),
          archive_requested_by = ${interaction.user.id}
      WHERE id = ${ticket.id}
    `;

    await interaction.editReply({
      content:
        source === "close"
          ? "Ticket arsiv akisina alindi. Sahibi artik kanali goremez."
          : "Ticket arsiv kategorisine tasindi. Sahibi artik kanali goremez."
    });
  }

  private async findByChannel(channelId: string) {
    const [row] = await this.sql<TicketRow[]>`
      SELECT id, guild_id, channel_id, owner_id, claimed_by, claimed_at, first_response_at, last_called_at, status
      FROM ticket_sessions
      WHERE channel_id = ${channelId}
      LIMIT 1
    `;

    return row;
  }

  private async resolveTicketCategoryId(
    guild: ButtonInteraction<"cached">["guild"],
    categoryType: "active" | "archive",
    config: SupervisorConfig
  ) {
    const mode =
      categoryType === "active"
        ? config.ticket.activeCategoryMode
        : config.ticket.archiveCategoryMode;
    const configuredCategoryId =
      categoryType === "active"
        ? config.ticket.categoryParentId
        : config.ticket.archiveCategoryId;

    if (mode === "manual") {
      if (!configuredCategoryId) {
        return null;
      }

      const existingManualCategory =
        guild.channels.cache.get(configuredCategoryId) ??
        (await guild.channels.fetch(configuredCategoryId).catch(() => null));

      if (!existingManualCategory || existingManualCategory.type !== ChannelType.GuildCategory) {
        throw new Error(
          categoryType === "active"
            ? "Aktif ticket kategorisi icin girilen ID gecersiz."
            : "Arsiv kategorisi icin girilen ID gecersiz."
        );
      }

      return existingManualCategory.id;
    }

    if (configuredCategoryId) {
      const configuredAutoCategory =
        guild.channels.cache.get(configuredCategoryId) ??
        (await guild.channels.fetch(configuredCategoryId).catch(() => null));
      if (configuredAutoCategory?.type === ChannelType.GuildCategory) {
        return configuredAutoCategory.id;
      }
    }

    const desiredName =
      categoryType === "active" ? AUTO_ACTIVE_CATEGORY_NAME : AUTO_ARCHIVE_CATEGORY_NAME;
    const channels = await guild.channels.fetch();
    const existingAutoCategory = channels.find(
      (channel) => channel?.type === ChannelType.GuildCategory && channel.name === desiredName
    );

    if (existingAutoCategory) {
      await this.persistCategory(config, categoryType, existingAutoCategory.id);
      return existingAutoCategory.id;
    }

    // Archive categories must start with @everyone denied so freshly moved
    // channels that happen to sync from the category never leak to users.
    const permissionOverwrites =
      categoryType === "archive"
        ? [
            {
              id: guild.roles.everyone.id,
              deny: [PermissionFlagsBits.ViewChannel]
            }
          ]
        : undefined;

    const createdCategory = await guild.channels.create({
      name: desiredName,
      type: ChannelType.GuildCategory,
      permissionOverwrites
    });

    await this.persistCategory(config, categoryType, createdCategory.id);

    this.logger.info(
      { guildId: guild.id, categoryId: createdCategory.id, categoryType },
      "Automatic ticket category created."
    );

    return createdCategory.id;
  }

  private async persistCategory(
    config: SupervisorConfig,
    categoryType: "active" | "archive",
    categoryId: string
  ) {
    const currentCategoryId =
      categoryType === "active"
        ? config.ticket.categoryParentId
        : config.ticket.archiveCategoryId;

    if (currentCategoryId === categoryId) {
      return;
    }

    const [row] = await this.sql<{ value: unknown }[]>`
      SELECT value FROM config_entries WHERE key = ${CONFIG_KEY} LIMIT 1
    `;
    
    const latestConfig = mergeConfig(row?.value ?? {});
    const finalConfig = mergeConfig({
      ...latestConfig,
      ticket: {
        ...latestConfig.ticket,
        ...(categoryType === "active"
          ? { categoryParentId: categoryId }
          : { archiveCategoryId: categoryId })
      }
    });

    await this.sql`
      INSERT INTO config_entries (key, value, updated_at)
      VALUES (${CONFIG_KEY}, ${JSON.stringify(finalConfig)}::jsonb, NOW())
      ON CONFLICT (key)
      DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `;

    if (categoryType === "active") {
      config.ticket.categoryParentId = categoryId;
      return;
    }

    config.ticket.archiveCategoryId = categoryId;
  }
}
