import {
  ChatInputCommandInteraction,
  ChannelType,
  EmbedBuilder,
  Guild,
  GuildBasedChannel,
  GuildMember,
  PermissionFlagsBits,
  PermissionsBitField,
  type PermissionOverwriteOptions,
  type Role
} from "discord.js";
import type IORedis from "ioredis";
import type { Logger } from "pino";
import type { Sql } from "postgres";

import {
  CONFIG_CHANGED_CHANNEL,
  CONFIG_KEY,
  mergeConfig,
  type SupervisorConfig
} from "../../../../packages/shared/src";
import type { ConfigStore } from "./config-store";
import type { MemberService } from "./member-service";

type SetupRoleKey =
  | "banRoleIds"
  | "kickRoleIds"
  | "unbanRoleIds"
  | "timeoutRoleIds"
  | "warnRoleIds"
  | "jailRoleIds"
  | "messageModerationRoleIds"
  | "channelModerationRoleIds"
  | "historyRoleIds";

type RoleResultState = "created" | "updated" | "reused";
type RestrictionKind = "jailed" | "muted";

interface SetupRoleResult {
  role: Role;
  state: RoleResultState;
  label: string;
}

interface SetupSummary {
  authorityRoles: SetupRoleResult[];
  jailedRole: SetupRoleResult;
  mutedRole: SetupRoleResult;
  channelsTouched: number;
  overwriteWrites: number;
  overwriteFailures: number;
}

interface TeardownSummary {
  deletedRoles: Array<{ id: string; name: string }>;
  skippedRoles: Array<{ id: string; name: string }>;
}

export class ModersonService {
  constructor(
    private readonly sql: Sql,
    private readonly redis: IORedis | null,
    private readonly logger: Logger,
    private readonly configStore: ConfigStore,
    private readonly memberService: MemberService
  ) {}

