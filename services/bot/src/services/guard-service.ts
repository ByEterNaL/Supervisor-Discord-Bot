import {
  AuditLogEvent,
  ChannelType,
  EmbedBuilder,
  PermissionsBitField,
  type ColorResolvable,
  type Guild,
  type GuildAuditLogsEntry,
  type GuildBasedChannel,
  type GuildMember,
  type Message,
  type NonThreadGuildBasedChannel,
  type PartialMessage,
  type Role,
  type Webhook
} from "discord.js";
import type { Logger } from "pino";
import type { Sql } from "postgres";

import type {
  GuardActionTier,
  GuardAdvancedConfig,
  GuardFeatureConfig,
  RoleGuardRestrictedPermission,
  SupervisorConfig
} from "../../../../packages/shared/src";
import type { MemberService } from "./member-service";

type GuardFeatureKey =
  | "channel-guard"
  | "category-guard"
  | "webhook-guard"
  | "bot-guard"
  | "guild-settings-guard"
  | "manual-action-guard"
  | "bulk-action-guard"
  | "role-guard"
  | "anti-raid-guard"
  | "invite-link-guard"
  | "message-nuke-guard"
  | "settings-rollback-guard";

type GuardSeverity = "info" | "warning" | "critical";

interface GuardFeatureOptions {
  featureKey: GuardFeatureKey;
  eventType: string;
  guild: Guild;
  actorId: string | null;
  actorEntry: GuildAuditLogsEntry["executor"] | null;
  targetId: string | null;
  targetName: string | null;
  severity: GuardSeverity;
  payload?: Record<string, unknown>;
  externalGuardId?: string | null;
  occurredAt?: Date | null;
  quarantineRequested?: boolean;
  extraAction?: () => Promise<string | null>;
}

const PROCESSED_ENTRY_TTL_MS = 5 * 60 * 1000;
const DEFAULT_AUDIT_WINDOW_SECONDS = 180;
const FEATURE_KEY_TO_CONFIG_KEY: Record<
  GuardFeatureKey,
  keyof SupervisorConfig["ultraProtection"]
> = {
  "channel-guard": "channelGuard",
  "category-guard": "categoryGuard",
  "webhook-guard": "webhookGuard",
  "bot-guard": "botGuard",
  "guild-settings-guard": "guildSettingsGuard",
  "manual-action-guard": "manualActionGuard",
  "bulk-action-guard": "bulkActionGuard",
  "role-guard": "roleGuard",
  "anti-raid-guard": "antiRaidGuard",
  "invite-link-guard": "inviteLinkGuard",
  "message-nuke-guard": "messageNukeGuard",
  "settings-rollback-guard": "settingsRollbackGuard"
};

export class GuardService {
  // Audit-log entry IDs we already processed; used to avoid duplicate guard_events
  // inserts when audit polling overlaps with event-based handlers.
  private readonly processedEntryIds = new Map<string, number>();

  // Anti-raid sliding window per guild: join timestamps (ms)
  private readonly raidJoinWindows = new Map<string, number[]>();

  // Raid mode active-until timestamp per guild (ms)
  private readonly raidModeUntil = new Map<string, number>();

  // Message deletion sliding windows per "guildId:actorId" key
  private readonly messageDeleteWindows = new Map<string, number[]>();

  constructor(
    private readonly sql: Sql,
    private readonly logger: Logger,
    private readonly memberService: MemberService,
    private readonly getConfig: () => SupervisorConfig,
    private readonly timezone: string
  ) {}

  async maybeCreateAutoBackup(guild: Guild) {
    const protection = this.getConfig().ultraProtection;
    if (!protection.serverBackup.enabled || !protection.serverBackup.autoCreateOnBoot) {
      return;
    }

    const [recentBackup] = await this.sql<{ id: number }[]>`
      SELECT id
      FROM server_backups
      WHERE guild_id = ${guild.id}
        AND backup_type = 'auto-boot'
        AND created_at >= NOW() - INTERVAL '12 hours'
      LIMIT 1
    `;
    if (recentBackup) {
      return;
    }

    await this.createBackupFromGuild(guild, "auto-boot", null);
  }

  async createBackupFromGuild(guild: Guild, backupType: string, createdBy: string | null) {
    const roles = await guild.roles.fetch();
    const channels = await guild.channels.fetch();
    const payload = {
      capturedAt: new Date().toISOString(),
      guild: {
        id: guild.id,
        name: guild.name,
        iconUrl: guild.iconURL(),
        bannerUrl: guild.bannerURL(),
        verificationLevel: guild.verificationLevel,
        defaultMessageNotifications: guild.defaultMessageNotifications,
        explicitContentFilter: guild.explicitContentFilter,
        afkChannelId: guild.afkChannelId,
        systemChannelId: guild.systemChannelId
      },
      roles: [...roles.values()]
        .filter((role): role is Exclude<typeof role, null> => Boolean(role && role.id !== guild.id))
        .map((role) => ({
          id: role.id,
          name: role.name,
          position: role.position,
          color: role.color,
          mentionable: role.mentionable,
          managed: role.managed,
          hoist: role.hoist,
          permissions: role.permissions.toArray().sort()
        }))
        .sort((left, right) => right.position - left.position),
      channels: [...channels.values()]
        .filter(
          (channel): channel is Exclude<typeof channel, null> =>
            Boolean(channel && !channel.isThread())
        )
        .map((channel) => ({
          id: channel.id,
          name: channel.name,
          type: channel.type,
          parentId: channel.parentId,
          position: channel.position
        }))
        .sort((left, right) => left.position - right.position),
      config: this.getConfig().ultraProtection
    };

    const summary = {
      roleCount: payload.roles.length,
      channelCount: payload.channels.length,
      guildName: guild.name,
      backupType
    };

    await this.sql`
      INSERT INTO server_backups (
        guild_id,
        backup_type,
        created_by,
        summary,
        payload
      )
      VALUES (
        ${guild.id},
        ${backupType},
        ${createdBy},
        ${JSON.stringify(summary)}::jsonb,
        ${JSON.stringify(payload)}::jsonb
      )
    `;
  }

  async handleChannelCreate(channel: NonThreadGuildBasedChannel) {
    if (!this.isRelevantChannel(channel)) {
      return;
    }

    const featureKey = this.isCategoryChannel(channel) ? "category-guard" : "channel-guard";
    if (!this.isFeatureEnabled(featureKey)) {
      return;
    }

    const auditEntry = await this.findAuditEntry(
      channel.guild,
      AuditLogEvent.ChannelCreate,
      channel.id,
      this.getFeatureAuditWindowMs(featureKey)
    );
    if (!auditEntry) {
      return;
    }

    await this.processGuardFeature({
      featureKey,
      eventType: "create",
      guild: channel.guild,
      actorId: auditEntry.executorId ? String(auditEntry.executorId) : null,
      actorEntry: auditEntry.executor ?? null,
      targetId: channel.id,
      targetName: channel.name,
      severity: "warning",
      externalGuardId: `${featureKey}:${auditEntry.id}`,
      occurredAt: auditEntry.createdAt ?? new Date(),
      quarantineRequested: this.getFeatureConfig(featureKey).quarantine,
      payload: {
        targetType: this.isCategoryChannel(channel) ? "category" : "channel",
        auditReason: auditEntry.reason ?? null,
        auditChanges: this.serializeAuditChanges(auditEntry),
        afterSnapshot: this.createChannelSnapshot(channel)
      },
      extraAction: async () => {
        try {
          await channel.delete("Ultra Koruma: izinsiz kanal olusturma");
          return "kanal-silindi";
        } catch (error) {
          this.logger.warn({ error, channelId: channel.id }, "Guard channel create revert failed.");
          return "kanal-silinmedi";
        }
      }
    });
  }

  async handleChannelDelete(channel: NonThreadGuildBasedChannel) {
    if (!this.isRelevantChannel(channel)) {
      return;
    }

    const featureKey = this.isCategoryChannel(channel) ? "category-guard" : "channel-guard";
    if (!this.isFeatureEnabled(featureKey)) {
      return;
    }

    const auditEntry = await this.findAuditEntry(
      channel.guild,
      AuditLogEvent.ChannelDelete,
      channel.id,
      this.getFeatureAuditWindowMs(featureKey)
    );
    if (!auditEntry) {
      return;
    }

    const beforeSnapshot = this.createChannelSnapshot(channel);
    const featureConfig = this.getFeatureConfig(featureKey) as {
      quarantine: boolean;
      restoreOnDelete?: boolean;
    };
    const isCategory = this.isCategoryChannel(channel);

    await this.processGuardFeature({
      featureKey,
      eventType: "delete",
      guild: channel.guild,
      actorId: auditEntry.executorId ? String(auditEntry.executorId) : null,
      actorEntry: auditEntry.executor ?? null,
      targetId: channel.id,
      targetName: channel.name,
      severity: "critical",
      externalGuardId: `${featureKey}:${auditEntry.id}`,
      occurredAt: auditEntry.createdAt ?? new Date(),
      quarantineRequested: featureConfig.quarantine,
      payload: {
        targetType: isCategory ? "category" : "channel",
        auditReason: auditEntry.reason ?? null,
        auditChanges: this.serializeAuditChanges(auditEntry),
        beforeSnapshot
      },
      extraAction: featureConfig.restoreOnDelete
        ? async () => {
            return this.restoreDeletedChannel(channel.guild, beforeSnapshot, isCategory);
          }
        : undefined
    });
  }

