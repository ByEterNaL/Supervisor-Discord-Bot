import { z } from "zod";

import { SupervisorConfig } from "./types";

export const CONFIG_KEY = "supervisor.config";
export const CONFIG_CHANGED_CHANNEL = "supervisor:config-changed";

const guardAdvancedShape = {
  logOnly: z.boolean().default(false),
  severityOverride: z
    .enum(["inherit", "info", "warning", "critical"])
    .default("inherit"),
  auditWindowSeconds: z
    .number()
    .int()
    .min(30)
    .max(900)
    .default(180),
  whitelistRoleIds: z.array(z.string()).default([]),
  cooldownSeconds: z.number().int().min(0).max(3600).default(0),
  actionTier: z
    .enum(["log", "warn", "timeout", "quarantine", "kick", "ban"])
    .default("quarantine")
};

export const supervisorConfigSchema = z.object({
  roles: z.object({
    staffRoleIds: z.array(z.string()).default([]),
    upperStaffRoleIds: z.array(z.string()).default([]),
    supervisorRoleIds: z.array(z.string()).default([]),
    banRoleIds: z.array(z.string()).default([]),
    kickRoleIds: z.array(z.string()).default([]),
    unbanRoleIds: z.array(z.string()).default([]),
    timeoutRoleIds: z.array(z.string()).default([]),
    warnRoleIds: z.array(z.string()).default([]),
    jailRoleIds: z.array(z.string()).default([]),
    messageModerationRoleIds: z.array(z.string()).default([]),
    channelModerationRoleIds: z.array(z.string()).default([]),
    historyRoleIds: z.array(z.string()).default([]),
    ticketRoleIds: z.array(z.string()).default([])
  }),
  voice: z.object({
    afkChannelId: z.string().nullable().default(null),
    ignoredChannelIds: z.array(z.string()).default([]),
    ignoredCategoryIds: z.array(z.string()).default([])
  }),
  ticket: z.object({
    panelChannelIds: z.array(z.string()).default([]),
    activeCategoryMode: z.enum(["auto", "manual"]).default("auto"),
    categoryParentId: z.string().nullable().default(null),
    archiveCategoryMode: z.enum(["auto", "manual"]).default("auto"),
    archiveCategoryId: z.string().nullable().default(null),
    embedImageUrl: z.string().default(""),
    embedTitle: z.string().default("Destek Talebi"),
    embedDescription: z
      .string()
      .default("Destek almak için aşağıdaki butona basarak ticket oluşturabilirsiniz."),
    welcomeTitle: z.string().default("Hoş geldin, {user}"),
    welcomeDescription: z
      .string()
      .default(
        "Destek ekibimiz kısa süre içinde sizinle iletişime geçecektir. Bu işlemi kapatmak için kapat düğmesine basın."
      ),
    joinWelcomeTitle: z.string().default("Katılım Talebi: {user}"),
    joinWelcomeDescription: z
      .string()
      .default("Katılım başvurunuz inceleniyor. Girmiş olduğunuz bilgiler aşağıda yer almaktadır. Lütfen yetkililerin dönüş yapmasını bekleyin."),
    onboardingQuestion: z.string().default("Katıl işlemleri için mi geldiniz?"),
    onboardingYesLabel: z.string().default("Evet"),
    onboardingNoLabel: z.string().default("Hayır"),
    callCooldownSeconds: z.number().int().positive().default(600)
  }),
  alerts: z.object({
    staleTicketMinutes: z.number().int().positive().default(120),
    unclaimedTicketMinutes: z.number().int().positive().default(20),
    openTicketThreshold: z.number().int().positive().default(15)
  }),
  unproven: z.object({
    targetRoleIds: z.array(z.string()).default([]),
    proofChannelId: z.string().nullable().default(null)
  }),
  bannedWords: z.array(
    z.object({
      id: z.string(),
      channelId: z.string(),
      words: z.array(z.string())
    })
  ).default([]),
  channelAnalysis: z.object({
    rules: z.array(
      z.object({
        id: z.string(),
        channelId: z.string(),
        maxMessagesPerHour: z.number().int().positive(),
        timeoutMinutes: z.number().int().positive()
      })
    ).default([])
  }),
  rankSystem: z.object({
    enabled: z.boolean().default(false),
    curve: z.object({
      baseXp: z.number().int().positive().default(100),
      linearXp: z.number().int().nonnegative().default(35),
      quadraticXp: z.number().int().nonnegative().default(10)
    }),
    leaderboard: z.object({
      panelPageSize: z.number().int().positive().default(50),
      commandTopSize: z.number().int().positive().default(10)
    }),
    text: z.object({
      enabled: z.boolean().default(true),
      xpPerEligibleMessage: z.number().int().positive().default(5),
      cooldownSeconds: z.number().int().nonnegative().default(45),
      minNormalizedLength: z.number().int().positive().default(8),
      duplicateWindowMinutes: z.number().int().positive().default(10),
      hourlyEligibleCap: z.number().int().positive().default(20),
      ignoredChannelIds: z.array(z.string()).default([]),
      ignoredCategoryIds: z.array(z.string()).default([])
    }),
    voice: z.object({
      enabled: z.boolean().default(true),
      xpPerActiveMinute: z.number().int().positive().default(2),
      minAwardChunkSeconds: z.number().int().positive().default(60)
    }),
    rewards: z.object({
      roleRewardsEnabled: z.boolean().default(false),
      levelUpMessagesEnabled: z.boolean().default(false),
      announcementChannelId: z.string().nullable().default(null),
      roleMode: z.enum(["highest_only", "stacking"]).default("highest_only"),
      voiceRewards: z.array(
        z.object({
          level: z.number().int().positive(),
          roleId: z.string()
        })
      ).default([]),
      textRewards: z.array(
        z.object({
          level: z.number().int().positive(),
          roleId: z.string()
        })
      ).default([])
    })
  }),
  moderation: z.object({
    jailRoleId: z.string().nullable().default(null),
    mutedRoleId: z.string().nullable().default(null),
    logChannelId: z.string().nullable().default(null),
    defaultDmEnabled: z.boolean().default(true),
    defaultTimeoutMinutes: z.number().int().positive().default(10),
    defaultWarnPoints: z.number().int().positive().default(1),
    purgeMaxLimit: z.number().int().positive().default(200),
    safeFlowEnabled: z.boolean().default(true),
    globalBanEnabled: z.boolean().default(false),
    roleLimits: z.array(
      z.object({
        targetId: z.string(),
        limits: z.array(
          z.object({
            actionType: z.enum([
              "ban",
              "unban",
              "kick",
              "timeout",
              "untimeout",
              "softban",
              "warn",
              "unwarn",
              "jail",
              "unjail",
              "purge",
              "lock",
              "unlock",
              "slowmode"
            ]),
            maxDaily: z.number().int().positive()
          })
        )
      })
    ).default([]),
    userLimits: z.array(
      z.object({
        targetId: z.string(),
        limits: z.array(
          z.object({
            actionType: z.enum([
              "ban",
              "unban",
              "kick",
              "timeout",
              "untimeout",
              "softban",
              "warn",
              "unwarn",
              "jail",
              "unjail",
              "purge",
              "lock",
              "unlock",
              "slowmode"
            ]),
            maxDaily: z.number().int().positive()
          })
        )
      })
    ).default([]),
    rolePolicies: z.array(
      z.object({
        roleId: z.string(),
        label: z.string().default(""),
        capabilities: z.array(
          z.enum([
            "ban",
            "unban",
            "kick",
            "timeout",
            "untimeout",
            "softban",
            "warn",
            "unwarn",
            "jail",
            "unjail",
            "purge",
            "lock",
            "unlock",
            "slowmode",
            "guard_quarantine",
            "guard_restore",
            "guard_log"
          ])
        ).default([]),
        dailyLimits: z.array(
          z.object({
            actionType: z.enum([
              "ban",
              "unban",
              "kick",
              "timeout",
              "untimeout",
              "softban",
              "warn",
              "unwarn",
              "jail",
              "unjail",
              "purge"
            ]),
            maxDaily: z.number().int().positive()
          })
        ).default([]),
        autoPunishOnLimit: z.boolean().default(true),
        cooldownSeconds: z.number().int().min(0).max(3600).default(60)
      })
    ).default([]),
    strictRoleOnly: z.boolean().default(false),
    adminWhitelistUserIds: z.array(z.string()).default([])
  }),
  ultraProtection: z.object({
    enabled: z.boolean().default(false),
    quarantineRoleId: z.string().nullable().default(null),
    whitelist: z.object({
      userIds: z.array(z.string()).default([]),
      roleIds: z.array(z.string()).default([])
    }),
    blacklist: z.object({
      userIds: z.array(z.string()).default([]),
      roleIds: z.array(z.string()).default([])
    }),
    schedule: z.object({
      enabled: z.boolean().default(false),
      startHour: z.number().int().min(0).max(23).default(0),
      endHour: z.number().int().min(0).max(23).default(8)
    }),
    channelGuard: z.object({
      enabled: z.boolean().default(false),
      quarantine: z.boolean().default(true),
      restoreOnDelete: z.boolean().default(true),
      ...guardAdvancedShape
    }),
    categoryGuard: z.object({
      enabled: z.boolean().default(false),
      quarantine: z.boolean().default(true),
      restoreOnDelete: z.boolean().default(true),
      ...guardAdvancedShape
    }),
    webhookGuard: z.object({
      enabled: z.boolean().default(false),
      quarantine: z.boolean().default(true),
      ...guardAdvancedShape
    }),
    botGuard: z.object({
      enabled: z.boolean().default(false),
      quarantine: z.boolean().default(true),
      kickUnauthorizedBots: z.boolean().default(true),
      allowedBotIds: z.array(z.string()).default([]),
      ...guardAdvancedShape
    }),
    guildSettingsGuard: z.object({
      enabled: z.boolean().default(false),
      quarantine: z.boolean().default(true),
      ...guardAdvancedShape
    }),
    bulkActionGuard: z.object({
      enabled: z.boolean().default(false),
      quarantine: z.boolean().default(true),
      windowSeconds: z.number().int().positive().default(120),
      maxActions: z.number().int().positive().default(3),
      ...guardAdvancedShape
    }),
    manualActionGuard: z.object({
      enabled: z.boolean().default(false),
      quarantine: z.boolean().default(true),
      ...guardAdvancedShape
    }),
    roleGuard: z.object({
      enabled: z.boolean().default(false),
      quarantine: z.boolean().default(true),
      restrictedPermissions: z
        .array(
          z.enum([
            "Administrator",
            "ManageGuild",
            "ManageRoles",
            "ManageChannels",
            "ManageWebhooks",
            "ManageGuildExpressions",
            "BanMembers",
            "KickMembers",
            "ModerateMembers",
            "MentionEveryone"
          ])
        )
        .default([
          "Administrator",
          "ManageGuild",
          "ManageRoles",
          "ManageChannels",
          "ManageWebhooks",
          "BanMembers",
          "KickMembers"
        ]),
      autoDeleteRiskyNewRoles: z.boolean().default(true),
      protectedRoleIds: z.array(z.string()).default([]),
      ...guardAdvancedShape
    }),
    antiRaidGuard: z.object({
      enabled: z.boolean().default(false),
      quarantine: z.boolean().default(true),
      windowSeconds: z.number().int().min(10).max(600).default(30),
      joinThreshold: z.number().int().min(2).max(200).default(8),
      minAccountAgeDays: z.number().int().min(0).max(365).default(7),
      raidAction: z.enum(["quarantine", "kick", "ban"]).default("kick"),
      raidModeCooldownMinutes: z.number().int().min(1).max(1440).default(15),
      ...guardAdvancedShape
    }),
    inviteLinkGuard: z.object({
      enabled: z.boolean().default(false),
      quarantine: z.boolean().default(true),
      blockDiscordInvites: z.boolean().default(true),
      allowedDomains: z.array(z.string()).default([]),
      exemptChannelIds: z.array(z.string()).default([]),
      actionOnViolation: z
        .enum(["delete", "timeout", "quarantine"])
        .default("delete"),
      ...guardAdvancedShape
    }),
    messageNukeGuard: z.object({
      enabled: z.boolean().default(false),
      quarantine: z.boolean().default(true),
      windowSeconds: z.number().int().min(10).max(600).default(30),
      deleteThreshold: z.number().int().min(3).max(500).default(10),
      bulkDeleteThreshold: z.number().int().min(1).max(50).default(2),
      ...guardAdvancedShape
    }),
    settingsRollbackGuard: z.object({
      enabled: z.boolean().default(false),
      rollbackFields: z
        .array(
          z.enum([
            "name",
            "iconUrl",
            "bannerUrl",
            "verificationLevel",
            "explicitContentFilter",
            "defaultMessageNotifications",
            "systemChannelId",
            "rulesChannelId",
            "publicUpdatesChannelId"
          ])
        )
        .default([
          "name",
          "iconUrl",
          "bannerUrl",
          "verificationLevel"
        ]),
      cooldownSeconds: z.number().int().min(0).max(3600).default(30)
    }),
    serverBackup: z.object({
      enabled: z.boolean().default(false),
      autoCreateOnBoot: z.boolean().default(true)
    }),
    autoModGuard: z.object({
      enabled: z.boolean().default(false),
      blockLinks: z.boolean().default(false),
      blockInvites: z.boolean().default(false),
      blockProfanity: z.boolean().default(false),
      blockSpam: z.boolean().default(false),
      blockMassMentions: z.boolean().default(false),
      massMentionThreshold: z.number().int().min(1).max(50).default(5),
      blockStaffMentions: z.boolean().default(false),
      exemptRoleIds: z.array(z.string()).default([]),
      exemptChannelIds: z.array(z.string()).default([]),
      actionType: z.enum(["block", "timeout", "alert"]).default("block"),
      timeoutMinutes: z.number().int().min(1).max(40320).default(10),
      alertChannelId: z.string().nullable().default(null)
    })
  })
});