  async handleCommand(interaction: ChatInputCommandInteraction<"cached">) {
    const actor = interaction.member;
    if (!(actor instanceof GuildMember) || !this.memberService.canManageConfig(actor)) {
      await interaction.reply({
        content: "Bu komutu kullanma yetkin yok.",
        ephemeral: true
      });
      return;
    }

    const subcommand = interaction.options.getSubcommand();
    const botMember = interaction.guild.members.me;
    const missingPermissions: string[] = [];
    if (!botMember?.permissions.has(PermissionFlagsBits.ManageRoles)) {
      missingPermissions.push("Rolleri Yönet");
    }
    if (
      subcommand === "kurulum"
      && !botMember?.permissions.has(PermissionFlagsBits.ManageChannels)
    ) {
      missingPermissions.push("Kanalları Yönet");
    }

    if (missingPermissions.length > 0) {
      await interaction.reply({
        content: `Kurulum için botta şu yetkiler eksik: ${missingPermissions.join(", ")}.`,
        ephemeral: true
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });
    if (subcommand === "kurulum") {
      const summary = await this.runSetup(interaction.guild);
      await interaction.editReply({
        embeds: [this.buildSummaryEmbed(interaction.guild, summary)]
      });
      return;
    }

    if (subcommand === "kaldir") {
      const summary = await this.runTeardown(interaction.guild);
      await interaction.editReply({
        embeds: [this.buildTeardownEmbed(interaction.guild, summary)]
      });
      return;
    }

    await interaction.editReply({
      content: "Bilinmeyen moderson alt komutu."
    });
  }

  private async runSetup(guild: Guild): Promise<SetupSummary> {
    await guild.roles.fetch();
    await guild.channels.fetch();

    const currentConfig = this.configStore.get();
    const authorityRoles: SetupRoleResult[] = [];

    const banRole = await this.ensureRole(
      guild,
      currentConfig.roles.banRoleIds,
      "Ban Yetkilisi",
      [PermissionFlagsBits.BanMembers, PermissionFlagsBits.ViewAuditLog],
      0xff6b81
    );
    authorityRoles.push({ ...banRole, label: "Ban Yetkilisi" });

    const kickRole = await this.ensureRole(
      guild,
      currentConfig.roles.kickRoleIds,
      "Kick Yetkilisi",
      [PermissionFlagsBits.KickMembers, PermissionFlagsBits.ViewAuditLog],
      0xffa347
    );
    authorityRoles.push({ ...kickRole, label: "Kick Yetkilisi" });

    const timeoutRole = await this.ensureRole(
      guild,
      currentConfig.roles.timeoutRoleIds,
      "Mute Yetkilisi",
      [
        PermissionFlagsBits.ModerateMembers,
        PermissionFlagsBits.MuteMembers,
        PermissionFlagsBits.DeafenMembers,
        PermissionFlagsBits.ViewAuditLog
      ],
      0x5dd6ff
    );
    authorityRoles.push({ ...timeoutRole, label: "Mute Yetkilisi" });

    const warnRole = await this.ensureRole(
      guild,
      currentConfig.roles.warnRoleIds,
      "Warn Yetkilisi",
      [PermissionFlagsBits.ModerateMembers, PermissionFlagsBits.ViewAuditLog],
      0xffc457
    );
    authorityRoles.push({ ...warnRole, label: "Warn Yetkilisi" });

    const jailRole = await this.ensureRole(
      guild,
      currentConfig.roles.jailRoleIds,
      "Jail Yetkilisi",
      [PermissionFlagsBits.ManageRoles, PermissionFlagsBits.ViewAuditLog],
      0xf26d5b
    );
    authorityRoles.push({ ...jailRole, label: "Jail Yetkilisi" });

    const messageRole = await this.ensureRole(
      guild,
      currentConfig.roles.messageModerationRoleIds,
      "Mesaj Moderasyon Yetkilisi",
      [
        PermissionFlagsBits.ManageMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ViewAuditLog
      ],
      0xff9d3f
    );
    authorityRoles.push({ ...messageRole, label: "Mesaj Moderasyon Yetkilisi" });

    const channelRole = await this.ensureRole(
      guild,
      currentConfig.roles.channelModerationRoleIds,
      "Kanal Moderasyon Yetkilisi",
      [
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ManageThreads,
        PermissionFlagsBits.ViewAuditLog
      ],
      0x4dc4ff
    );
    authorityRoles.push({ ...channelRole, label: "Kanal Moderasyon Yetkilisi" });

    const historyRole = await this.ensureRole(
      guild,
      currentConfig.roles.historyRoleIds,
      "Moderasyon Gecmisi",
      [PermissionFlagsBits.ViewAuditLog],
      0x95a3b3
    );
    authorityRoles.push({ ...historyRole, label: "Moderasyon Gecmisi" });

    const ticketRole = await this.ensureRole(
      guild,
      currentConfig.roles.ticketRoleIds,
      "Ticket Yetkilisi",
      [],
      0x59d0c2
    );
    authorityRoles.push({ ...ticketRole, label: "Ticket Yetkilisi" });

    const jailedRole = await this.ensureRole(
      guild,
      currentConfig.moderation.jailRoleId ? [currentConfig.moderation.jailRoleId] : [],
      "Jailed",
      [],
      0x7a2530
    );

    const mutedRole = await this.ensureRole(
      guild,
      currentConfig.moderation.mutedRoleId ? [currentConfig.moderation.mutedRoleId] : [],
      "Muted",
      [],
      0x505d73
    );

    const overwriteStats = await this.applyRestrictionOverwrites(
      guild,
      jailedRole.role.id,
      mutedRole.role.id
    );

    const nextConfig = mergeConfig({
      ...currentConfig,
      roles: {
        ...currentConfig.roles,
        banRoleIds: this.resolveDefaultRoleIds(currentConfig.roles.banRoleIds, banRole.role.id, guild),
        kickRoleIds: this.resolveDefaultRoleIds(currentConfig.roles.kickRoleIds, kickRole.role.id, guild),
        unbanRoleIds: this.resolveDefaultRoleIds(currentConfig.roles.unbanRoleIds, banRole.role.id, guild),
        timeoutRoleIds: this.resolveDefaultRoleIds(
          currentConfig.roles.timeoutRoleIds,
          timeoutRole.role.id,
          guild
        ),
        warnRoleIds: this.resolveDefaultRoleIds(currentConfig.roles.warnRoleIds, warnRole.role.id, guild),
        jailRoleIds: this.resolveDefaultRoleIds(currentConfig.roles.jailRoleIds, jailRole.role.id, guild),
        messageModerationRoleIds: this.resolveDefaultRoleIds(
          currentConfig.roles.messageModerationRoleIds,
          messageRole.role.id,
          guild
        ),
        channelModerationRoleIds: this.resolveDefaultRoleIds(
          currentConfig.roles.channelModerationRoleIds,
          channelRole.role.id,
          guild
        ),
        historyRoleIds: this.resolveDefaultRoleIds(
          currentConfig.roles.historyRoleIds,
          historyRole.role.id,
          guild
        ),
        ticketRoleIds: this.resolveDefaultRoleIds(
          currentConfig.roles.ticketRoleIds,
          ticketRole.role.id,
          guild
        )
      },
      moderation: {
        ...currentConfig.moderation,
        jailRoleId: this.resolveDefaultSingleRoleId(
          currentConfig.moderation.jailRoleId,
          jailedRole.role.id,
          guild
        ),
        mutedRoleId: this.resolveDefaultSingleRoleId(
          currentConfig.moderation.mutedRoleId,
          mutedRole.role.id,
          guild
        )
      }
    });

    await this.persistConfig(nextConfig);
    await this.configStore.refresh();
    await this.memberService.syncRoleCatalog(guild);

    return {
      authorityRoles,
      jailedRole: { ...jailedRole, label: "Jailed" },
      mutedRole: { ...mutedRole, label: "Muted" },
      channelsTouched: overwriteStats.channelsTouched,
      overwriteWrites: overwriteStats.overwriteWrites,
      overwriteFailures: overwriteStats.overwriteFailures
    };
  }

  private async runTeardown(guild: Guild): Promise<TeardownSummary> {
    await guild.roles.fetch();

    const currentConfig = this.configStore.get();
    const configuredRoleIds = new Set<string>([
      ...currentConfig.roles.banRoleIds,
      ...currentConfig.roles.kickRoleIds,
      ...currentConfig.roles.unbanRoleIds,
      ...currentConfig.roles.timeoutRoleIds,
      ...currentConfig.roles.warnRoleIds,
      ...currentConfig.roles.jailRoleIds,
      ...currentConfig.roles.messageModerationRoleIds,
      ...currentConfig.roles.channelModerationRoleIds,
      ...currentConfig.roles.historyRoleIds,
      ...(currentConfig.moderation.jailRoleId ? [currentConfig.moderation.jailRoleId] : []),
      ...(currentConfig.moderation.mutedRoleId ? [currentConfig.moderation.mutedRoleId] : [])
    ]);
    const managedRoleNames = new Set([
      "Ban Yetkilisi",
      "Kick Yetkilisi",
      "Mute Yetkilisi",
      "Warn Yetkilisi",
      "Jail Yetkilisi",
      "Mesaj Moderasyon Yetkilisi",
      "Kanal Moderasyon Yetkilisi",
      "Moderasyon Gecmisi",
      "Moderasyon Geçmişi",
      "Jailed",
      "Muted"
    ]);

    const rolesToRemove = guild.roles.cache.filter((role) => {
      if (role.managed || role.id === guild.id) {
        return false;
      }

      return configuredRoleIds.has(role.id) || managedRoleNames.has(role.name);
    });

    const deletedRoles: Array<{ id: string; name: string }> = [];
    const skippedRoles: Array<{ id: string; name: string }> = [];

    for (const role of rolesToRemove.values()) {
      if (!role.editable) {
        skippedRoles.push({ id: role.id, name: role.name });
        continue;
      }

      await role.delete("Moderson kurulum kaldırma otomasyonu").catch(() => null);
      if (guild.roles.cache.has(role.id)) {
        skippedRoles.push({ id: role.id, name: role.name });
      } else {
        deletedRoles.push({ id: role.id, name: role.name });
      }
    }

    const nextConfig = mergeConfig({
      ...currentConfig,
      roles: {
        ...currentConfig.roles,
        banRoleIds: [],
        kickRoleIds: [],
        unbanRoleIds: [],
        timeoutRoleIds: [],
        warnRoleIds: [],
        jailRoleIds: [],
        messageModerationRoleIds: [],
        channelModerationRoleIds: [],
        historyRoleIds: []
      },
      moderation: {
        ...currentConfig.moderation,
        jailRoleId: null,
        mutedRoleId: null
      }
    });

    await this.persistConfig(nextConfig);
    await this.configStore.refresh();
    await this.memberService.syncRoleCatalog(guild);

    return { deletedRoles, skippedRoles };
  }

  private async ensureRole(
    guild: Guild,
    configuredIds: string[],
    name: string,
    permissions: bigint[],
    color: number
  ): Promise<Omit<SetupRoleResult, "label">> {
    const desiredPermissions = new PermissionsBitField(permissions);
    const configuredRole = configuredIds
      .map((roleId) => guild.roles.cache.get(roleId))
      .find((role): role is Role => Boolean(role));

    let role =
      configuredRole ??
      guild.roles.cache.find(
        (item) => !item.managed && item.name.toLowerCase() === name.toLowerCase()
      ) ??
      null;

    if (!role) {
      const created = await guild.roles.create({
        name,
        color,
        hoist: false,
        mentionable: false,
        permissions: desiredPermissions,
        reason: "Moderson kurulum otomasyonu"
      });
      return { role: created, state: "created" };
    }

    if (
      role.editable &&
      (role.name !== name ||
        role.color !== color ||
        role.hoist ||
        role.mentionable ||
        role.permissions.bitfield !== desiredPermissions.bitfield)
    ) {
      role = await role.edit({
        name,
        color,
        hoist: false,
        mentionable: false,
        permissions: desiredPermissions,
        reason: "Moderson kurulum otomasyonu"
      });
      return { role, state: "updated" };
    }

    return { role, state: "reused" };
  }

  private async applyRestrictionOverwrites(guild: Guild, jailedRoleId: string, mutedRoleId: string) {
    const channels = await guild.channels.fetch();
    let channelsTouched = 0;
    let overwriteWrites = 0;
    let overwriteFailures = 0;

    for (const channel of channels.values()) {
      if (!channel || channel.isThread() || !this.isOverwritableChannel(channel)) {
        continue;
      }

      channelsTouched += 1;

      for (const [roleId, kind] of [
        [jailedRoleId, "jailed"],
        [mutedRoleId, "muted"]
      ] as const) {
        try {
          await channel.permissionOverwrites.edit(
            roleId,
            this.buildRestrictionOverwrite(kind, channel),
            { reason: "Moderson kurulum otomasyonu" }
          );
          overwriteWrites += 1;
        } catch (error) {
          overwriteFailures += 1;
          this.logger.warn(
            { error, channelId: channel.id, roleId, kind },
            "Moderson overwrite update failed."
          );
        }
      }
    }

    return { channelsTouched, overwriteWrites, overwriteFailures };
  }

  private buildRestrictionOverwrite(kind: RestrictionKind, channel: GuildBasedChannel): PermissionOverwriteOptions {
    if (channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice) {
      return kind === "jailed"
        ? {
            ViewChannel: false,
            Connect: false,
            Speak: false,
            RequestToSpeak: false
          }
        : {
            Speak: false,
            RequestToSpeak: false
          };
    }

    return kind === "jailed"
      ? {
          ViewChannel: false,
          SendMessages: false,
          AddReactions: false,
          SendMessagesInThreads: false,
          CreatePublicThreads: false,
          CreatePrivateThreads: false,
          AttachFiles: false,
          EmbedLinks: false,
          UseApplicationCommands: false,
          SendVoiceMessages: false
        }
      : {
          SendMessages: false,
          AddReactions: false,
          SendMessagesInThreads: false,
          CreatePublicThreads: false,
          CreatePrivateThreads: false,
          SendVoiceMessages: false
        };
  }

  private isOverwritableChannel(channel: GuildBasedChannel): channel is GuildBasedChannel & {
    permissionOverwrites: {
      edit: (target: string, overwrite: PermissionOverwriteOptions, options?: { reason?: string }) => Promise<unknown>;
    };
  } {
    return "permissionOverwrites" in channel;
  }

  private resolveDefaultRoleIds(currentIds: string[], fallbackId: string, guild: Guild) {
    const liveIds = currentIds.filter((roleId) => guild.roles.cache.has(roleId));
    return liveIds.length > 0 ? liveIds : [fallbackId];
  }

  private resolveDefaultSingleRoleId(currentId: string | null, fallbackId: string, guild: Guild) {
    return currentId && guild.roles.cache.has(currentId) ? currentId : fallbackId;
  }

  private async persistConfig(nextConfig: SupervisorConfig) {
    const [row] = await this.sql<{ value: unknown }[]>`
      SELECT value FROM config_entries WHERE key = ${CONFIG_KEY} LIMIT 1
    `;
    
    // Merge the latest DB config with our new changes
    const latestConfig = mergeConfig(row?.value ?? {});
    const finalConfig = mergeConfig({
      ...latestConfig,
      roles: { ...latestConfig.roles, ...nextConfig.roles },
      moderation: { ...latestConfig.moderation, ...nextConfig.moderation }
    });

    await this.sql`
      INSERT INTO config_entries (key, value, updated_at)
      VALUES (${CONFIG_KEY}, ${JSON.stringify(finalConfig)}::jsonb, NOW())
      ON CONFLICT (key)
      DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `;

    if (this.redis) {
      await this.redis.publish(CONFIG_CHANGED_CHANNEL, "reload").catch(() => undefined);
    }
  }

  private buildSummaryEmbed(guild: Guild, summary: SetupSummary) {
    const roleLines = summary.authorityRoles
      .map((item) => `• ${item.label}: ${this.roleStateLabel(item.state)} (<@&${item.role.id}>)`)
      .join("\n");

    const punishmentLines = [
      `• Jailed: ${this.roleStateLabel(summary.jailedRole.state)} (<@&${summary.jailedRole.role.id}>)`,
      `• Muted: ${this.roleStateLabel(summary.mutedRole.state)} (<@&${summary.mutedRole.role.id}>)`
    ].join("\n");

    return new EmbedBuilder()
      .setColor(0xffa347)
      .setTitle("Moderson kurulumu tamamlandı")
      .setDescription(
        `${guild.name} için moderasyon rolleri hazırlandı, boş config alanları varsayılan rollerle dolduruldu ve ceza rolleri kanal izinlerine işlendi.`
      )
      .addFields(
        {
          name: "Yetki Rolleri",
          value: roleLines || "Kurulan yetki rolü yok.",
          inline: false
        },
        {
          name: "Ceza Rolleri",
          value: punishmentLines,
          inline: false
        },
        {
          name: "Kanal Kısıtları",
          value: [
            `Kanallar: ${summary.channelsTouched}`,
            `Yazılan overwrite: ${summary.overwriteWrites}`,
            `Başarısız overwrite: ${summary.overwriteFailures}`
          ].join("\n"),
          inline: false
        },
        {
          name: "Not",
          value:
            "Timeout komutları Discord timeout kullanmaya devam eder. Muted rolü ise oda izinleri ve hızlı susturma altyapısı için hazır tutulur.",
          inline: false
        }
      )
      .setTimestamp(new Date());
  }

  private buildTeardownEmbed(guild: Guild, summary: TeardownSummary) {
    const deletedValue =
      summary.deletedRoles.length > 0
        ? summary.deletedRoles.map((role) => `- ${role.name} (${role.id})`).join("\n")
        : "Silinen yönetilen rol yok.";
    const skippedValue =
      summary.skippedRoles.length > 0
        ? summary.skippedRoles.map((role) => `- ${role.name} (${role.id})`).join("\n")
        : "Atlanan rol yok.";

    return new EmbedBuilder()
      .setColor(0xe76f51)
      .setTitle("Moderson kurulumu kaldirildi")
      .setDescription(
        `${guild.name} icin moderson tarafindan yonetilen roller kaldirildi ve varsayilan moderasyon baglantilari config uzerinden temizlendi.`
      )
      .addFields(
        {
          name: "Silinen Roller",
          value: deletedValue,
          inline: false
        },
        {
          name: "Atlanan Roller",
          value: skippedValue,
          inline: false
        }
      )
      .setTimestamp(new Date());
  }

  private roleStateLabel(state: RoleResultState) {
    if (state === "created") return "oluşturuldu";
    if (state === "updated") return "güncellendi";
    return "kullanıldı";
  }
}
