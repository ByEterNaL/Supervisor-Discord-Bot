import type { GuildMember } from "discord.js";
import type { Logger } from "pino";
import type { Sql } from "postgres";

import type {
  ModerationActionType,
  RolePolicyCapability,
  RolePolicyConfig,
  SupervisorConfig
} from "../../../../packages/shared/src";

interface PolicyCheckResult {
  allowed: boolean;
  reason: string | null;
  effectiveCapabilities: RolePolicyCapability[];
  dailyUsage: Record<string, number>;
  cooldownRemaining: number;
}

export class PolicyService {
  constructor(
    private readonly sql: Sql,
    private readonly logger: Logger,
    private readonly getConfig: () => SupervisorConfig
  ) {}

  resolveCapabilities(member: GuildMember): RolePolicyCapability[] {
    const config = this.getConfig().moderation;
    const caps = new Set<RolePolicyCapability>();

    if (!config.rolePolicies || config.rolePolicies.length === 0) {
      return [];
    }

    for (const roleId of member.roles.cache.keys()) {
      const policy = config.rolePolicies.find((p) => p.roleId === roleId);
      if (policy) {
        for (const cap of policy.capabilities) {
          caps.add(cap);
        }
      }
    }

    return Array.from(caps);
  }

  async checkAction(
    member: GuildMember,
    action: ModerationActionType | "guard_quarantine" | "guard_restore" | "guard_log"
  ): Promise<PolicyCheckResult> {
    const config = this.getConfig().moderation;

    // Admin whitelist, Guild Owner, or Administrator bypass
    if (
      config.adminWhitelistUserIds?.includes(member.id) ||
      member.id === member.guild.ownerId ||
      member.permissions.has("Administrator")
    ) {
      return {
        allowed: true,
        reason: null,
        effectiveCapabilities: [action as RolePolicyCapability],
        dailyUsage: {},
        cooldownRemaining: 0
      };
    }

    // If strictRoleOnly is enabled, member must have at least one policy role
    const memberRoleIds = Array.from(member.roles.cache.keys());
    const hasPolicyRole = config.rolePolicies.some((p) => memberRoleIds.includes(p.roleId));

    if (config.strictRoleOnly && !hasPolicyRole && member.id !== member.guild.ownerId) {
      return {
        allowed: false,
        reason: "Bu sunucuda yetki sistemi devrede: size atanmış bir yetki politikası bulunmuyor.",
        effectiveCapabilities: [],
        dailyUsage: {},
        cooldownRemaining: 0
      };
    }

    const capabilities = this.resolveCapabilities(member);
    const effectivePolicy = this.resolveEffectivePolicy(member, action);

    if (!effectivePolicy || !capabilities.includes(action as RolePolicyCapability)) {
      let reqPerm: any = null;
      if (action === "ban" || action === "unban" || action === "softban") reqPerm = "BanMembers";
      else if (action === "kick") reqPerm = "KickMembers";
      else if (action === "timeout" || action === "untimeout" || action === "warn" || action === "unwarn") reqPerm = "ModerateMembers";
      else if (action === "purge") reqPerm = "ManageMessages";
      else if (action === "lock" || action === "unlock" || action === "slowmode") reqPerm = "ManageChannels";

      if (!config.strictRoleOnly && reqPerm && member.permissions.has(reqPerm)) {
        return {
          allowed: true,
          reason: null,
          effectiveCapabilities: capabilities.length ? capabilities : [action as RolePolicyCapability],
          dailyUsage: {},
          cooldownRemaining: 0
        };
      }

      return {
        allowed: false,
        reason: `Bu işlem için yetkiniz yok: ${action}`,
        effectiveCapabilities: capabilities,
        dailyUsage: {},
        cooldownRemaining: 0
      };
    }

    // Check cooldown
    const cooldown = await this.checkCooldown(member.id, effectivePolicy.cooldownSeconds);
    if (cooldown > 0) {
      return {
        allowed: false,
        reason: `İşlemler arasında ${effectivePolicy.cooldownSeconds} saniye bekleme süresi var. Kalan: ${cooldown.toFixed(0)} saniye.`,
        effectiveCapabilities: capabilities,
        dailyUsage: {},
        cooldownRemaining: cooldown
      };
    }

    // Check daily limit
    const limit = effectivePolicy.dailyLimits?.find((l) => l.actionType === action);
    let dailyUsage = 0;
    if (limit) {
      const [row] = await this.sql<{ count: number }[]>`
        SELECT COUNT(*)::int as count
        FROM moderation_actions
        WHERE actor_id = ${member.id}
        AND action_type = ${action}
        AND created_at >= (NOW() AT TIME ZONE 'UTC')::date
      `;
      dailyUsage = row?.count ?? 0;
      if (dailyUsage >= limit.maxDaily) {
        return {
          allowed: false,
          reason: `Günlük ${action} limitinize ulaştınız (${limit.maxDaily}/${limit.maxDaily}).`,
          effectiveCapabilities: capabilities,
          dailyUsage: { [action]: dailyUsage },
          cooldownRemaining: 0
        };
      }
    }

    return {
      allowed: true,
      reason: null,
      effectiveCapabilities: capabilities,
      dailyUsage: limit ? { [action]: dailyUsage } : {},
      cooldownRemaining: 0
    };
  }