export const defaultConfig: SupervisorConfig = {
  roles: {
    staffRoleIds: [],
    upperStaffRoleIds: [],
    supervisorRoleIds: [],
    banRoleIds: [],
    kickRoleIds: [],
    unbanRoleIds: [],
    timeoutRoleIds: [],
    warnRoleIds: [],
    jailRoleIds: [],
    messageModerationRoleIds: [],
    channelModerationRoleIds: [],
    historyRoleIds: [],
    ticketRoleIds: []
  },
  voice: {
    afkChannelId: null,
    ignoredChannelIds: [],
    ignoredCategoryIds: []
  },
  ticket: {
    panelChannelIds: [],
    activeCategoryMode: "auto",
    categoryParentId: null,
    archiveCategoryMode: "auto",
    archiveCategoryId: null,
    embedImageUrl: "",
    embedTitle: "Destek Talebi",
    embedDescription: "Destek almak için aşağıdaki butona basarak ticket oluşturabilirsiniz.",
    welcomeTitle: "Hoş geldin, {user}",
    welcomeDescription:
      "Destek ekibimiz kısa süre içinde sizinle iletişime geçecektir. Bu işlemi kapatmak için kapat düğmesine basın.",
    joinWelcomeTitle: "Katılım Talebi: {user}",
    joinWelcomeDescription: "Katılım başvurunuz inceleniyor. Girmiş olduğunuz bilgiler aşağıda yer almaktadır. Lütfen yetkililerin dönüş yapmasını bekleyin.",
    onboardingQuestion: "Katıl işlemleri için mi geldiniz?",
    onboardingYesLabel: "Evet",
    onboardingNoLabel: "Hayır",
    callCooldownSeconds: 600
  },
  alerts: {
    staleTicketMinutes: 120,
    unclaimedTicketMinutes: 20,
    openTicketThreshold: 15
  },
  unproven: {
    targetRoleIds: [],
    proofChannelId: null
  },
  bannedWords: [],
  channelAnalysis: {
    rules: []
  },
  rankSystem: {
    enabled: true,
    curve: {
      baseXp: 100,
      linearXp: 35,
      quadraticXp: 10
    },
    leaderboard: {
      panelPageSize: 50,
      commandTopSize: 10
    },
    text: {
      enabled: true,
      xpPerEligibleMessage: 5,
      cooldownSeconds: 45,
      minNormalizedLength: 8,
      duplicateWindowMinutes: 10,
      hourlyEligibleCap: 20,
      ignoredChannelIds: [],
      ignoredCategoryIds: []
    },
    voice: {
      enabled: true,
      xpPerActiveMinute: 2,
      minAwardChunkSeconds: 60
    },
    rewards: {
      roleRewardsEnabled: false,
      levelUpMessagesEnabled: false,
      announcementChannelId: null,
      roleMode: "highest_only",
      voiceRewards: [],
      textRewards: []
    }
  },
  moderation: {
    jailRoleId: null,
    mutedRoleId: null,
    logChannelId: null,
    defaultDmEnabled: true,
    defaultTimeoutMinutes: 10,
    defaultWarnPoints: 1,
    purgeMaxLimit: 200,
    safeFlowEnabled: true,
    globalBanEnabled: false,
    roleLimits: [],
    userLimits: [],
    rolePolicies: [],
    strictRoleOnly: false,
    adminWhitelistUserIds: []
  },
  ultraProtection: {
    enabled: false,
    quarantineRoleId: null,
    whitelist: {
      userIds: [],
      roleIds: []
    },
    blacklist: {
      userIds: [],
      roleIds: []
    },
    schedule: {
      enabled: false,
      startHour: 0,
      endHour: 8
    },
    channelGuard: {
      enabled: false,
      quarantine: true,
      restoreOnDelete: true,
      logOnly: false,
      severityOverride: "inherit",
      auditWindowSeconds: 180,
      whitelistRoleIds: [],
      cooldownSeconds: 0,
      actionTier: "quarantine"
    },
    categoryGuard: {
      enabled: false,
      quarantine: true,
      restoreOnDelete: true,
      logOnly: false,
      severityOverride: "inherit",
      auditWindowSeconds: 180,
      whitelistRoleIds: [],
      cooldownSeconds: 0,
      actionTier: "quarantine"
    },
    webhookGuard: {
      enabled: false,
      quarantine: true,
      logOnly: false,
      severityOverride: "inherit",
      auditWindowSeconds: 180,
      whitelistRoleIds: [],
      cooldownSeconds: 0,
      actionTier: "quarantine"
    },
    botGuard: {
      enabled: false,
      quarantine: true,
      kickUnauthorizedBots: true,
      allowedBotIds: [],
      logOnly: false,
      severityOverride: "inherit",
      auditWindowSeconds: 180,
      whitelistRoleIds: [],
      cooldownSeconds: 0,
      actionTier: "quarantine"
    },
    guildSettingsGuard: {
      enabled: false,
      quarantine: true,
      logOnly: false,
      severityOverride: "inherit",
      auditWindowSeconds: 180,
      whitelistRoleIds: [],
      cooldownSeconds: 0,
      actionTier: "quarantine"
    },
    bulkActionGuard: {
      enabled: false,
      quarantine: true,
      windowSeconds: 120,
      maxActions: 3,
      logOnly: false,
      severityOverride: "inherit",
      auditWindowSeconds: 180,
      whitelistRoleIds: [],
      cooldownSeconds: 0,
      actionTier: "quarantine"
    },
    manualActionGuard: {
      enabled: false,
      quarantine: true,
      logOnly: false,
      severityOverride: "inherit",
      auditWindowSeconds: 180,
      whitelistRoleIds: [],
      cooldownSeconds: 0,
      actionTier: "quarantine"
    },
    roleGuard: {
      enabled: false,
      quarantine: true,
      restrictedPermissions: [
        "Administrator",
        "ManageGuild",
        "ManageRoles",
        "ManageChannels",
        "ManageWebhooks",
        "BanMembers",
        "KickMembers"
      ],
      autoDeleteRiskyNewRoles: true,
      protectedRoleIds: [],
      logOnly: false,
      severityOverride: "inherit",
      auditWindowSeconds: 180,
      whitelistRoleIds: [],
      cooldownSeconds: 0,
      actionTier: "quarantine"
    },
    antiRaidGuard: {
      enabled: false,
      quarantine: true,
      windowSeconds: 30,
      joinThreshold: 8,
      minAccountAgeDays: 7,
      raidAction: "kick",
      raidModeCooldownMinutes: 15,
      logOnly: false,
      severityOverride: "inherit",
      auditWindowSeconds: 180,
      whitelistRoleIds: [],
      cooldownSeconds: 0,
      actionTier: "quarantine"
    },
    inviteLinkGuard: {
      enabled: false,
      quarantine: true,
      blockDiscordInvites: true,
      allowedDomains: [],
      exemptChannelIds: [],
      actionOnViolation: "delete",
      logOnly: false,
      severityOverride: "inherit",
      auditWindowSeconds: 180,
      whitelistRoleIds: [],
      cooldownSeconds: 0,
      actionTier: "quarantine"
    },
    messageNukeGuard: {
      enabled: false,
      quarantine: true,
      windowSeconds: 30,
      deleteThreshold: 10,
      bulkDeleteThreshold: 2,
      logOnly: false,
      severityOverride: "inherit",
      auditWindowSeconds: 180,
      whitelistRoleIds: [],
      cooldownSeconds: 0,
      actionTier: "quarantine"
    },
    settingsRollbackGuard: {
      enabled: false,
      rollbackFields: [
        "name",
        "iconUrl",
        "bannerUrl",
        "verificationLevel"
      ],
      cooldownSeconds: 30
    },
    serverBackup: {
      enabled: false,
      autoCreateOnBoot: true
    },
    autoModGuard: {
      enabled: false,
      blockLinks: false,
      blockInvites: false,
      blockProfanity: false,
      blockSpam: false,
      blockMassMentions: false,
      massMentionThreshold: 5,
      blockStaffMentions: false,
      exemptRoleIds: [],
      exemptChannelIds: [],
      actionType: "block",
      timeoutMinutes: 10,
      alertChannelId: null
    }
  }
};