  private async restoreDeletedChannel(
    guild: Guild,
    snapshot: ReturnType<GuardService["createChannelSnapshot"]>,
    isCategory: boolean
  ): Promise<string> {
    try {
      const createOptions: Record<string, unknown> = {
        name: snapshot.name ?? (isCategory ? "restored-category" : "restored-channel"),
        type: snapshot.rawType,
        reason: "Ultra Koruma: izinsiz silme sonrasi otomatik geri yukleme"
      };

      if (!isCategory) {
        if (snapshot.parentId) {
          createOptions.parent = snapshot.parentId;
        }
        if (typeof snapshot.topic === "string") {
          createOptions.topic = snapshot.topic;
        }
        if (typeof snapshot.nsfw === "boolean") {
          createOptions.nsfw = snapshot.nsfw;
        }
        if (typeof snapshot.rateLimitPerUser === "number") {
          createOptions.rateLimitPerUser = snapshot.rateLimitPerUser;
        }
        if (typeof snapshot.bitrate === "number" && snapshot.bitrate > 0) {
          createOptions.bitrate = snapshot.bitrate;
        }
        if (typeof snapshot.userLimit === "number" && snapshot.userLimit > 0) {
          createOptions.userLimit = snapshot.userLimit;
        }
      }

      if (
        Array.isArray(snapshot.permissionOverwrites) &&
        snapshot.permissionOverwrites.length > 0
      ) {
        createOptions.permissionOverwrites = snapshot.permissionOverwrites.map((overwrite) => ({
          id: overwrite.id,
          type: overwrite.type,
          allow: Array.isArray(overwrite.allow) ? overwrite.allow : [],
          deny: Array.isArray(overwrite.deny) ? overwrite.deny : []
        }));
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const created = await guild.channels.create(createOptions as any);

      if (isCategory && created?.id && snapshot.id) {
        await this.reparentOrphanedChildren(guild, snapshot.id, created.id);
      }

      return isCategory ? "kategori-geri-yuklendi" : "kanal-geri-yuklendi";
    } catch (error) {
      this.logger.warn(
        { error, channelId: snapshot.id, isCategory },
        "Guard channel restore failed."
      );
      return isCategory ? "kategori-geri-yuklenemedi" : "kanal-geri-yuklenemedi";
    }
  }

  private async reparentOrphanedChildren(
    guild: Guild,
    oldCategoryId: string,
    newCategoryId: string
  ) {
    // Look up latest server backup to learn which channels used to live under
    // the deleted category; any such channel that is still present in the guild
    // but currently parent-less gets re-adopted by the freshly recreated category.
    const [latestBackup] = await this.sql<{ payload: unknown }[]>`
      SELECT payload
      FROM server_backups
      WHERE guild_id = ${guild.id}
      ORDER BY created_at DESC
      LIMIT 1
    `;
    if (!latestBackup) {
      return;
    }

    const payload = latestBackup.payload as { channels?: Array<{ id: string; parentId: string | null }> };
    const children = Array.isArray(payload.channels)
      ? payload.channels.filter((item) => item && item.parentId === oldCategoryId)
      : [];

    for (const child of children) {
      const liveChannel = guild.channels.cache.get(child.id) as GuildBasedChannel | undefined;
      if (!liveChannel || liveChannel.isThread()) {
        continue;
      }
      const currentParentId = (liveChannel as NonThreadGuildBasedChannel).parentId;
      if (currentParentId) {
        continue;
      }
      try {
        await (liveChannel as NonThreadGuildBasedChannel).setParent(newCategoryId, {
          lockPermissions: false,
          reason: "Ultra Koruma: kategori geri yuklendi"
        });
      } catch (error) {
        this.logger.warn(
          { error, childId: child.id, newCategoryId },
          "Guard reparent orphan child failed."
        );
      }
    }
  }

  async handleChannelUpdate(
    oldChannel: NonThreadGuildBasedChannel,
    newChannel: NonThreadGuildBasedChannel
  ) {
    if (!this.isRelevantChannel(newChannel)) {
      return;
    }

    const changes = this.buildChannelDiff(oldChannel, newChannel);
    if (!changes.length) {
      return;
    }

    const featureKey = this.isCategoryChannel(newChannel) ? "category-guard" : "channel-guard";
    if (!this.isFeatureEnabled(featureKey)) {
      return;
    }

    const auditEntry = await this.findAuditEntry(
      newChannel.guild,
      AuditLogEvent.ChannelUpdate,
      newChannel.id,
      this.getFeatureAuditWindowMs(featureKey)
    );
    if (!auditEntry) {
      return;
    }

    await this.processGuardFeature({
      featureKey,
      eventType: "update",
      guild: newChannel.guild,
      actorId: auditEntry.executorId ? String(auditEntry.executorId) : null,
      actorEntry: auditEntry.executor ?? null,
      targetId: newChannel.id,
      targetName: newChannel.name,
      severity: "warning",
      externalGuardId: `${featureKey}:${auditEntry.id}`,
      occurredAt: auditEntry.createdAt ?? new Date(),
      quarantineRequested: this.getFeatureConfig(featureKey).quarantine,
      payload: {
        targetType: this.isCategoryChannel(newChannel) ? "category" : "channel",
        auditReason: auditEntry.reason ?? null,
        auditChanges: this.serializeAuditChanges(auditEntry),
        changes,
        beforeSnapshot: this.createChannelSnapshot(oldChannel),
        afterSnapshot: this.createChannelSnapshot(newChannel)
      }
    });
  }

  async handleGuildUpdate(oldGuild: Guild, newGuild: Guild) {
    if (!this.isFeatureEnabled("guild-settings-guard")) {
      return;
    }

    const changes = this.buildGuildDiff(oldGuild, newGuild);
    if (!changes.length) {
      return;
    }

    const auditEntry = await this.findAuditEntry(
      newGuild,
      AuditLogEvent.GuildUpdate,
      newGuild.id,
      this.getFeatureAuditWindowMs("guild-settings-guard")
    );
    if (!auditEntry) {
      return;
    }

    const settingsRollback = this.getConfig().ultraProtection.settingsRollbackGuard;
    const rollbackEnabled = Boolean(settingsRollback.enabled);

    await this.processGuardFeature({
      featureKey: "guild-settings-guard",
      eventType: "update",
      guild: newGuild,
      actorId: auditEntry.executorId ? String(auditEntry.executorId) : null,
      actorEntry: auditEntry.executor ?? null,
      targetId: newGuild.id,
      targetName: newGuild.name,
      severity: "critical",
      externalGuardId: `guild-settings-guard:${auditEntry.id}`,
      occurredAt: auditEntry.createdAt ?? new Date(),
      quarantineRequested: this.getFeatureConfig("guild-settings-guard").quarantine,
      payload: {
        targetType: "guild",
        auditReason: auditEntry.reason ?? null,
        auditChanges: this.serializeAuditChanges(auditEntry),
        changes,
        beforeSnapshot: this.createGuildSnapshot(oldGuild),
        afterSnapshot: this.createGuildSnapshot(newGuild),
        rollbackRequested: rollbackEnabled
      },
      extraAction: rollbackEnabled
        ? async () => this.rollbackGuildSettings(oldGuild, newGuild)
        : undefined
    });
  }

  private async rollbackGuildSettings(oldGuild: Guild, newGuild: Guild): Promise<string> {
    const config = this.getConfig().ultraProtection.settingsRollbackGuard;
    if (!config.enabled || !config.rollbackFields.length) {
      return "rollback-pasif";
    }

    const reason = "Ultra Koruma: sunucu ayarlari otomatik rollback";
    const restored: string[] = [];
    const failed: string[] = [];

    const tryField = async (field: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
        restored.push(field);
      } catch (error) {
        this.logger.warn({ error, field }, "Guard settings rollback field failed.");
        failed.push(field);
      }
    };

    for (const field of config.rollbackFields) {
      switch (field) {
        case "name":
          if (oldGuild.name !== newGuild.name) {
            await tryField(field, () => newGuild.setName(oldGuild.name, reason));
          }
          break;
        case "iconUrl":
          if ((oldGuild.icon ?? null) !== (newGuild.icon ?? null)) {
            await tryField(field, () =>
              newGuild.setIcon(oldGuild.iconURL({ size: 2048 }) ?? null, reason)
            );
          }
          break;
        case "bannerUrl":
          if ((oldGuild.banner ?? null) !== (newGuild.banner ?? null)) {
            await tryField(field, () =>
              newGuild.setBanner(oldGuild.bannerURL({ size: 2048 }) ?? null, reason)
            );
          }
          break;
        case "verificationLevel":
          if (oldGuild.verificationLevel !== newGuild.verificationLevel) {
            await tryField(field, () =>
              newGuild.setVerificationLevel(oldGuild.verificationLevel, reason)
            );
          }
          break;
        case "explicitContentFilter":
          if (oldGuild.explicitContentFilter !== newGuild.explicitContentFilter) {
            await tryField(field, () =>
              newGuild.setExplicitContentFilter(oldGuild.explicitContentFilter, reason)
            );
          }
          break;
        case "defaultMessageNotifications":
          if (
            oldGuild.defaultMessageNotifications !== newGuild.defaultMessageNotifications
          ) {
            await tryField(field, () =>
              newGuild.setDefaultMessageNotifications(
                oldGuild.defaultMessageNotifications,
                reason
              )
            );
          }
          break;
        case "systemChannelId":
          if (oldGuild.systemChannelId !== newGuild.systemChannelId) {
            await tryField(field, () =>
              newGuild.setSystemChannel(oldGuild.systemChannelId, reason)
            );
          }
          break;
        case "rulesChannelId":
          if (oldGuild.rulesChannelId !== newGuild.rulesChannelId) {
            await tryField(field, () =>
              newGuild.edit({ rulesChannel: oldGuild.rulesChannelId, reason })
            );
          }
          break;
        case "publicUpdatesChannelId":
          if (oldGuild.publicUpdatesChannelId !== newGuild.publicUpdatesChannelId) {
            await tryField(field, () =>
              newGuild.edit({
                publicUpdatesChannel: oldGuild.publicUpdatesChannelId,
                reason
              })
            );
          }
          break;
        default:
          break;
      }
    }

    if (!restored.length && !failed.length) {
      return "rollback-gereksiz";
    }
    if (!failed.length) {
      return `rollback-tamam(${restored.join(",")})`;
    }
    if (!restored.length) {
      return `rollback-basarisiz(${failed.join(",")})`;
    }
    return `rollback-kismi(ok=${restored.join(",")};fail=${failed.join(",")})`;
  }

  // ---------------------------------------------------------------------------
  // Role Guard
  // ---------------------------------------------------------------------------

  private isRiskyRolePermissions(role: Role | { permissions: PermissionsBitField | string | bigint }) {
    const config = this.getConfig().ultraProtection.roleGuard;
    if (!config.restrictedPermissions.length) {
      return [] as RoleGuardRestrictedPermission[];
    }
    const rawBits =
      role.permissions instanceof PermissionsBitField
        ? role.permissions
        : new PermissionsBitField(BigInt(role.permissions as unknown as string));
    const matched: RoleGuardRestrictedPermission[] = [];
    for (const perm of config.restrictedPermissions) {
      try {
        if (rawBits.has(perm)) {
          matched.push(perm);
        }
      } catch {
        // ignore unknown perm strings
      }
    }
    return matched;
  }

  private createRoleSnapshot(role: Role | null) {
    if (!role) return null;
    return {
      id: role.id,
      name: role.name,
      color: role.color,
      hoist: role.hoist,
      mentionable: role.mentionable,
      permissionsBits: role.permissions.bitfield.toString(),
      position: role.position
    };
  }

