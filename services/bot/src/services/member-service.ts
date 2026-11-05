import { ChannelType, type Guild, type GuildMember } from "discord.js";
import type { Logger } from "pino";
import type { Sql } from "postgres";

import type { SupervisorConfig } from "../../../../packages/shared/src";

export class MemberService {
  constructor(
    private readonly sql: Sql,
    private readonly logger: Logger,
    private readonly getConfig: () => SupervisorConfig
  ) {}

  isStaff(member: GuildMember) {
    const config = this.getConfig();
    return this.hasAnyRole(member, config.roles.staffRoleIds) || this.isUpperStaff(member);
  }

  isUpperStaff(member: GuildMember) {
    const config = this.getConfig();
    return (
      this.hasAnyRole(member, config.roles.upperStaffRoleIds) ||
      this.hasAnyRole(member, config.roles.supervisorRoleIds) ||
      member.permissions.has("Administrator")
    );
  }

  canManageConfig(member: GuildMember) {
    return this.isUpperStaff(member) || member.permissions.has("ManageGuild");
  }

  canBan(member: GuildMember) {
    const config = this.getConfig();
    return (
      this.hasAnyRole(member, config.roles.banRoleIds) ||
      this.isUpperStaff(member) ||
      member.permissions.has("BanMembers")
    );
  }

  canKick(member: GuildMember) {
    const config = this.getConfig();
    return (
      this.hasAnyRole(member, config.roles.kickRoleIds) ||
      this.isUpperStaff(member) ||
      member.permissions.has("KickMembers")
    );
  }

  canUnban(member: GuildMember) {
    const config = this.getConfig();
    return (
      this.hasAnyRole(member, config.roles.unbanRoleIds) ||
      this.hasAnyRole(member, config.roles.banRoleIds) ||
      this.isUpperStaff(member) ||
      member.permissions.has("BanMembers")
    );
  }

  canTimeout(member: GuildMember) {
    const config = this.getConfig();
    return (
      this.hasAnyRole(member, config.roles.timeoutRoleIds) ||
      this.isUpperStaff(member) ||
      member.permissions.has("ModerateMembers")
    );
  }

  canWarn(member: GuildMember) {
    const config = this.getConfig();
    return (
      this.hasAnyRole(member, config.roles.warnRoleIds) ||
      this.isUpperStaff(member) ||
      member.permissions.has("ModerateMembers")
    );
  }

  canJail(member: GuildMember) {
    const config = this.getConfig();
    return (
      this.hasAnyRole(member, config.roles.jailRoleIds) ||
      this.isUpperStaff(member) ||
      member.permissions.has("ManageRoles")
    );
  }

  canModerateMessages(member: GuildMember) {
    const config = this.getConfig();
    return (
      this.hasAnyRole(member, config.roles.messageModerationRoleIds) ||
      this.isUpperStaff(member) ||
      member.permissions.has("ManageMessages")
    );
  }

  canModerateChannels(member: GuildMember) {
    const config = this.getConfig();
    return (
      this.hasAnyRole(member, config.roles.channelModerationRoleIds) ||
      this.isUpperStaff(member) ||
      member.permissions.has("ManageChannels")
    );
  }

  canViewHistory(member: GuildMember) {
    const config = this.getConfig();
    return (
      this.hasAnyRole(member, config.roles.historyRoleIds) ||
      this.isStaff(member) ||
      this.isUpperStaff(member)
    );
  }

  getMemberType(member: GuildMember): "staff" | "user" {
    return this.isStaff(member) ? "staff" : "user";
  }

  hasAnyRole(member: GuildMember, roleIds: string[]) {
    return roleIds.some((roleId) => member.roles.cache.has(roleId));
  }

  async syncMember(member: GuildMember) {
    const memberType = this.getMemberType(member);

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
        ${member.guild.id},
        ${member.id},
        ${member.user.username},
        ${member.displayName},
        ${member.displayAvatarURL()},
        ${memberType},
        NOW(),
        NOW()
      )
      ON CONFLICT (guild_id, user_id)
      DO UPDATE SET
        username = EXCLUDED.username,
        display_name = EXCLUDED.display_name,
        avatar_url = EXCLUDED.avatar_url,
        member_type = EXCLUDED.member_type,
        last_seen_at = NOW()
    `;
  }

  async syncUserShell(
    guildId: string,
    user: {
      id: string;
      username?: string | null;
      displayAvatarURL: () => string;
    },
    memberType: "staff" | "user" = "user"
  ) {
    const username = user.username ?? "unknown-user";

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
        ${guildId},
        ${user.id},
        ${username},
        ${username},
        ${user.displayAvatarURL()},
        ${memberType},
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

  async syncRoleCatalog(guild: Guild) {
    const config = this.getConfig();
    const roles = await guild.roles.fetch();
    const availableRoles = roles.filter((role) => role.id !== guild.id);

    await this.sql`DELETE FROM guild_roles WHERE guild_id = ${guild.id}`;

    for (const role of availableRoles.values()) {
      const colorHex = role.color
        ? `#${role.color.toString(16).padStart(6, "0")}`
        : null;