  async recordAction(member: GuildMember, action: string): Promise<void> {
    try {
      await this.sql`
        INSERT INTO moderation_actions (actor_id, action_type, created_at)
        VALUES (${member.id}, ${action}, NOW())
      `;
    } catch (error) {
      this.logger.warn({ error, actorId: member.id, action }, "Failed to record policy action");
    }
  }

  async resetDailyUsage(memberId: string, action?: string): Promise<void> {
    if (action) {
      await this.sql`
        DELETE FROM moderation_actions
        WHERE actor_id = ${memberId}
        AND action_type = ${action}
        AND created_at >= (NOW() AT TIME ZONE 'UTC')::date
      `;
    } else {
      await this.sql`
        DELETE FROM moderation_actions
        WHERE actor_id = ${memberId}
        AND created_at >= (NOW() AT TIME ZONE 'UTC')::date
      `;
    }
  }

  private resolveEffectivePolicy(
    member: GuildMember,
    action: string
  ): RolePolicyConfig | null {
    const config = this.getConfig().moderation;
    const policies: RolePolicyConfig[] = [];

    for (const roleId of member.roles.cache.keys()) {
      const policy = config.rolePolicies.find((p) => p.roleId === roleId);
      if (policy && policy.capabilities.includes(action as RolePolicyCapability)) {
        policies.push(policy);
      }
    }

    if (policies.length === 0) {
      return null;
    }

    // Merge: highest daily limits, shortest cooldown, union of capabilities
    const merged: RolePolicyConfig = {
      roleId: "merged",
      label: "merged",
      capabilities: [],
      dailyLimits: [],
      autoPunishOnLimit: false,
      cooldownSeconds: 0
    };

    const allCaps = new Set<RolePolicyCapability>();
    const limitMap = new Map<string, number>();
    let minCooldown = Infinity;
    let anyAutoPunish = false;

    for (const p of policies) {
      for (const cap of p.capabilities) allCaps.add(cap);
      for (const l of p.dailyLimits) {
        const current = limitMap.get(l.actionType) ?? 0;
        if (l.maxDaily > current) limitMap.set(l.actionType, l.maxDaily);
      }
      if (p.cooldownSeconds < minCooldown) minCooldown = p.cooldownSeconds;
      if (p.autoPunishOnLimit) anyAutoPunish = true;
    }

    merged.capabilities = Array.from(allCaps);
    merged.dailyLimits = Array.from(limitMap.entries()).map(([actionType, maxDaily]) => ({
      actionType: actionType as RolePolicyLimit["actionType"],
      maxDaily
    }));
    merged.cooldownSeconds = minCooldown === Infinity ? 0 : minCooldown;
    merged.autoPunishOnLimit = anyAutoPunish;

    return merged;
  }

  private async checkCooldown(memberId: string, cooldownSeconds: number): Promise<number> {
    if (cooldownSeconds <= 0) return 0;
    try {
      const [row] = await this.sql<{ latest: Date }[]>`
        SELECT MAX(created_at) as latest
        FROM moderation_actions
        WHERE actor_id = ${memberId}
        AND created_at >= NOW() - INTERVAL '1 second' * ${cooldownSeconds}
      `;
      if (!row?.latest) return 0;
      const elapsed = (Date.now() - new Date(row.latest).getTime()) / 1000;
      return Math.max(0, cooldownSeconds - elapsed);
    } catch {
      return 0;
    }
  }
}

type RolePolicyLimit = {
  actionType: ModerationActionType | "purge";
  maxDaily: number;
};