  async handleRoleCreate(role: Role) {
    if (!this.isFeatureEnabled("role-guard")) {
      return;
    }

    const auditEntry = await this.findAuditEntry(
      role.guild,
      AuditLogEvent.RoleCreate,
      role.id,
      this.getFeatureAuditWindowMs("role-guard")
    );
    if (!auditEntry) {
      return;
    }

    const risky = this.isRiskyRolePermissions(role);
    const guardConfig = this.getConfig().ultraProtection.roleGuard;

    await this.processGuardFeature({
      featureKey: "role-guard",
      eventType: "create",
      guild: role.guild,
      actorId: auditEntry.executorId ? String(auditEntry.executorId) : null,
      actorEntry: auditEntry.executor ?? null,
      targetId: role.id,
      targetName: role.name,
      severity: risky.length ? "critical" : "warning",
      externalGuardId: `role-guard:${auditEntry.id}`,
      occurredAt: auditEntry.createdAt ?? new Date(),
      quarantineRequested: risky.length > 0 && guardConfig.quarantine,
      payload: {
        targetType: "role",
        auditReason: auditEntry.reason ?? null,
        auditChanges: this.serializeAuditChanges(auditEntry),
        riskyPermissions: risky,
        afterSnapshot: this.createRoleSnapshot(role)
      },
      extraAction:
        risky.length > 0 && guardConfig.autoDeleteRiskyNewRoles
          ? async () => {
              try {
                await role.delete("Ultra Koruma: yuksek yetkili yeni rol");
                return "rol-silindi";
              } catch (error) {
                this.logger.warn({ error, roleId: role.id }, "Guard role delete failed.");
                return "rol-silinemedi";
              }
            }
          : undefined
    });
  }

  async handleRoleDelete(role: Role) {
    if (!this.isFeatureEnabled("role-guard")) {
      return;
    }

    const auditEntry = await this.findAuditEntry(
      role.guild,
      AuditLogEvent.RoleDelete,
      role.id,
      this.getFeatureAuditWindowMs("role-guard")
    );
    if (!auditEntry) {
      return;
    }

    const protection = this.getConfig().ultraProtection;
    const roleConfig = protection.roleGuard;
    const roles = this.getConfig().roles;
    const knownCriticalRoleIds = new Set<string>([
      ...roleConfig.protectedRoleIds,
      ...roles.staffRoleIds,
      ...roles.upperStaffRoleIds,
      ...roles.supervisorRoleIds,
      ...roles.banRoleIds,
      ...roles.kickRoleIds,
      ...roles.unbanRoleIds,
      ...roles.timeoutRoleIds,
      ...roles.warnRoleIds,
      ...roles.jailRoleIds
    ]);
    const wasCritical = knownCriticalRoleIds.has(role.id);
    const snapshot = this.createRoleSnapshot(role);

    await this.processGuardFeature({
      featureKey: "role-guard",
      eventType: "delete",
      guild: role.guild,
      actorId: auditEntry.executorId ? String(auditEntry.executorId) : null,
      actorEntry: auditEntry.executor ?? null,
      targetId: role.id,
      targetName: role.name,
      severity: wasCritical ? "critical" : "warning",
      externalGuardId: `role-guard:${auditEntry.id}`,
      occurredAt: auditEntry.createdAt ?? new Date(),
      quarantineRequested: wasCritical && roleConfig.quarantine,
      payload: {
        targetType: "role",
        auditReason: auditEntry.reason ?? null,
        auditChanges: this.serializeAuditChanges(auditEntry),
        wasCritical,
        beforeSnapshot: snapshot
      },
      extraAction: wasCritical
        ? async () => {
            try {
              await role.guild.roles.create({
                name: role.name,
                color: role.color,
                hoist: role.hoist,
                mentionable: role.mentionable,
                permissions: role.permissions,
                reason: "Ultra Koruma: kritik rol otomatik geri yukleme"
              });
              return "rol-geri-yuklendi";
            } catch (error) {
              this.logger.warn({ error, roleId: role.id }, "Guard role restore failed.");
              return "rol-geri-yuklenemedi";
            }
          }
        : undefined
    });
  }