      await this.sql`
        INSERT INTO guild_roles (
          guild_id,
          role_id,
          role_name,
          position,
          color_hex,
          managed,
          mentionable,
          permissions,
          updated_at
        )
        VALUES (
          ${guild.id},
          ${role.id},
          ${role.name},
          ${role.position},
          ${colorHex},
          ${role.managed},
          ${role.mentionable},
          ${role.permissions.bitfield.toString()},
          NOW()
        )
        ON CONFLICT (guild_id, role_id)
        DO UPDATE SET
          role_name = EXCLUDED.role_name,
          position = EXCLUDED.position,
          color_hex = EXCLUDED.color_hex,
          managed = EXCLUDED.managed,
          mentionable = EXCLUDED.mentionable,
          permissions = EXCLUDED.permissions,
          updated_at = NOW()
      `;
    }

    const rows = [
      ...config.roles.staffRoleIds.map((roleId: string) => ({ roleId, roleKind: "staff" })),
      ...config.roles.upperStaffRoleIds.map((roleId: string) => ({ roleId, roleKind: "upper" })),
      ...config.roles.supervisorRoleIds.map((roleId: string) => ({
        roleId,
        roleKind: "supervisor"
      })),
      ...config.roles.banRoleIds.map((roleId: string) => ({ roleId, roleKind: "ban" })),
      ...config.roles.kickRoleIds.map((roleId: string) => ({ roleId, roleKind: "kick" })),
      ...config.roles.unbanRoleIds.map((roleId: string) => ({ roleId, roleKind: "unban" })),
      ...config.roles.timeoutRoleIds.map((roleId: string) => ({ roleId, roleKind: "timeout" })),
      ...config.roles.warnRoleIds.map((roleId: string) => ({ roleId, roleKind: "warn" })),
      ...config.roles.jailRoleIds.map((roleId: string) => ({ roleId, roleKind: "jail" })),
      ...config.roles.messageModerationRoleIds.map((roleId: string) => ({
        roleId,
        roleKind: "message_moderation"
      })),
      ...config.roles.channelModerationRoleIds.map((roleId: string) => ({
        roleId,
        roleKind: "channel_moderation"
      })),
      ...config.roles.historyRoleIds.map((roleId: string) => ({
        roleId,
        roleKind: "history"
      }))
    ];

    await this.sql`DELETE FROM staff_roles WHERE guild_id = ${guild.id}`;

    for (const row of rows) {
      const roleName = availableRoles.get(row.roleId)?.name ?? row.roleId;
      await this.sql`
        INSERT INTO staff_roles (guild_id, role_id, role_name, role_kind)
        VALUES (${guild.id}, ${row.roleId}, ${roleName}, ${row.roleKind})
        ON CONFLICT (guild_id, role_id)
        DO UPDATE SET
          role_name = EXCLUDED.role_name,
          role_kind = EXCLUDED.role_kind
      `;
    }

    this.logger.info(
      { guildId: guild.id, roleCount: availableRoles.size },
      "Guild role catalog synchronized."
    );
  }

  async syncChannelCatalog(guild: Guild) {
    const channels = await guild.channels.fetch();
    const availableChannels = Array.from(channels.values()).filter(
      (channel): channel is Exclude<typeof channel, null> => Boolean(channel && !channel.isThread())
    );

    await this.sql`DELETE FROM guild_channels WHERE guild_id = ${guild.id}`;

    for (const channel of availableChannels) {
      const channelKind = this.getChannelKind(channel.type);

      await this.sql`
        INSERT INTO guild_channels (
          guild_id,
          channel_id,
          channel_name,
          channel_kind,
          discord_channel_type,
          parent_id,
          position,
          updated_at
        )
        VALUES (
          ${guild.id},
          ${channel.id},
          ${channel.name},
          ${channelKind},
          ${channel.type},
          ${channel.parentId},
          ${channel.position},
          NOW()
        )
        ON CONFLICT (guild_id, channel_id)
        DO UPDATE SET
          channel_name = EXCLUDED.channel_name,
          channel_kind = EXCLUDED.channel_kind,
          discord_channel_type = EXCLUDED.discord_channel_type,
          parent_id = EXCLUDED.parent_id,
          position = EXCLUDED.position,
          updated_at = NOW()
      `;
    }

    this.logger.info(
      { guildId: guild.id, channelCount: availableChannels.length },
      "Guild channel catalog synchronized."
    );
  }

  private getChannelKind(channelType: number) {
    switch (channelType) {
      case ChannelType.GuildCategory:
        return "category";
      case ChannelType.GuildVoice:
        return "voice";
      case ChannelType.GuildStageVoice:
        return "stage";
      case ChannelType.GuildAnnouncement:
        return "announcement";
      case ChannelType.GuildForum:
        return "forum";
      case ChannelType.GuildMedia:
        return "media";
      case ChannelType.GuildText:
        return "text";
      default:
        return "other";
    }
  }
}