export function mergeConfig(input: unknown): SupervisorConfig {
  const source =
    typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};

  return supervisorConfigSchema.parse({
    roles: {
      ...defaultConfig.roles,
      ...((source.roles as Record<string, unknown> | undefined) ?? {})
    },
    voice: {
      ...defaultConfig.voice,
      ...((source.voice as Record<string, unknown> | undefined) ?? {})
    },
    ticket: {
      ...defaultConfig.ticket,
      ...((source.ticket as Record<string, unknown> | undefined) ?? {})
    },
    alerts: {
      ...defaultConfig.alerts,
      ...((source.alerts as Record<string, unknown> | undefined) ?? {})
    },
    unproven: {
      ...defaultConfig.unproven,
      ...((source.unproven as Record<string, unknown> | undefined) ?? {})
    },
    bannedWords: Array.isArray(source.bannedWords) ? source.bannedWords : defaultConfig.bannedWords,
    channelAnalysis: {
      ...defaultConfig.channelAnalysis,
      ...((source.channelAnalysis as Record<string, unknown> | undefined) ?? {}),
      rules: Array.isArray((source.channelAnalysis as Record<string, unknown> | undefined)?.rules)
        ? ((source.channelAnalysis as Record<string, unknown>).rules as unknown[])
        : defaultConfig.channelAnalysis.rules
    },
    rankSystem: {
      ...defaultConfig.rankSystem,
      ...((source.rankSystem as Record<string, unknown> | undefined) ?? {}),
      curve: {
        ...defaultConfig.rankSystem.curve,
        ...(((source.rankSystem as Record<string, unknown> | undefined)?.curve as Record<string, unknown> | undefined) ?? {})
      },
      leaderboard: {
        ...defaultConfig.rankSystem.leaderboard,
        ...(((source.rankSystem as Record<string, unknown> | undefined)?.leaderboard as Record<string, unknown> | undefined) ?? {})
      },
      text: {
        ...defaultConfig.rankSystem.text,
        ...(((source.rankSystem as Record<string, unknown> | undefined)?.text as Record<string, unknown> | undefined) ?? {}),
        ignoredChannelIds: Array.isArray((((source.rankSystem as Record<string, unknown> | undefined)?.text as Record<string, unknown> | undefined)?.ignoredChannelIds))
          ? ((((source.rankSystem as Record<string, unknown> | undefined)?.text as Record<string, unknown>).ignoredChannelIds) as unknown[])
          : defaultConfig.rankSystem.text.ignoredChannelIds,
        ignoredCategoryIds: Array.isArray((((source.rankSystem as Record<string, unknown> | undefined)?.text as Record<string, unknown> | undefined)?.ignoredCategoryIds))
          ? ((((source.rankSystem as Record<string, unknown> | undefined)?.text as Record<string, unknown>).ignoredCategoryIds) as unknown[])
          : defaultConfig.rankSystem.text.ignoredCategoryIds
      },
      voice: {
        ...defaultConfig.rankSystem.voice,
        ...(((source.rankSystem as Record<string, unknown> | undefined)?.voice as Record<string, unknown> | undefined) ?? {})
      },
      rewards: {
        ...defaultConfig.rankSystem.rewards,
        ...(((source.rankSystem as Record<string, unknown> | undefined)?.rewards as Record<string, unknown> | undefined) ?? {}),
        voiceRewards: Array.isArray((((source.rankSystem as Record<string, unknown> | undefined)?.rewards as Record<string, unknown> | undefined)?.voiceRewards))
          ? ((((source.rankSystem as Record<string, unknown> | undefined)?.rewards as Record<string, unknown>).voiceRewards) as unknown[])
          : defaultConfig.rankSystem.rewards.voiceRewards,
        textRewards: Array.isArray((((source.rankSystem as Record<string, unknown> | undefined)?.rewards as Record<string, unknown> | undefined)?.textRewards))
          ? ((((source.rankSystem as Record<string, unknown> | undefined)?.rewards as Record<string, unknown>).textRewards) as unknown[])
          : defaultConfig.rankSystem.rewards.textRewards
      }
    },
    moderation: {
      ...defaultConfig.moderation,
      ...((source.moderation as Record<string, unknown> | undefined) ?? {}),
      roleLimits: Array.isArray((source.moderation as Record<string, unknown> | undefined)?.roleLimits)
        ? (((source.moderation as Record<string, unknown> | undefined)?.roleLimits) as unknown[])
        : defaultConfig.moderation.roleLimits,
      userLimits: Array.isArray((source.moderation as Record<string, unknown> | undefined)?.userLimits)
        ? (((source.moderation as Record<string, unknown> | undefined)?.userLimits) as unknown[])
        : defaultConfig.moderation.userLimits,
      rolePolicies: Array.isArray((source.moderation as Record<string, unknown> | undefined)?.rolePolicies)
        ? (((source.moderation as Record<string, unknown> | undefined)?.rolePolicies) as unknown[])
        : defaultConfig.moderation.rolePolicies,
      adminWhitelistUserIds: Array.isArray((source.moderation as Record<string, unknown> | undefined)?.adminWhitelistUserIds)
        ? (((source.moderation as Record<string, unknown> | undefined)?.adminWhitelistUserIds) as unknown[])
        : defaultConfig.moderation.adminWhitelistUserIds
    },
    ultraProtection: {
      ...defaultConfig.ultraProtection,
      ...((source.ultraProtection as Record<string, unknown> | undefined) ?? {}),
      whitelist: {
        ...defaultConfig.ultraProtection.whitelist,
        ...(((source.ultraProtection as Record<string, unknown> | undefined)?.whitelist as Record<
          string,
          unknown
        > | undefined) ?? {})
      },
      blacklist: {
        ...defaultConfig.ultraProtection.blacklist,
        ...(((source.ultraProtection as Record<string, unknown> | undefined)?.blacklist as Record<
          string,
          unknown
        > | undefined) ?? {})
      },
      schedule: {
        ...defaultConfig.ultraProtection.schedule,
        ...(((source.ultraProtection as Record<string, unknown> | undefined)?.schedule as Record<
          string,
          unknown
        > | undefined) ?? {})
      },
      channelGuard: {
        ...defaultConfig.ultraProtection.channelGuard,
        ...(((source.ultraProtection as Record<string, unknown> | undefined)?.channelGuard as Record<
          string,
          unknown
        > | undefined) ?? {})
      },
      categoryGuard: {
        ...defaultConfig.ultraProtection.categoryGuard,
        ...(((source.ultraProtection as Record<string, unknown> | undefined)?.categoryGuard as Record<
          string,
          unknown
        > | undefined) ?? {})
      },
      webhookGuard: {
        ...defaultConfig.ultraProtection.webhookGuard,
        ...(((source.ultraProtection as Record<string, unknown> | undefined)?.webhookGuard as Record<
          string,
          unknown
        > | undefined) ?? {})
      },
      botGuard: {
        ...defaultConfig.ultraProtection.botGuard,
        ...(((source.ultraProtection as Record<string, unknown> | undefined)?.botGuard as Record<
          string,
          unknown
        > | undefined) ?? {})
      },
      guildSettingsGuard: {
        ...defaultConfig.ultraProtection.guildSettingsGuard,
        ...(((source.ultraProtection as Record<
          string,
          unknown
        > | undefined)?.guildSettingsGuard as Record<string, unknown> | undefined) ?? {})
      },
      bulkActionGuard: {
        ...defaultConfig.ultraProtection.bulkActionGuard,
        ...(((source.ultraProtection as Record<string, unknown> | undefined)?.bulkActionGuard as Record<
          string,
          unknown
        > | undefined) ?? {})
      },
      manualActionGuard: {
        ...defaultConfig.ultraProtection.manualActionGuard,
        ...(((source.ultraProtection as Record<string, unknown> | undefined)?.manualActionGuard as Record<
          string,
          unknown
        > | undefined) ?? {})
      },
      roleGuard: {
        ...defaultConfig.ultraProtection.roleGuard,
        ...(((source.ultraProtection as Record<string, unknown> | undefined)?.roleGuard as Record<
          string,
          unknown
        > | undefined) ?? {})
      },
      antiRaidGuard: {
        ...defaultConfig.ultraProtection.antiRaidGuard,
        ...(((source.ultraProtection as Record<string, unknown> | undefined)?.antiRaidGuard as Record<
          string,
          unknown
        > | undefined) ?? {})
      },
      inviteLinkGuard: {
        ...defaultConfig.ultraProtection.inviteLinkGuard,
        ...(((source.ultraProtection as Record<string, unknown> | undefined)?.inviteLinkGuard as Record<
          string,
          unknown
        > | undefined) ?? {})
      },
      messageNukeGuard: {
        ...defaultConfig.ultraProtection.messageNukeGuard,
        ...(((source.ultraProtection as Record<string, unknown> | undefined)?.messageNukeGuard as Record<
          string,
          unknown
        > | undefined) ?? {})
      },
      settingsRollbackGuard: {
        ...defaultConfig.ultraProtection.settingsRollbackGuard,
        ...(((source.ultraProtection as Record<string, unknown> | undefined)?.settingsRollbackGuard as Record<
          string,
          unknown
        > | undefined) ?? {})
      },
      serverBackup: {
        ...defaultConfig.ultraProtection.serverBackup,
        ...(((source.ultraProtection as Record<string, unknown> | undefined)?.serverBackup as Record<
          string,
          unknown
        > | undefined) ?? {})
      },
      autoModGuard: {
        ...defaultConfig.ultraProtection.autoModGuard,
        ...(((source.ultraProtection as Record<string, unknown> | undefined)?.autoModGuard as Record<
          string,
          unknown
        > | undefined) ?? {}),
        exemptRoleIds: Array.isArray((((source.ultraProtection as Record<string, unknown> | undefined)?.autoModGuard as Record<string, unknown> | undefined)?.exemptRoleIds))
          ? ((((source.ultraProtection as Record<string, unknown> | undefined)?.autoModGuard as Record<string, unknown>).exemptRoleIds) as unknown[])
          : defaultConfig.ultraProtection.autoModGuard.exemptRoleIds,
        exemptChannelIds: Array.isArray((((source.ultraProtection as Record<string, unknown> | undefined)?.autoModGuard as Record<string, unknown> | undefined)?.exemptChannelIds))
          ? ((((source.ultraProtection as Record<string, unknown> | undefined)?.autoModGuard as Record<string, unknown>).exemptChannelIds) as unknown[])
          : defaultConfig.ultraProtection.autoModGuard.exemptChannelIds
      }
    }
  });
}