  async handleRoleUpdate(oldRole: Role, newRole: Role) {
    if (!this.isFeatureEnabled("role-guard")) {
      return;
    }

    // Only care about permission escalations.
    if (oldRole.permissions.bitfield === newRole.permissions.bitfield) {
      return;
    }

    const oldRisky = new Set(this.isRiskyRolePermissions(oldRole));
    const newRisky = this.isRiskyRolePermissions(newRole);
    const escalated = newRisky.filter((perm) => !oldRisky.has(perm));
    if (escalated.length === 0) {
      return;
    }

    const auditEntry = await this.findAuditEntry(
      newRole.guild,
      AuditLogEvent.RoleUpdate,
      newRole.id,
      this.getFeatureAuditWindowMs("role-guard")
    );
    if (!auditEntry) {
      return;
    }

    const roleConfig = this.getConfig().ultraProtection.roleGuard;

    await this.processGuardFeature({
      featureKey: "role-guard",
      eventType: "update",
      guild: newRole.guild,
      actorId: auditEntry.executorId ? String(auditEntry.executorId) : null,
      actorEntry: auditEntry.executor ?? null,
      targetId: newRole.id,
      targetName: newRole.name,
      severity: "critical",
      externalGuardId: `role-guard:${auditEntry.id}`,
      occurredAt: auditEntry.createdAt ?? new Date(),
      quarantineRequested: roleConfig.quarantine,
      payload: {
        targetType: "role",
        auditReason: auditEntry.reason ?? null,
        auditChanges: this.serializeAuditChanges(auditEntry),
        escalatedPermissions: escalated,
        beforeSnapshot: this.createRoleSnapshot(oldRole),
        afterSnapshot: this.createRoleSnapshot(newRole)
      },
      extraAction: async () => {
        try {
          await newRole.setPermissions(
            oldRole.permissions,
            "Ultra Koruma: rol izinleri rollback"
          );
          return "rol-izinleri-rollback";
        } catch (error) {
          this.logger.warn({ error, roleId: newRole.id }, "Guard role permission rollback failed.");
          return "rol-izinleri-rollback-basarisiz";
        }
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Anti-Raid Guard
  // ---------------------------------------------------------------------------

  async handleMemberJoinForRaid(member: GuildMember) {
    if (member.user.bot) {
      return;
    }
    if (!this.isFeatureEnabled("anti-raid-guard")) {
      return;
    }

    const guild = member.guild;
    const config = this.getConfig().ultraProtection.antiRaidGuard;
    const now = Date.now();
    const windowMs = Math.max(1, config.windowSeconds) * 1000;

    // Update sliding window
    const joinList = this.raidJoinWindows.get(guild.id) ?? [];
    const recent = joinList.filter((ts) => now - ts <= windowMs);
    recent.push(now);
    this.raidJoinWindows.set(guild.id, recent);

    const raidActive = (this.raidModeUntil.get(guild.id) ?? 0) > now;
    const thresholdHit = recent.length >= Math.max(2, config.joinThreshold);

    if (!raidActive && thresholdHit) {
      // Enter raid mode
      this.raidModeUntil.set(
        guild.id,
        now + Math.max(1, config.raidModeCooldownMinutes) * 60_000
      );
      this.logger.warn(
        { guildId: guild.id, joins: recent.length, windowSeconds: config.windowSeconds },
        "Anti-raid mode entered."
      );
    }

    const inRaidMode = (this.raidModeUntil.get(guild.id) ?? 0) > now;
    if (!inRaidMode) {
      return;
    }

    const accountAgeDays =
      (now - member.user.createdAt.getTime()) / (1000 * 60 * 60 * 24);
    const isYoung = accountAgeDays < Math.max(0, config.minAccountAgeDays);

    const severity: GuardSeverity = isYoung ? "critical" : "warning";
    const externalGuardId = `anti-raid-guard:${guild.id}:${member.id}:${Math.floor(now / 1000)}`;
    const protection = this.getConfig().ultraProtection;

    await this.processGuardFeature({
      featureKey: "anti-raid-guard",
      eventType: isYoung ? "raid-young-join" : "raid-window-join",
      guild,
      actorId: member.id,
      actorEntry: member.user,
      targetId: member.id,
      targetName: member.user.username,
      severity,
      externalGuardId,
      occurredAt: new Date(now),
      quarantineRequested: isYoung && config.quarantine,
      payload: {
        targetType: "member",
        raidJoinCountInWindow: recent.length,
        windowSeconds: config.windowSeconds,
        joinThreshold: config.joinThreshold,
        accountAgeDays: Math.round(accountAgeDays * 100) / 100,
        minAccountAgeDays: config.minAccountAgeDays,
        raidAction: config.raidAction,
        raidModeUntil: new Date(this.raidModeUntil.get(guild.id) ?? now).toISOString(),
        memberSnapshot: this.createMemberSnapshot(member)
      },
      extraAction: isYoung
        ? async () => {
            const action = config.raidAction;
            const reason = "Ultra Koruma: anti-raid";
            try {
              if (action === "ban" && member.bannable) {
                // DM embed BEFORE ban (closed channel after ban).
                const embed = this.buildGuardActionEmbed(
                  guild,
                  "ban",
                  "anti-raid-guard",
                  "raid-young-join",
                  {
                    appealNote:
                      "Hesap yaşı sınırının altında olduğunuz ve sunucuda bir raid (akın) " +
                      "tespit edildiği için otomatik koruma sistemi tarafından yasaklandınız. " +
                      "Yanlış olduğunu düşünüyorsanız sunucu yetkilileri ile iletişime geçin."
                  }
                );
                await this.sendActionDm(member, embed);
                await member.ban({ reason, deleteMessageSeconds: 0 });
                return "raid-ban";
              }
              if (action === "kick" && member.kickable) {
                const embed = this.buildGuardActionEmbed(
                  guild,
                  "kick",
                  "anti-raid-guard",
                  "raid-young-join",
                  {
                    appealNote:
                      "Sunucuda kısa süre içinde çok sayıda yeni hesap girişi (raid) " +
                      "tespit edildi ve hesap yaşınız sınırın altında olduğu için otomatik " +
                      "olarak çıkarıldınız. Sunucuya tekrar girmeyi denemekte serbestsiniz."
                  }
                );
                await this.sendActionDm(member, embed);
                await member.kick(reason);
                return "raid-kick";
              }
              if (action === "quarantine" && protection.quarantineRoleId) {
                await this.applyQuarantine(
                  guild,
                  member.id,
                  "anti-raid-guard",
                  "raid-young-join",
                  member
                );
                return "raid-karantina";
              }
              return "raid-aksiyon-uygulanamadi";
            } catch (error) {
              this.logger.warn(
                { error, memberId: member.id, action },
                "Anti-raid action failed."
              );
              return "raid-aksiyon-basarisiz";
            }
          }
        : undefined
    });
  }

  // ---------------------------------------------------------------------------
  // Invite / Link Guard
  // ---------------------------------------------------------------------------

  async handleMessageForInviteLink(message: Message | PartialMessage) {
    if (!message.guild || !message.author || message.author.bot) {
      return;
    }
    if (!this.isFeatureEnabled("invite-link-guard")) {
      return;
    }
    const content = message.content ?? "";
    if (!content) {
      return;
    }

    const config = this.getConfig().ultraProtection.inviteLinkGuard;
    const channelId = message.channelId ?? message.channel?.id ?? null;
    if (channelId && config.exemptChannelIds.includes(channelId)) {
      return;
    }

    const discordInviteRegex = /(?:https?:\/\/)?(?:www\.)?(?:discord\.(?:gg|com\/invite|me|io|li)|disco(?:rd)?app\.com\/invite)\/[a-z0-9-_]+/gi;
    const urlRegex = /https?:\/\/([\w.-]+)/gi;

    const hasDiscordInvite = discordInviteRegex.test(content);
    const disallowedExternal: string[] = [];
    if (config.allowedDomains.length > 0) {
      const allowed = config.allowedDomains.map((d) => d.toLowerCase().replace(/^https?:\/\//, ""));
      let match: RegExpExecArray | null;
      while ((match = urlRegex.exec(content)) !== null) {
        const host = match[1].toLowerCase();
        const ok = allowed.some((d) => host === d || host.endsWith(`.${d}`));
        if (!ok) {
          disallowedExternal.push(host);
        }
      }
    }

    const shouldAct =
      (config.blockDiscordInvites && hasDiscordInvite) || disallowedExternal.length > 0;
    if (!shouldAct) {
      return;
    }

    const externalGuardId = `invite-link-guard:${message.id}`;
    const memberSnap = message.member ? this.createMemberSnapshot(message.member) : null;

    await this.processGuardFeature({
      featureKey: "invite-link-guard",
      eventType: hasDiscordInvite ? "discord-invite" : "external-link",
      guild: message.guild,
      actorId: message.author.id,
      actorEntry: message.author,
      targetId: message.id,
      targetName: message.author.username ?? null,
      severity: "warning",
      externalGuardId,
      occurredAt: message.createdAt ?? new Date(),
      quarantineRequested:
        config.actionOnViolation === "quarantine" && config.quarantine,
      payload: {
        targetType: "message",
        channelId,
        contentSnippet: content.slice(0, 500),
        hasDiscordInvite,
        disallowedDomains: disallowedExternal,
        actionOnViolation: config.actionOnViolation,
        memberSnapshot: memberSnap
      },
      extraAction: async () => {
        try {
          const action = config.actionOnViolation;
          if (action === "delete" || action === "timeout" || action === "quarantine") {
            // Always delete the offending message (cheap + high signal).
            try {
              if (message.deletable) {
                await message.delete();
              }
            } catch {
              // non-fatal
            }
          }

          if (action === "timeout") {
            const member = message.member ??
              (await message.guild!.members.fetch(message.author!.id).catch(() => null));
            if (member?.moderatable) {
              await member.timeout(10 * 60 * 1000, "Ultra Koruma: invite/link");
              return "link-timeout";
            }
            return "link-timeout-uygulanamadi";
          }

          return "link-silindi";
        } catch (error) {
          this.logger.warn({ error, messageId: message.id }, "Invite/link guard action failed.");
          return "link-aksiyon-basarisiz";
        }
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Message Nuke Guard
  // ---------------------------------------------------------------------------

  async handleMessageDeletedForNuke(message: Message | PartialMessage) {
    if (!message.guild) {
      return;
    }
    if (!this.isFeatureEnabled("message-nuke-guard")) {
      return;
    }
    // Ignore bot-authored (e.g. our own purge) deletions.
    if (message.author?.id === message.guild.client.user?.id) {
      return;
    }

    const config = this.getConfig().ultraProtection.messageNukeGuard;
    const audit = await message.guild
      .fetchAuditLogs({ type: AuditLogEvent.MessageDelete, limit: 5 })
      .catch(() => null);
    if (!audit) {
      return;
    }
    const recentEntry = audit.entries.first();
    const actorId =
      recentEntry && recentEntry.executorId ? String(recentEntry.executorId) : null;
    if (!actorId || actorId === message.guild.client.user?.id) {
      return;
    }

    const now = Date.now();
    const windowMs = Math.max(1, config.windowSeconds) * 1000;
    const key = `${message.guild.id}:${actorId}`;
    const list = (this.messageDeleteWindows.get(key) ?? []).filter(
      (ts) => now - ts <= windowMs
    );
    list.push(now);
    this.messageDeleteWindows.set(key, list);
    if (list.length < Math.max(3, config.deleteThreshold)) {
      return;
    }

    const externalGuardId = `message-nuke-guard:${message.guild.id}:${actorId}:${Math.floor(now / windowMs)}`;

    await this.processGuardFeature({
      featureKey: "message-nuke-guard",
      eventType: "single-delete-burst",
      guild: message.guild,
      actorId,
      actorEntry: recentEntry?.executor ?? null,
      targetId: actorId,
      targetName: recentEntry?.executor?.username ?? null,
      severity: "critical",
      externalGuardId,
      occurredAt: new Date(now),
      quarantineRequested: config.quarantine,
      payload: {
        targetType: "member",
        deletionsInWindow: list.length,
        windowSeconds: config.windowSeconds,
        threshold: config.deleteThreshold,
        sourceChannelId: message.channelId ?? null
      }
    });
  }

  async handleMessageBulkDeletedForNuke(
    guild: Guild | null,
    deletedCount: number
  ) {
    if (!guild || !this.isFeatureEnabled("message-nuke-guard")) {
      return;
    }
    const config = this.getConfig().ultraProtection.messageNukeGuard;
    if (deletedCount < Math.max(1, config.bulkDeleteThreshold)) {
      return;
    }

    const audit = await guild
      .fetchAuditLogs({ type: AuditLogEvent.MessageBulkDelete, limit: 3 })
      .catch(() => null);
    if (!audit) {
      return;
    }
    const entry = audit.entries.first();
    if (!entry) {
      return;
    }
    const actorId = entry.executorId ? String(entry.executorId) : null;
    if (!actorId || actorId === guild.client.user?.id) {
      return;
    }

    await this.processGuardFeature({
      featureKey: "message-nuke-guard",
      eventType: "bulk-delete",
      guild,
      actorId,
      actorEntry: entry.executor ?? null,
      targetId: actorId,
      targetName: entry.executor?.username ?? null,
      severity: "critical",
      externalGuardId: `message-nuke-guard:bulk:${entry.id}`,
      occurredAt: entry.createdAt ?? new Date(),
      quarantineRequested: config.quarantine,
      payload: {
        targetType: "member",
        deletedCount,
        bulkThreshold: config.bulkDeleteThreshold,
        auditReason: entry.reason ?? null,
        auditChanges: this.serializeAuditChanges(entry)
      }
    });
  }

  async handleBotAdd(member: GuildMember) {
    if (!member.user.bot || !this.isFeatureEnabled("bot-guard")) {
      return;
    }

    const auditEntry = await this.findAuditEntry(
      member.guild,
      AuditLogEvent.BotAdd,
      member.id,
      this.getFeatureAuditWindowMs("bot-guard")
    );
    if (!auditEntry) {
      return;
    }

    const protection = this.getConfig().ultraProtection;
    const actorId = auditEntry.executorId ? String(auditEntry.executorId) : null;
    await this.processGuardFeature({
      featureKey: "bot-guard",
      eventType: "bot-add",
      guild: member.guild,
      actorId,
      actorEntry: auditEntry.executor ?? null,
      targetId: member.id,
      targetName: member.user.username,
      severity: "critical",
      externalGuardId: `bot-guard:${auditEntry.id}`,
      occurredAt: auditEntry.createdAt ?? new Date(),
      quarantineRequested: protection.botGuard.quarantine,
      payload: {
        targetType: "bot",
        botId: member.id,
        botName: member.user.username,
        auditReason: auditEntry.reason ?? null,
        auditChanges: this.serializeAuditChanges(auditEntry),
        targetSnapshot: this.createMemberSnapshot(member)
      },
      extraAction: async () => {
        if (!protection.botGuard.kickUnauthorizedBots || !member.kickable) {
          return "bot-korundu";
        }

        try {
          await member.kick("Ultra Koruma: izinsiz bot ekleme");
          return "bot-atildi";
        } catch (error) {
          this.logger.warn({ error, botId: member.id }, "Guard bot kick failed.");
          return "bot-atilamadi";
        }
      }
    });
  }

  async pollAuditLogs(guild: Guild) {
    await Promise.all([
      this.collectWebhookEntries(guild),
      this.collectBotAddEntries(guild),
      this.collectManualActionEntries(guild, AuditLogEvent.MemberBanAdd, "ban"),
      this.collectManualActionEntries(guild, AuditLogEvent.MemberKick, "kick"),
      this.collectManualTimeoutEntries(guild)
    ]);
  }

  private async collectWebhookEntries(guild: Guild) {
    if (!this.isFeatureEnabled("webhook-guard")) {
      return;
    }

    const eventTypes = [
      AuditLogEvent.WebhookCreate,
      AuditLogEvent.WebhookDelete,
      AuditLogEvent.WebhookUpdate
    ];

    const webhooks = await guild.fetchWebhooks().catch(() => null);

    for (const eventType of eventTypes) {
      const audit = await guild.fetchAuditLogs({ type: eventType, limit: 12 }).catch(() => null);
      if (!audit) {
        continue;
      }

      const webhookWindowMs = this.getFeatureAuditWindowMs("webhook-guard");
      for (const [, entry] of audit.entries) {
        const createdAt = entry.createdAt ?? new Date();
        if (Date.now() - createdAt.getTime() > webhookWindowMs) {
          continue;
        }

        const targetId =
          entry.target && "id" in entry.target ? String(entry.target.id) : null;
        const targetName =
          entry.target && "name" in entry.target ? String(entry.target.name) : "Webhook";
        const eventName =
          eventType === AuditLogEvent.WebhookCreate
            ? "create"
            : eventType === AuditLogEvent.WebhookDelete
              ? "delete"
              : "update";
        const webhookSnapshot = targetId
          ? this.createWebhookSnapshot(webhooks?.get(targetId) ?? null)
          : null;

        await this.processGuardFeature({
          featureKey: "webhook-guard",
          eventType: eventName,
          guild,
          actorId: entry.executorId ? String(entry.executorId) : null,
          actorEntry: entry.executor ?? null,
          targetId,
          targetName,
          severity: eventName === "delete" ? "critical" : "warning",
          externalGuardId: `webhook-guard:${entry.id}`,
          occurredAt: entry.createdAt ?? new Date(),
          quarantineRequested: this.getFeatureConfig("webhook-guard").quarantine,
          payload: {
            targetType: "webhook",
            auditReason: entry.reason ?? null,
            auditChanges: this.serializeAuditChanges(entry),
            snapshot:
              webhookSnapshot ??
              this.createWebhookSnapshotFromAuditEntry(entry, targetId, targetName)
          },
          extraAction:
            eventType === AuditLogEvent.WebhookCreate
              ? async () => {
                  try {
                    const webhooks = await guild.fetchWebhooks();
                    const webhook = targetId ? webhooks.get(targetId) : null;
                    if (!webhook) {
                      return "webhook-bulunamadi";
                    }
                    await webhook.delete("Ultra Koruma: izinsiz webhook olusturma");
                    return "webhook-silindi";
                  } catch (error) {
                    this.logger.warn({ error, targetId }, "Guard webhook revert failed.");
                    return "webhook-silinmedi";
                  }
                }
              : undefined
        });
      }
    }
  }

  private async collectBotAddEntries(guild: Guild) {
    if (!this.isFeatureEnabled("bot-guard")) {
      return;
    }

    const audit = await guild.fetchAuditLogs({ type: AuditLogEvent.BotAdd, limit: 10 }).catch(() => null);
    if (!audit) {
      return;
    }

    const protection = this.getConfig().ultraProtection;
    const botWindowMs = this.getFeatureAuditWindowMs("bot-guard");
    for (const [, entry] of audit.entries) {
      const createdAt = entry.createdAt ?? new Date();
      if (Date.now() - createdAt.getTime() > botWindowMs) {
        continue;
      }

      const targetId =
        entry.target && "id" in entry.target ? String(entry.target.id) : null;
      const targetName =
        entry.target && "username" in entry.target ? String(entry.target.username) : "Bot";

      await this.processGuardFeature({
        featureKey: "bot-guard",
        eventType: "bot-add",
        guild,
        actorId: entry.executorId ? String(entry.executorId) : null,
        actorEntry: entry.executor ?? null,
        targetId,
        targetName,
        severity: "critical",
        externalGuardId: `bot-guard:${entry.id}`,
        occurredAt: entry.createdAt ?? new Date(),
        quarantineRequested: protection.botGuard.quarantine,
        payload: {
          targetType: "bot",
          botId: targetId,
          botName: targetName,
          auditReason: entry.reason ?? null,
          auditChanges: this.serializeAuditChanges(entry),
          targetSnapshot: this.createAuditTargetSnapshot(entry, targetId, targetName)
        },
        extraAction: async () => {
          if (!protection.botGuard.kickUnauthorizedBots || !targetId) {
            return "bot-korundu";
          }

          const member = await guild.members.fetch(targetId).catch(() => null);
          if (!member || !member.kickable) {
            return "bot-atilamadi";
          }

          try {
            await member.kick("Ultra Koruma: izinsiz bot ekleme");
            return "bot-atildi";
          } catch (error) {
            this.logger.warn({ error, targetId }, "Guard bot kick from audit failed.");
            return "bot-atilamadi";
          }
        }
      });
    }
  }

  private async collectManualActionEntries(
    guild: Guild,
    eventType: AuditLogEvent.MemberBanAdd | AuditLogEvent.MemberKick,
    actionType: "ban" | "kick"
  ) {
    if (!this.isFeatureEnabled("manual-action-guard")) {
      return;
    }

    const audit = await guild.fetchAuditLogs({ type: eventType, limit: 12 }).catch(() => null);
    if (!audit) {
      return;
    }

    const manualWindowMs = this.getFeatureAuditWindowMs("manual-action-guard");
    for (const [, entry] of audit.entries) {
      const createdAt = entry.createdAt ?? new Date();
      if (Date.now() - createdAt.getTime() > manualWindowMs) {
        continue;
      }

      const actorId = entry.executorId ? String(entry.executorId) : null;
      const targetId =
        entry.target && "id" in entry.target ? String(entry.target.id) : null;

      await this.processGuardFeature({
        featureKey: "manual-action-guard",
        eventType: actionType,
        guild,
        actorId,
        actorEntry: entry.executor ?? null,
        targetId,
        targetName: targetId,
        severity: "critical",
        externalGuardId: `manual-action-guard:${entry.id}`,
        occurredAt: entry.createdAt ?? new Date(),
        quarantineRequested: this.getFeatureConfig("manual-action-guard").quarantine,
        payload: {
          targetType: "member",
          auditReason: entry.reason ?? null,
          auditChanges: this.serializeAuditChanges(entry),
          actionType,
          targetSnapshot: this.createAuditTargetSnapshot(entry, targetId, targetId)
        }
      });
    }
  }

  private async collectManualTimeoutEntries(guild: Guild) {
    if (!this.isFeatureEnabled("manual-action-guard")) {
      return;
    }

    const audit = await guild.fetchAuditLogs({
      type: AuditLogEvent.MemberUpdate,
      limit: 20
    }).catch(() => null);
    if (!audit) {
      return;
    }

    const timeoutWindowMs = this.getFeatureAuditWindowMs("manual-action-guard");
    for (const [, entry] of audit.entries) {
      if (!this.isTimeoutEntry(entry)) {
        continue;
      }

      const createdAt = entry.createdAt ?? new Date();
      if (Date.now() - createdAt.getTime() > timeoutWindowMs) {
        continue;
      }

      const actorId = entry.executorId ? String(entry.executorId) : null;
      const targetId =
        entry.target && "id" in entry.target ? String(entry.target.id) : null;

      await this.processGuardFeature({
        featureKey: "manual-action-guard",
        eventType: "timeout",
        guild,
        actorId,
        actorEntry: entry.executor ?? null,
        targetId,
        targetName: targetId,
        severity: "critical",
        externalGuardId: `manual-action-guard:${entry.id}`,
        occurredAt: entry.createdAt ?? new Date(),
        quarantineRequested: this.getFeatureConfig("manual-action-guard").quarantine,
        payload: {
          targetType: "member",
          auditReason: entry.reason ?? null,
          auditChanges: this.serializeAuditChanges(entry),
          actionType: "timeout",
          targetSnapshot: this.createAuditTargetSnapshot(entry, targetId, targetId)
        }
      });
    }
  }

  private async processGuardFeature(options: GuardFeatureOptions) {
    if (options.actorId === options.guild.client.user?.id) {
      return;
    }

    // In-memory dedupe (fast path; DB unique index on external_guard_id is the final
    // safeguard). If we already saw this audit entry in the last 5 minutes, skip.
    if (this.hasProcessedEntry(options.externalGuardId ?? null)) {
      return;
    }

    const automationActive = this.isGuardAutomationActive();
    const createdAt = options.occurredAt ?? new Date();
    const advanced = this.getFeatureAdvanced(options.featureKey);
    const logOnly = advanced.logOnly;

    // PARALLEL FAST-PATH: dedupe SQL, cooldown SQL, and actor classification all
    // run concurrently instead of sequentially. This trims 300-800ms off the
    // reaction window so quarantine/ban happens before the next channel-create
    // event from the same attacker can land.
    const [existingRow, cooldownRow, actorClassification] = await Promise.all([
      this.sql<{ id: number }[]>`
        SELECT id FROM guard_events
        WHERE external_guard_id = ${options.externalGuardId ?? null}
        LIMIT 1
      `,
      advanced.cooldownSeconds > 0 && options.actorId
        ? this.sql<{ id: number }[]>`
            SELECT id FROM guard_events
            WHERE guild_id = ${options.guild.id}
              AND feature_key = ${options.featureKey}
              AND actor_id = ${options.actorId}
              AND created_at >= NOW() - (${advanced.cooldownSeconds} * INTERVAL '1 second')
            LIMIT 1
          `
        : Promise.resolve([] as { id: number }[]),
      options.actorId
        ? this.classifyActor(options.guild, options.actorId, options.featureKey)
        : Promise.resolve({ isBlacklisted: false, isExempt: false, member: null })
    ]);

    if (existingRow[0]) {
      this.rememberProcessedEntry(options.externalGuardId ?? null);
      return;
    }

    const cooldownActive = Boolean(cooldownRow[0]);
    const { isBlacklisted, isExempt, member: cachedMember } = actorClassification;

    // Fire-and-forget: shell sync should never gate the quarantine action.
    if (options.actorEntry) {
      void this.memberService
        .syncUserShell(options.guild.id, options.actorEntry, "user")
        .catch((error) => {
          this.logger.warn(
            { error, actorId: options.actorId },
            "Guard syncUserShell failed."
          );
        });
    }

    const actionParts: string[] = [];
    const canAct = automationActive && !isExempt && !logOnly && !cooldownActive;

    // PARALLEL ACTIONS: run extraAction (e.g. delete the just-created channel)
    // simultaneously with the action-tier execution (quarantine/timeout/kick/ban).
    // Previously these ran sequentially, costing 600-1500ms per event.
    const extraActionPromise: Promise<string | null> = options.extraAction
      ? canAct
        ? options.extraAction().catch((error) => {
            this.logger.warn(
              { error, featureKey: options.featureKey },
              "Guard extraAction failed."
            );
            return "ek-aksiyon-basarisiz";
          })
        : Promise.resolve("sadece-log" as string | null)
      : Promise.resolve(null);

    let tierPromise: Promise<string | null> = Promise.resolve(null);

    if (isExempt) {
      actionParts.push("whitelist-muaf");
    } else if (logOnly) {
      actionParts.push("log-only-mode");
    } else if (cooldownActive) {
      actionParts.push("cooldown-aktif");
    } else if (
      options.actorId &&
      (options.quarantineRequested || isBlacklisted || advanced.actionTier !== "log")
    ) {
      // Resolve action tier: critical/blacklisted ⇒ force quarantine or higher;
      // otherwise honor the configured per-guard tier.
      const desiredTier: GuardActionTier =
        isBlacklisted && advanced.actionTier === "log"
          ? "quarantine"
          : options.quarantineRequested && advanced.actionTier === "log"
            ? "quarantine"
            : advanced.actionTier;

      tierPromise = automationActive
        ? this.executeActionTier(
            desiredTier,
            options.guild,
            options.actorId,
            options.featureKey,
            options.eventType,
            cachedMember
          ).catch((error) => {
            this.logger.warn(
              { error, featureKey: options.featureKey, tier: desiredTier },
              "Guard executeActionTier failed."
            );
            return "aksiyon-basarisiz";
          })
        : Promise.resolve("karantina-atlandi");
    }

    const [extraResult, tierResult] = await Promise.all([extraActionPromise, tierPromise]);
    if (options.extraAction) {
      actionParts.push(extraResult ?? "ek-aksiyon-yok");
    }
    if (tierResult !== null) {
      actionParts.push(tierResult);
    } else if (!automationActive) {
      actionParts.push("pasif-mod-logu");
    } else {
      actionParts.push("uyari");
    }

    const actionTaken = actionParts.filter(Boolean).join(" + ") || "uyari";
    const resolvedSeverity: GuardSeverity = isBlacklisted
      ? "critical"
      : advanced.severityOverride !== "inherit"
        ? advanced.severityOverride
        : options.severity;

    await this.recordGuardEvent({
      ...options,
      occurredAt: createdAt,
      severity: resolvedSeverity,
      actionTaken,
      payload: {
        ...(options.payload ?? {}),
        guardContext: {
          automationActive,
          isExempt,
          isBlacklisted,
          quarantineRequested: Boolean(options.quarantineRequested),
          actorKnown: Boolean(options.actorId),
          logOnly,
          cooldownActive,
          actionTier: advanced.actionTier,
          severityOverride: advanced.severityOverride
        }
      }
    });

    this.rememberProcessedEntry(options.externalGuardId ?? null);

    if (automationActive && options.actorId && !logOnly && !cooldownActive) {
      await this.handleBulkGuard(options.guild, options.actorId, options.actorEntry);
    }
  }

  private async executeActionTier(
    tier: GuardActionTier,
    guild: Guild,
    actorId: string,
    featureKey: GuardFeatureKey,
    eventType: string,
    cachedMember?: GuildMember | null
  ): Promise<string> {
    if (tier === "log") {
      return "sadece-log";
    }

    if (tier === "quarantine") {
      return this.applyQuarantine(guild, actorId, featureKey, eventType, cachedMember);
    }

    const reason = `Ultra Koruma: ${featureKey} / ${eventType}`;
    const member =
      cachedMember ??
      guild.members.cache.get(actorId) ??
      (await guild.members.fetch(actorId).catch(() => null));
    if (!member) {
      return "uye-bulunamadi";
    }
    if (member.id === guild.ownerId) {
      return "kurucu-muaf";
    }

    if (tier === "warn") {
      const embed = this.buildGuardActionEmbed(guild, "warn", featureKey, eventType);
      const delivered = await this.sendActionDm(member, embed);
      return delivered ? "uyari-dm" : "uyari-dm-basarisiz";
    }

    if (tier === "timeout") {
      if (!member.moderatable) {
        return "timeout-uygulanamadi";
      }
      // Run timeout and DM in parallel. Each promise resolves to a boolean
      // independently so we can correctly report partial failures (timeout
      // succeeded but DM failed, etc.) without conflating them.
      const embed = this.buildGuardActionEmbed(guild, "timeout", featureKey, eventType, {
        durationLabel: "1 saat"
      });
      const [timeoutOk, dmDelivered] = await Promise.all([
        member
          .timeout(60 * 60 * 1000, reason)
          .then(() => this.memberService.syncMember(member))
          .then(() => true)
          .catch((error) => {
            this.logger.warn({ error, actorId, featureKey }, "Guard timeout failed.");
            return false;
          }),
        this.sendActionDm(member, embed)
      ]);
      if (!timeoutOk) {
        return "timeout-basarisiz";
      }
      return dmDelivered ? "timeout-uygulandi+dm" : "timeout-uygulandi";
    }

    if (tier === "kick") {
      if (!member.kickable) {
        return "kick-uygulanamadi";
      }
      // DM must go BEFORE kick — once kicked, the user is no longer a guild
      // member and Discord refuses subsequent DMs from the bot.
      const embed = this.buildGuardActionEmbed(guild, "kick", featureKey, eventType, {
        appealNote:
          "Sunucuya tekrar girmek istiyorsanız sunucu daveti üzerinden katılım sağlayabilir, " +
          "yanlışlık olduğunu düşünüyorsanız sunucu yetkilileri ile iletişime geçebilirsiniz."
      });
      const dmDelivered = await this.sendActionDm(member, embed);
      try {
        await member.kick(reason);
        return dmDelivered ? "kick-uygulandi+dm" : "kick-uygulandi";
      } catch (error) {
        this.logger.warn({ error, actorId, featureKey }, "Guard kick failed.");
        return "kick-basarisiz";
      }
    }

    if (tier === "ban") {
      if (!member.bannable) {
        return "ban-uygulanamadi";
      }
      // Same rationale as kick: DM first, ban second.
      const embed = this.buildGuardActionEmbed(guild, "ban", featureKey, eventType, {
        appealNote:
          "Bu yasak, otomatik koruma sistemi tarafından uygulandı. İtiraz veya yanlışlık " +
          "durumunda sunucu yetkilileri ile iletişime geçebilirsiniz."
      });
      const dmDelivered = await this.sendActionDm(member, embed);
      try {
        await member.ban({ reason, deleteMessageSeconds: 0 });
        return dmDelivered ? "ban-uygulandi+dm" : "ban-uygulandi";
      } catch (error) {
        this.logger.warn({ error, actorId, featureKey }, "Guard ban failed.");
        return "ban-basarisiz";
      }
    }

    return "aksiyon-bilinmiyor";
  }

  private async handleBulkGuard(
    guild: Guild,
    actorId: string,
    actorEntry: GuildAuditLogsEntry["executor"] | null
  ) {
    const protection = this.getConfig().ultraProtection;
    if (
      !this.isGuardAutomationActive() ||
      !protection.bulkActionGuard.enabled ||
      actorId === guild.client.user?.id
    ) {
      return;
    }

    const [recentBulkEvent] = await this.sql<{ id: number }[]>`
      SELECT id
      FROM guard_events
      WHERE guild_id = ${guild.id}
        AND feature_key = 'bulk-action-guard'
        AND actor_id = ${actorId}
        AND created_at >= NOW() - (${protection.bulkActionGuard.windowSeconds} * INTERVAL '1 second')
      LIMIT 1
    `;
    if (recentBulkEvent) {
      return;
    }

    const [countRow] = await this.sql<{ event_count: number }[]>`
      SELECT COUNT(*)::int AS event_count
      FROM guard_events
      WHERE guild_id = ${guild.id}
        AND actor_id = ${actorId}
        AND feature_key <> 'bulk-action-guard'
        AND created_at >= NOW() - (${protection.bulkActionGuard.windowSeconds} * INTERVAL '1 second')
    `;
    const eventCount = countRow?.event_count ?? 0;
    if (eventCount < protection.bulkActionGuard.maxActions) {
      return;
    }

    const recentEvents = await this.sql<
      {
        feature_key: string;
        event_type: string;
        created_at: Date;
      }[]
    >`
      SELECT feature_key, event_type, created_at
      FROM guard_events
      WHERE guild_id = ${guild.id}
        AND actor_id = ${actorId}
        AND feature_key <> 'bulk-action-guard'
        AND created_at >= NOW() - (${protection.bulkActionGuard.windowSeconds} * INTERVAL '1 second')
      ORDER BY created_at DESC
      LIMIT 5
    `;

    const quarantineApplied = protection.bulkActionGuard.quarantine
      ? await this.applyQuarantine(guild, actorId, "bulk-action-guard", "burst")
      : "uyari";

    await this.recordGuardEvent({
      featureKey: "bulk-action-guard",
      eventType: "burst",
      guild,
      actorId,
      actorEntry,
      targetId: actorId,
      targetName: actorId,
      severity: "critical",
      payload: {
        eventCount,
        windowSeconds: protection.bulkActionGuard.windowSeconds,
        recentEvents: recentEvents.map((item) => ({
          featureKey: item.feature_key,
          eventType: item.event_type,
          createdAt: item.created_at
        }))
      },
      externalGuardId: `bulk-action-guard:${actorId}:${Math.floor(Date.now() / 60_000)}`,
      actionTaken: quarantineApplied
    });
  }

  private async recordGuardEvent(
    options: GuardFeatureOptions & {
      actionTaken: string;
    }
  ) {
    await this.sql`
      INSERT INTO guard_events (
        guild_id,
        feature_key,
        event_type,
        actor_id,
        actor_name,
        actor_avatar_url,
        target_id,
        target_name,
        severity,
        action_taken,
        payload,
        external_guard_id,
        created_at
      )
      VALUES (
        ${options.guild.id},
        ${options.featureKey},
        ${options.eventType},
        ${options.actorId},
        ${options.actorEntry?.username ?? options.actorId},
        ${options.actorEntry?.displayAvatarURL() ?? null},
        ${options.targetId},
        ${options.targetName},
        ${options.severity},
        ${options.actionTaken},
        ${JSON.stringify(options.payload ?? {})}::jsonb,
        ${options.externalGuardId ?? null},
        ${options.occurredAt ?? new Date()}
      )
      ON CONFLICT (external_guard_id) DO NOTHING
    `;
  }

  private async applyQuarantine(
    guild: Guild,
    actorId: string,
    featureKey: GuardFeatureKey,
    eventType: string,
    cachedMember?: GuildMember | null
  ) {
    const protection = this.getConfig().ultraProtection;
    const quarantineRoleId = protection.quarantineRoleId;
    if (!quarantineRoleId) {
      return "karantina-rolu-yok";
    }

    // PARALLEL FETCH: member + role in one round-trip when not cached.
    // The role is also typically already in cache after bot warmup.
    const [member, quarantineRole] = await Promise.all([
      cachedMember ??
        guild.members.cache.get(actorId) ??
        guild.members.fetch(actorId).catch(() => null),
      guild.roles.cache.get(quarantineRoleId) ??
        guild.roles.fetch(quarantineRoleId).catch(() => null)
    ]);

    if (!member) {
      return "uye-bulunamadi";
    }

    if (member.id === guild.ownerId) {
      return "kurucu-muaf";
    }

    if (member.roles.cache.has(quarantineRoleId)) {
      return "karantina-zaten-aktif";
    }

    if (!quarantineRole) {
      return "karantina-rolu-bulunamadi";
    }

    if (!member.manageable) {
      return "uye-yonetilemiyor";
    }

    // PARALLEL ACTION: role assignment runs in parallel with the DM embed
    // delivery, since the DM does not depend on the role being applied.
    const embed = this.buildGuardActionEmbed(guild, "quarantine", featureKey, eventType, {
      appealNote:
        "Karantina rolünüz, sunucu güvenliği için otomatik olarak verildi. " +
        "Yanlış olduğunu düşünüyorsanız sunucu yetkilileri ile iletişime geçin."
    });

    try {
      const [, dmDelivered] = await Promise.all([
        member.roles.add(
          quarantineRole,
          `Ultra Koruma: ${featureKey} / ${eventType} tetiklendi`
        ),
        this.sendActionDm(member, embed)
      ]);
      // Sync after the role apply succeeds; this is non-blocking for caller.
      void this.memberService.syncMember(member).catch(() => {
        /* swallow */
      });
      return dmDelivered ? "karantinaya-alindi+dm" : "karantinaya-alindi";
    } catch (error) {
      this.logger.warn({ error, actorId, featureKey, eventType }, "Guard quarantine failed.");
      return "karantina-basarisiz";
    }
  }

  /**
   * Single-pass actor classification: fetches the member exactly ONCE and
   * evaluates both whitelist (exempt) and blacklist membership in one go.
   * Returns the cached member so callers (e.g. executeActionTier) can reuse
   * it without another fetch round-trip.
   */
  private async classifyActor(
    guild: Guild,
    actorId: string,
    featureKey?: GuardFeatureKey
  ): Promise<{
    isBlacklisted: boolean;
    isExempt: boolean;
    member: GuildMember | null;
  }> {
    const protection = this.getConfig().ultraProtection;

    // ID-only fast paths first — no API call required.
    const blacklistByUserId = protection.blacklist.userIds.includes(actorId);
    const whitelistByUserId = protection.whitelist.userIds.includes(actorId);
    const isOwner = actorId === guild.ownerId;

    // If we can decide entirely from IDs, skip the member fetch.
    const needsRoleCheck =
      !blacklistByUserId &&
      protection.blacklist.roleIds.length + protection.whitelist.roleIds.length > 0;
    const perFeatureRoles = featureKey
      ? this.getFeatureAdvanced(featureKey).whitelistRoleIds
      : [];
    const needsFeatureRoleCheck = perFeatureRoles.length > 0;

    let member: GuildMember | null = null;
    if (needsRoleCheck || needsFeatureRoleCheck) {
      member =
        guild.members.cache.get(actorId) ??
        (await guild.members.fetch(actorId).catch(() => null));
    }

    const isBlacklisted =
      blacklistByUserId ||
      (member !== null &&
        protection.blacklist.roleIds.some((roleId) => member!.roles.cache.has(roleId)));

    // Blacklist outranks any whitelist — attackers can't whitelist their way out.
    let isExempt = false;
    if (!isBlacklisted) {
      isExempt =
        isOwner ||
        whitelistByUserId ||
        (member !== null &&
          (protection.whitelist.roleIds.some((roleId) => member!.roles.cache.has(roleId)) ||
            perFeatureRoles.some((roleId) => member!.roles.cache.has(roleId))));
    }

    return { isBlacklisted, isExempt, member };
  }

  /**
   * Build a rich DM embed describing the guard action taken against a member.
   * Used by warn/timeout/kick/ban/quarantine flows so the affected user gets a
   * clear, branded explanation instead of a one-line plain-text message.
   */
  private buildGuardActionEmbed(
    guild: Guild,
    action: "warn" | "timeout" | "kick" | "ban" | "quarantine",
    featureKey: GuardFeatureKey,
    eventType: string,
    extra?: { durationLabel?: string; appealNote?: string }
  ): EmbedBuilder {
    const palette: Record<typeof action, { color: ColorResolvable; emoji: string; title: string }> = {
      warn: { color: 0xf5b800, emoji: "⚠️", title: "Ultra Koruma — Uyarı" },
      timeout: { color: 0xff8c1a, emoji: "⏳", title: "Ultra Koruma — Zaman Aşımı (Timeout)" },
      kick: { color: 0xff4d4d, emoji: "🚪", title: "Ultra Koruma — Sunucudan Atıldınız" },
      ban: { color: 0xc40000, emoji: "🔨", title: "Ultra Koruma — Yasaklandınız" },
      quarantine: { color: 0xffa600, emoji: "🛡️", title: "Ultra Koruma — Karantinaya Alındınız" }
    };
    const { color, emoji, title } = palette[action];

    const featureLabel = this.featureLabel(featureKey);
    const eventLabel = this.eventTypeLabel(eventType);
    const guildIcon = guild.iconURL({ size: 256 }) ?? undefined;

    const embed = new EmbedBuilder()
      .setColor(color)
      .setAuthor({ name: guild.name, iconURL: guildIcon })
      .setTitle(`${emoji} ${title}`)
      .setDescription(
        `**${guild.name}** sunucusunda otomatik koruma sistemi tarafından ` +
          `aşağıdaki nedenle hakkınızda işlem yapıldı.`
      )
      .addFields(
        { name: "🛡️ Tetiklenen Modül", value: `\`${featureLabel}\``, inline: true },
        { name: "📌 Olay Tipi", value: `\`${eventLabel}\``, inline: true },
        {
          name: "⚡ Uygulanan İşlem",
          value: this.actionLabel(action),
          inline: true
        }
      )
      .setTimestamp(new Date())
      .setFooter({
        text: `${guild.name} · Ultra Koruma`,
        iconURL: guildIcon
      });

    if (extra?.durationLabel) {
      embed.addFields({ name: "⌛ Süre", value: extra.durationLabel, inline: true });
    }

    embed.addFields({
      name: "ℹ️ Bu işlem hatalı mı?",
      value:
        extra?.appealNote ??
        "Bu eylem otomatik koruma sistemi tarafından uygulandı. " +
          "Yanlışlıkla tetiklendiğini düşünüyorsanız sunucu yetkilileri ile iletişime geçin."
    });

    return embed;
  }

  private featureLabel(featureKey: GuardFeatureKey): string {
    switch (featureKey) {
      case "channel-guard":
        return "Kanal Koruma";
      case "category-guard":
        return "Kategori Koruma";
      case "webhook-guard":
        return "Webhook Koruma";
      case "bot-guard":
        return "Bot Koruma";
      case "guild-settings-guard":
        return "Sunucu Ayar Koruma";
      case "manual-action-guard":
        return "Manuel İşlem Koruma";
      case "bulk-action-guard":
        return "Toplu İşlem Koruma";
      case "role-guard":
        return "Rol Koruma";
      case "anti-raid-guard":
        return "Anti-Raid Koruma";
      case "invite-link-guard":
        return "Davet/Link Koruma";
      case "message-nuke-guard":
        return "Mesaj Patlatma Koruma";
      case "settings-rollback-guard":
        return "Ayar Geri Yükleme";
      default:
        return featureKey;
    }
  }

  private eventTypeLabel(eventType: string): string {
    switch (eventType) {
      case "create":
        return "Oluşturma";
      case "delete":
        return "Silme";
      case "update":
        return "Güncelleme";
      case "bot-add":
        return "Bot Ekleme";
      case "burst":
        return "Toplu Saldırı";
      case "bulk-delete":
        return "Toplu Mesaj Silme";
      case "bulk-message-delete":
        return "Toplu Mesaj Silme";
      case "raid-young-join":
        return "Genç Hesap Akını";
      case "ban":
        return "Manuel Ban";
      case "kick":
        return "Manuel Kick";
      case "timeout":
        return "Manuel Timeout";
      default:
        return eventType;
    }
  }

  private actionLabel(action: "warn" | "timeout" | "kick" | "ban" | "quarantine"): string {
    switch (action) {
      case "warn":
        return "Uyarı (DM)";
      case "timeout":
        return "Geçici Susturma (Timeout)";
      case "kick":
        return "Sunucudan Çıkarılma";
      case "ban":
        return "Kalıcı Yasak";
      case "quarantine":
        return "Karantina Rolü Atandı";
    }
  }

  /**
   * Best-effort DM send: never throws. Used for guard action notifications
   * (warn/quarantine/timeout/kick/ban). Failures are logged at debug level
   * because most users with closed DMs will trigger them and we don't want
   * to spam warnings.
   */
  private async sendActionDm(member: GuildMember, embed: EmbedBuilder): Promise<boolean> {
    try {
      await member.send({ embeds: [embed] });
      return true;
    } catch (error) {
      this.logger.debug(
        { err: error, userId: member.id },
        "Guard action DM could not be delivered."
      );
      return false;
    }
  }

  private async findAuditEntry(
    guild: Guild,
    type: AuditLogEvent,
    targetId: string,
    maxAgeMs: number
  ): Promise<GuildAuditLogsEntry | null> {
    try {
      const audit = await guild.fetchAuditLogs({
        type,
        limit: 8
      });

      for (const [, entry] of audit.entries) {
        const entryTargetId =
          entry.target && "id" in entry.target ? String(entry.target.id) : null;
        if (entryTargetId !== targetId) {
          continue;
        }

        const createdAt = entry.createdAt ?? new Date();
        if (Date.now() - createdAt.getTime() > maxAgeMs) {
          continue;
        }

        return entry;
      }
    } catch (error) {
      this.logger.warn({ error, guildId: guild.id, type, targetId }, "Guard audit lookup failed.");
    }

    return null;
  }

  private isFeatureEnabled(featureKey: GuardFeatureKey) {
    return this.getFeatureConfig(featureKey).enabled;
  }

  private isGuardAutomationActive() {
    const protection = this.getConfig().ultraProtection;
    if (!protection.enabled) {
      return false;
    }

    if (!protection.schedule.enabled) {
      return true;
    }

    const currentHour = this.getLocalHour();
    const { startHour, endHour } = protection.schedule;
    if (startHour === endHour) {
      return true;
    }
    if (startHour < endHour) {
      return currentHour >= startHour && currentHour < endHour;
    }
    return currentHour >= startHour || currentHour < endHour;
  }

  private getLocalHour() {
    const formatted = new Intl.DateTimeFormat("tr-TR", {
      timeZone: this.timezone,
      hour: "2-digit",
      hour12: false
    }).format(new Date());
    return Number.parseInt(formatted, 10) || 0;
  }

  private getFeatureConfig(featureKey: GuardFeatureKey): GuardFeatureConfig {
    const protection = this.getConfig().ultraProtection;
    switch (featureKey) {
      case "channel-guard":
        return protection.channelGuard;
      case "category-guard":
        return protection.categoryGuard;
      case "webhook-guard":
        return protection.webhookGuard;
      case "bot-guard":
        return protection.botGuard;
      case "guild-settings-guard":
        return protection.guildSettingsGuard;
      case "bulk-action-guard":
        return protection.bulkActionGuard;
      case "manual-action-guard":
        return protection.manualActionGuard;
      case "role-guard":
        return protection.roleGuard;
      case "anti-raid-guard":
        return protection.antiRaidGuard;
      case "invite-link-guard":
        return protection.inviteLinkGuard;
      case "message-nuke-guard":
        return protection.messageNukeGuard;
      case "settings-rollback-guard":
        // Rollback guard has no GuardFeatureConfig shape — return a stub to keep
        // the type contract; automation code never looks it up through this path.
        return {
          enabled: protection.settingsRollbackGuard.enabled,
          quarantine: false,
          logOnly: false,
          severityOverride: "inherit",
          auditWindowSeconds: DEFAULT_AUDIT_WINDOW_SECONDS,
          whitelistRoleIds: [],
          cooldownSeconds: protection.settingsRollbackGuard.cooldownSeconds,
          actionTier: "log"
        };
    }
  }

  private getFeatureAdvanced(featureKey: GuardFeatureKey): GuardAdvancedConfig {
    const config = this.getFeatureConfig(featureKey);
    return {
      logOnly: Boolean(config.logOnly),
      severityOverride: config.severityOverride ?? "inherit",
      auditWindowSeconds:
        typeof config.auditWindowSeconds === "number" && config.auditWindowSeconds > 0
          ? config.auditWindowSeconds
          : DEFAULT_AUDIT_WINDOW_SECONDS,
      whitelistRoleIds: Array.isArray(config.whitelistRoleIds)
        ? config.whitelistRoleIds
        : [],
      cooldownSeconds:
        typeof config.cooldownSeconds === "number" && config.cooldownSeconds >= 0
          ? config.cooldownSeconds
          : 0,
      actionTier: config.actionTier ?? "quarantine"
    };
  }

  private getFeatureAuditWindowMs(featureKey: GuardFeatureKey) {
    return this.getFeatureAdvanced(featureKey).auditWindowSeconds * 1000;
  }

  private rememberProcessedEntry(entryId: string | null | undefined) {
    if (!entryId) {
      return;
    }
    const now = Date.now();
    // Purge stale entries opportunistically
    if (this.processedEntryIds.size > 1024) {
      for (const [key, ts] of this.processedEntryIds) {
        if (now - ts > PROCESSED_ENTRY_TTL_MS) {
          this.processedEntryIds.delete(key);
        }
      }
    }
    this.processedEntryIds.set(entryId, now);
  }

  private hasProcessedEntry(entryId: string | null | undefined) {
    if (!entryId) {
      return false;
    }
    const ts = this.processedEntryIds.get(entryId);
    if (ts === undefined) {
      return false;
    }
    if (Date.now() - ts > PROCESSED_ENTRY_TTL_MS) {
      this.processedEntryIds.delete(entryId);
      return false;
    }
    return true;
  }

  private isRelevantChannel(channel: NonThreadGuildBasedChannel) {
    return Boolean(channel.guild);
  }

  private isCategoryChannel(channel: NonThreadGuildBasedChannel) {
    return channel.type === ChannelType.GuildCategory;
  }

  private buildChannelDiff(
    oldChannel: NonThreadGuildBasedChannel,
    newChannel: NonThreadGuildBasedChannel
  ) {
    const oldSnapshot = this.createChannelSnapshot(oldChannel);
    const newSnapshot = this.createChannelSnapshot(newChannel);
    const changes: Array<Record<string, unknown>> = [];
    this.pushDiffChange(changes, "name", "Ad", oldSnapshot.name, newSnapshot.name);
    this.pushDiffChange(changes, "parentName", "Kategori", oldSnapshot.parentName, newSnapshot.parentName);
    this.pushDiffChange(changes, "position", "Konum", oldSnapshot.position, newSnapshot.position);
    this.pushDiffChange(changes, "topic", "Konu", oldSnapshot.topic, newSnapshot.topic);
    this.pushDiffChange(changes, "nsfw", "NSFW", oldSnapshot.nsfw, newSnapshot.nsfw);
    this.pushDiffChange(
      changes,
      "rateLimitPerUser",
      "Yavaş Mod",
      oldSnapshot.rateLimitPerUser,
      newSnapshot.rateLimitPerUser
    );
    this.pushDiffChange(changes, "bitrate", "Bit Hızı", oldSnapshot.bitrate, newSnapshot.bitrate);
    this.pushDiffChange(changes, "userLimit", "Kullanıcı Sınırı", oldSnapshot.userLimit, newSnapshot.userLimit);
    this.pushDiffChange(
      changes,
      "permissionOverwrites",
      "İzin Üzerine Yazmaları",
      Array.isArray(oldSnapshot.permissionOverwrites) ? oldSnapshot.permissionOverwrites.length : 0,
      Array.isArray(newSnapshot.permissionOverwrites) ? newSnapshot.permissionOverwrites.length : 0
    );
    return changes;
  }

  private buildGuildDiff(oldGuild: Guild, newGuild: Guild) {
    const oldSnapshot = this.createGuildSnapshot(oldGuild);
    const newSnapshot = this.createGuildSnapshot(newGuild);
    const changes: Array<Record<string, unknown>> = [];
    this.pushDiffChange(changes, "name", "Sunucu Adı", oldSnapshot.name, newSnapshot.name);
    this.pushDiffChange(changes, "iconUrl", "İkon", oldSnapshot.iconUrl, newSnapshot.iconUrl);
    this.pushDiffChange(changes, "bannerUrl", "Banner", oldSnapshot.bannerUrl, newSnapshot.bannerUrl);
    this.pushDiffChange(
      changes,
      "verificationLevel",
      "Doğrulama Seviyesi",
      oldSnapshot.verificationLevel,
      newSnapshot.verificationLevel
    );
    this.pushDiffChange(
      changes,
      "explicitContentFilter",
      "İçerik Filtresi",
      oldSnapshot.explicitContentFilter,
      newSnapshot.explicitContentFilter
    );
    this.pushDiffChange(
      changes,
      "defaultMessageNotifications",
      "Varsayılan Bildirim",
      oldSnapshot.defaultMessageNotifications,
      newSnapshot.defaultMessageNotifications
    );
    this.pushDiffChange(
      changes,
      "systemChannelId",
      "Sistem Kanalı",
      oldSnapshot.systemChannelId,
      newSnapshot.systemChannelId
    );
    this.pushDiffChange(
      changes,
      "rulesChannelId",
      "Kurallar Kanalı",
      oldSnapshot.rulesChannelId,
      newSnapshot.rulesChannelId
    );
    this.pushDiffChange(
      changes,
      "publicUpdatesChannelId",
      "Duyuru Kanalı",
      oldSnapshot.publicUpdatesChannelId,
      newSnapshot.publicUpdatesChannelId
    );
    return changes;
  }

  private isTimeoutEntry(entry: GuildAuditLogsEntry) {
    return entry.changes.some((change) => {
      if (change.key !== "communication_disabled_until") {
        return false;
      }

      return Boolean(change.new);
    });
  }

  private pushDiffChange(
    changes: Array<Record<string, unknown>>,
    field: string,
    label: string,
    oldValue: unknown,
    newValue: unknown
  ) {
    if (JSON.stringify(oldValue) === JSON.stringify(newValue)) {
      return;
    }

    changes.push({
      field,
      label,
      oldValue,
      newValue
    });
  }

  private createChannelSnapshot(channel: NonThreadGuildBasedChannel) {
    return {
      id: channel.id,
      name: channel.name,
      type: this.channelTypeLabel(channel.type),
      rawType: channel.type,
      parentId: channel.parentId,
      parentName: channel.parent?.name ?? null,
      position: channel.position,
      topic: "topic" in channel ? channel.topic ?? null : null,
      nsfw: "nsfw" in channel ? Boolean(channel.nsfw) : null,
      rateLimitPerUser: "rateLimitPerUser" in channel ? channel.rateLimitPerUser : null,
      bitrate: "bitrate" in channel ? channel.bitrate : null,
      userLimit: "userLimit" in channel ? channel.userLimit : null,
      rtcRegion: "rtcRegion" in channel ? channel.rtcRegion ?? null : null,
      videoQualityMode:
        "videoQualityMode" in channel && channel.videoQualityMode != null
          ? String(channel.videoQualityMode)
          : null,
      permissionsLocked:
        "permissionsLocked" in channel ? channel.permissionsLocked ?? null : null,
      permissionOverwrites: [...channel.permissionOverwrites.cache.values()].map((overwrite) => ({
        id: overwrite.id,
        type: overwrite.type,
        allow: overwrite.allow.toArray().sort(),
        deny: overwrite.deny.toArray().sort()
      }))
    };
  }

  private createGuildSnapshot(guild: Guild) {
    return {
      id: guild.id,
      name: guild.name,
      iconUrl: guild.iconURL(),
      bannerUrl: guild.bannerURL(),
      verificationLevel: String(guild.verificationLevel),
      defaultMessageNotifications: String(guild.defaultMessageNotifications),
      explicitContentFilter: String(guild.explicitContentFilter),
      afkChannelId: guild.afkChannelId,
      systemChannelId: guild.systemChannelId,
      rulesChannelId: guild.rulesChannelId,
      publicUpdatesChannelId: guild.publicUpdatesChannelId
    };
  }

  private createMemberSnapshot(member: GuildMember) {
    return {
      id: member.id,
      username: member.user.username,
      displayName: member.displayName,
      avatarUrl: member.displayAvatarURL(),
      createdAt: member.user.createdAt.toISOString(),
      joinedAt: member.joinedAt?.toISOString() ?? null,
      roleIds: member.roles.cache
        .filter((role) => role.id !== member.guild.id)
        .map((role) => role.id)
    };
  }

  private createWebhookSnapshot(webhook: Webhook | null) {
    if (!webhook) {
      return null;
    }

    return {
      id: webhook.id,
      name: webhook.name,
      channelId: webhook.channelId,
      type: String(webhook.type),
      avatarUrl: webhook.avatarURL(),
      applicationId: webhook.applicationId,
      ownerId: webhook.owner?.id ?? null
    };
  }

  private createWebhookSnapshotFromAuditEntry(
    entry: GuildAuditLogsEntry,
    targetId: string | null,
    targetName: string | null
  ) {
    const target = entry.target;
    return {
      id: targetId,
      name: targetName,
      channelId:
        target && typeof target === "object" && "channelId" in target ? String(target.channelId) : null,
      type: "audit-log",
      changes: this.serializeAuditChanges(entry)
    };
  }

  private createAuditTargetSnapshot(
    entry: GuildAuditLogsEntry,
    targetId: string | null,
    fallbackName: string | null
  ) {
    const target = entry.target;
    const username =
      target && typeof target === "object" && "username" in target ? String(target.username) : null;
    return {
      id: targetId,
      name:
        username ??
        (target && typeof target === "object" && "name" in target ? String(target.name) : null) ??
        fallbackName,
      type:
        target && typeof target === "object" && "constructor" in target
          ? String(target.constructor?.name ?? "AuditTarget")
          : "AuditTarget",
      changes: this.serializeAuditChanges(entry)
    };
  }

  private serializeAuditChanges(entry: GuildAuditLogsEntry) {
    return entry.changes.map((change) => ({
      field: String(change.key),
      oldValue: this.normalizeAuditValue(change.old),
      newValue: this.normalizeAuditValue(change.new)
    }));
  }

  private normalizeAuditValue(value: unknown): unknown {
    if (value instanceof Date) {
      return value.toISOString();
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.normalizeAuditValue(item));
    }

    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, nestedValue]) => [
          key,
          this.normalizeAuditValue(nestedValue)
        ])
      );
    }

    return value;
  }

  private channelTypeLabel(channelType: ChannelType) {
    switch (channelType) {
      case ChannelType.GuildCategory:
        return "Kategori";
      case ChannelType.GuildText:
        return "Metin";
      case ChannelType.GuildAnnouncement:
        return "Duyuru";
      case ChannelType.GuildForum:
        return "Forum";
      case ChannelType.GuildMedia:
        return "Medya";
      case ChannelType.GuildVoice:
        return "Ses";
      case ChannelType.GuildStageVoice:
        return "Sahne";
      default:
        return "Kanal";
    }
  }
}
