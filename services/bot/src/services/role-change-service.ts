import {
  AuditLogEvent,
  type Guild,
  type GuildMember,
  type GuildAuditLogsEntry,
  type Role
} from "discord.js";
import type { Logger } from "pino";
import type { Sql } from "postgres";

import type { MemberService } from "./member-service";

type RoleAuditType =
  | AuditLogEvent.RoleCreate
  | AuditLogEvent.RoleDelete
  | AuditLogEvent.RoleUpdate;

type RoleEventAction = "create" | "update" | "delete" | "assign" | "unassign";

interface RoleSnapshot {
  name: string;
  colorHex: string | null;
  position: number;
  mentionable: boolean;
  managed: boolean;
  hoist: boolean;
  permissions: string[];
}

export class RoleChangeService {
  constructor(
    private readonly sql: Sql,
    private readonly logger: Logger,
    private readonly memberService: MemberService
  ) {}

  async handleRoleCreate(role: Role) {
    await this.recordRoleEvent(role, "create", { snapshot: this.createRoleSnapshot(role) });
  }

  async handleRoleDelete(role: Role) {
    await this.recordRoleEvent(role, "delete", { snapshot: this.createRoleSnapshot(role) });
  }

  async handleRoleUpdate(oldRole: Role, newRole: Role) {
    const changes = this.createRoleDiff(oldRole, newRole);
    if (!changes.length) {
      return;
    }

    await this.recordRoleEvent(newRole, "update", {
      changes,
      beforeSnapshot: this.createRoleSnapshot(oldRole),
      afterSnapshot: this.createRoleSnapshot(newRole)
    });
  }

  async handleMemberRoleUpdate(oldMember: GuildMember, newMember: GuildMember) {
    const oldRoles = oldMember.roles.cache.filter((role) => role.id !== oldMember.guild.id);
    const newRoles = newMember.roles.cache.filter((role) => role.id !== newMember.guild.id);

    const addedRoles = [...newRoles.values()].filter((role) => !oldRoles.has(role.id));
    const removedRoles = [...oldRoles.values()].filter((role) => !newRoles.has(role.id));
    if (!addedRoles.length && !removedRoles.length) {
      return;
    }

    const changedRoleIds = [...addedRoles, ...removedRoles].map((role) => role.id);
    const auditEntry = await this.findMemberRoleAuditEntry(newMember.guild, newMember.id, changedRoleIds);

    for (const role of addedRoles) {
      await this.recordMemberRoleEvent(role, "assign", newMember, auditEntry);
    }

    for (const role of removedRoles) {
      await this.recordMemberRoleEvent(role, "unassign", newMember, auditEntry);
    }
  }

  private async recordRoleEvent(
    role: Role,
    actionType: "create" | "update" | "delete",
    changePayload: Record<string, unknown>
  ) {
    const auditType = this.resolveAuditType(actionType);
    const auditEntry = await this.findAuditEntry(role.guild, auditType, role.id);
    await this.insertRoleEvent({
      guildId: role.guild.id,
      roleId: role.id,
      roleName: role.name,
      actionType,
      changePayload,
      auditEntry
    });
  }

  private async recordMemberRoleEvent(
    role: Role,
    actionType: "assign" | "unassign",
    member: GuildMember,
    auditEntry: GuildAuditLogsEntry<AuditLogEvent.MemberRoleUpdate> | null
  ) {
    await this.insertRoleEvent({
      guildId: member.guild.id,
      roleId: role.id,
      roleName: role.name,
      actionType,
      changePayload: {
        targetMember: {
          id: member.id,
          username: member.user.username,
          displayName: member.displayName
        },
        roleSnapshot: this.createRoleSnapshot(role)
      },
      auditEntry,
      externalChangeId: auditEntry ? `${auditEntry.id}:${actionType}:${role.id}` : null
    });
  }

  private async insertRoleEvent(input: {
    guildId: string;
    roleId: string;
    roleName: string;
    actionType: RoleEventAction;
    changePayload: Record<string, unknown>;
    auditEntry: GuildAuditLogsEntry | null;
    externalChangeId?: string | null;
  }) {
    const { guildId, roleId, roleName, actionType, changePayload, auditEntry } = input;
    const createdAt = auditEntry?.createdAt ?? new Date();
    const actorId = auditEntry?.executorId ? String(auditEntry.executorId) : null;
    const actor = auditEntry?.executor ?? null;

    if (actorId && actor) {
      await this.memberService.syncUserShell(guildId, actor, "user");
    }

    await this.sql`
      INSERT INTO role_change_events (
        guild_id,
        role_id,
        role_name,
        action_type,
        actor_id,
        actor_name,
        actor_avatar_url,
        reason,
        change_payload,
        external_change_id,
        created_at
      )
      VALUES (
        ${guildId},
        ${roleId},
        ${roleName},
        ${actionType},
        ${actorId},
        ${actor?.username ?? null},
        ${actor?.displayAvatarURL() ?? null},
        ${auditEntry?.reason ?? null},
        CAST(${JSON.stringify(changePayload)} AS jsonb),
        ${input.externalChangeId ?? auditEntry?.id ?? null},
        ${createdAt}
      )
      ON CONFLICT (external_change_id) DO NOTHING
    `;
  }

  private resolveAuditType(actionType: "create" | "update" | "delete"): RoleAuditType {
    if (actionType === "create") {
      return AuditLogEvent.RoleCreate;
    }

    if (actionType === "delete") {
      return AuditLogEvent.RoleDelete;
    }

    return AuditLogEvent.RoleUpdate;
  }

  private async findAuditEntry(
    guild: Guild,
    auditType: RoleAuditType,
    roleId: string
  ): Promise<GuildAuditLogsEntry | null> {
    try {
      const audit = await guild.fetchAuditLogs({
        type: auditType,
        limit: 6
      });

      for (const [, entry] of audit.entries) {
        const targetId =
          entry.target && "id" in entry.target ? String(entry.target.id) : null;

        if (targetId !== roleId) {
          continue;
        }

        const createdAt = entry.createdAt ?? new Date();
        if (Date.now() - createdAt.getTime() > 60_000) {
          continue;
        }

        return entry;
      }
    } catch (error) {
      this.logger.warn(
        { error, guildId: guild.id, roleId, auditType },
        "Role audit lookup failed."
      );
    }

    return null;
  }

  private async findMemberRoleAuditEntry(
    guild: Guild,
    memberId: string,
    roleIds: string[]
  ): Promise<GuildAuditLogsEntry<AuditLogEvent.MemberRoleUpdate> | null> {
    try {
      const audit = await guild.fetchAuditLogs({
        type: AuditLogEvent.MemberRoleUpdate,
        limit: 10
      });

      for (const [, entry] of audit.entries) {
        if (String(entry.targetId) !== memberId) {
          continue;
        }

        const createdAt = entry.createdAt ?? new Date();
        if (Date.now() - createdAt.getTime() > 120_000) {
          continue;
        }

        if (!roleIds.some((roleId) => this.auditEntryTouchesRole(entry, roleId))) {
          continue;
        }

        return entry;
      }
    } catch (error) {
      this.logger.warn(
        { error, guildId: guild.id, memberId, roleIds },
        "Member role audit lookup failed."
      );
    }

    return null;
  }

  private auditEntryTouchesRole(entry: GuildAuditLogsEntry, roleId: string) {
    return entry.changes.some((change) => {
      if (change.key !== "$add" && change.key !== "$remove") {
        return false;
      }

      const values = [change.new, change.old]
        .filter((value) => Array.isArray(value))
        .flatMap((value) => value);

      return values.some(
        (value) =>
          Boolean(value) &&
          typeof value === "object" &&
          "id" in value &&
          String(value.id) === roleId
      );
    });
  }

  private createRoleSnapshot(role: Role): RoleSnapshot {
    return {
      name: role.name,
      colorHex: this.getRoleColorHex(role),
      position: role.position,
      mentionable: role.mentionable,
      managed: role.managed,
      hoist: role.hoist,
      permissions:
        role.permissions && typeof role.permissions.toArray === "function"
          ? role.permissions.toArray().sort()
          : []
    };
  }

  private createRoleDiff(oldRole: Role, newRole: Role) {
    const changes: Array<Record<string, unknown>> = [];

    if (oldRole.name !== newRole.name) {
      changes.push({
        field: "name",
        oldValue: oldRole.name,
        newValue: newRole.name
      });
    }

    if (this.getRoleColorHex(oldRole) !== this.getRoleColorHex(newRole)) {
      changes.push({
        field: "color",
        oldValue: this.getRoleColorHex(oldRole),
        newValue: this.getRoleColorHex(newRole)
      });
    }

    if (oldRole.position !== newRole.position) {
      changes.push({
        field: "position",
        oldValue: oldRole.position,
        newValue: newRole.position
      });
    }

    if (oldRole.mentionable !== newRole.mentionable) {
      changes.push({
        field: "mentionable",
        oldValue: oldRole.mentionable,
        newValue: newRole.mentionable
      });
    }

    if (oldRole.managed !== newRole.managed) {
      changes.push({
        field: "managed",
        oldValue: oldRole.managed,
        newValue: newRole.managed
      });
    }

    if (oldRole.hoist !== newRole.hoist) {
      changes.push({
        field: "hoist",
        oldValue: oldRole.hoist,
        newValue: newRole.hoist
      });
    }

    const oldPermissions = new Set(oldRole.permissions.toArray());
    const newPermissions = new Set(newRole.permissions.toArray());
    const addedPermissions = [...newPermissions].filter((item) => !oldPermissions.has(item)).sort();
    const removedPermissions = [...oldPermissions].filter((item) => !newPermissions.has(item)).sort();

    if (addedPermissions.length || removedPermissions.length) {
      changes.push({
        field: "permissions",
        addedPermissions,
        removedPermissions
      });
    }

    return changes;
  }

  private getRoleColorHex(role: Role) {
    return role.color ? `#${role.color.toString(16).padStart(6, "0")}` : null;
  }
}
