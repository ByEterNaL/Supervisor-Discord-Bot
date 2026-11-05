export type MemberType = "staff" | "user";
export type PresenceSessionType = "voice" | "camera" | "stream";
export type MetricPeriod = "day" | "week" | "month";

export interface RoleConfig {
  staffRoleIds: string[];
  upperStaffRoleIds: string[];
  supervisorRoleIds: string[];
  banRoleIds: string[];
  kickRoleIds: string[];
  unbanRoleIds: string[];
  timeoutRoleIds: string[];
  warnRoleIds: string[];
  jailRoleIds: string[];
  messageModerationRoleIds: string[];
  channelModerationRoleIds: string[];
  historyRoleIds: string[];
  ticketRoleIds: string[];
}

export interface VoiceConfig {
  afkChannelId: string | null;
  ignoredChannelIds: string[];
  ignoredCategoryIds: string[];
}

export interface TicketConfig {
  panelChannelIds: string[];
  activeCategoryMode: "auto" | "manual";
  categoryParentId: string | null;
  archiveCategoryMode: "auto" | "manual";
  archiveCategoryId: string | null;
  embedImageUrl: string;
  embedTitle: string;
  embedDescription: string;
  welcomeTitle: string;
  welcomeDescription: string;
  joinWelcomeTitle: string;
  joinWelcomeDescription: string;
  onboardingQuestion: string;
  onboardingYesLabel: string;
  onboardingNoLabel: string;
  callCooldownSeconds: number;
}

export interface AlertConfig {
  staleTicketMinutes: number;
  unclaimedTicketMinutes: number;
  openTicketThreshold: number;
}

export interface UnprovenConfig {
  targetRoleIds: string[];
  proofChannelId: string | null;
}

export interface BannedWordConfig {
  id: string;
  channelId: string;
  words: string[];
}

export interface ChannelAnalysisRuleConfig {
  id: string;
  channelId: string;
  maxMessagesPerHour: number;
  timeoutMinutes: number;
}

export interface ChannelAnalysisConfig {
  rules: ChannelAnalysisRuleConfig[];
}

export interface ProtectionIdentityConfig {
  userIds: string[];
  roleIds: string[];
}

export interface GuardScheduleConfig {
  enabled: boolean;
  startHour: number;
  endHour: number;
}

export type GuardSeverityOverride = "inherit" | "info" | "warning" | "critical";
export type GuardActionTier =
  | "log"
  | "warn"
  | "timeout"
  | "quarantine"
  | "kick"
  | "ban";

export interface GuardAdvancedConfig {
  logOnly: boolean;
  severityOverride: GuardSeverityOverride;
  auditWindowSeconds: number;
  whitelistRoleIds: string[];
  cooldownSeconds: number;
  actionTier: GuardActionTier;
}

export interface GuardFeatureConfig extends GuardAdvancedConfig {
  enabled: boolean;
  quarantine: boolean;
}

export interface ChannelGuardConfig extends GuardFeatureConfig {
  restoreOnDelete: boolean;
}

export interface CategoryGuardConfig extends GuardFeatureConfig {
  restoreOnDelete: boolean;
}

export interface BulkActionGuardConfig extends GuardFeatureConfig {
  windowSeconds: number;
  maxActions: number;
}

export interface BotGuardConfig extends GuardFeatureConfig {
  kickUnauthorizedBots: boolean;
  allowedBotIds: string[];
}

export type RoleGuardRestrictedPermission =
  | "Administrator"
  | "ManageGuild"
  | "ManageRoles"
  | "ManageChannels"
  | "ManageWebhooks"
  | "ManageGuildExpressions"
  | "BanMembers"
  | "KickMembers"
  | "ModerateMembers"
  | "MentionEveryone";

export interface RoleGuardConfig extends GuardFeatureConfig {
  restrictedPermissions: RoleGuardRestrictedPermission[];
  autoDeleteRiskyNewRoles: boolean;
  protectedRoleIds: string[];
}

export type AntiRaidAction = "quarantine" | "kick" | "ban";

export interface AntiRaidGuardConfig extends GuardFeatureConfig {
  windowSeconds: number;
  joinThreshold: number;
  minAccountAgeDays: number;
  raidAction: AntiRaidAction;
  raidModeCooldownMinutes: number;
}

export type InviteLinkAction = "delete" | "timeout" | "quarantine";

export interface InviteLinkGuardConfig extends GuardFeatureConfig {
  blockDiscordInvites: boolean;
  allowedDomains: string[];
  exemptChannelIds: string[];
  actionOnViolation: InviteLinkAction;
}

export interface MessageNukeGuardConfig extends GuardFeatureConfig {
  windowSeconds: number;
  deleteThreshold: number;
  bulkDeleteThreshold: number;
}

export type SettingsRollbackField =
  | "name"
  | "iconUrl"
  | "bannerUrl"
  | "verificationLevel"
  | "explicitContentFilter"
  | "defaultMessageNotifications"
  | "systemChannelId"
  | "rulesChannelId"
  | "publicUpdatesChannelId";

export interface SettingsRollbackGuardConfig {
  enabled: boolean;
  rollbackFields: SettingsRollbackField[];
  cooldownSeconds: number;
}

export interface ServerBackupConfig {
  enabled: boolean;
  autoCreateOnBoot: boolean;
}

export interface RankCurveConfig {
  baseXp: number;
  linearXp: number;
  quadraticXp: number;
}

export interface RankLeaderboardConfig {
  panelPageSize: number;
  commandTopSize: number;
}

export interface RankTextConfig {
  enabled: boolean;
  xpPerEligibleMessage: number;
  cooldownSeconds: number;
  minNormalizedLength: number;
  duplicateWindowMinutes: number;
  hourlyEligibleCap: number;
  ignoredChannelIds: string[];
  ignoredCategoryIds: string[];
}

export interface RankVoiceConfig {
  enabled: boolean;
  xpPerActiveMinute: number;
  minAwardChunkSeconds: number;
}

export interface RankRewardEntry {
  level: number;
  roleId: string;
}

export type RankRewardRoleMode = "highest_only" | "stacking";
export type RankXpType = "voice" | "text";

export interface RankRewardsConfig {
  roleRewardsEnabled: boolean;
  levelUpMessagesEnabled: boolean;
  announcementChannelId: string | null;
  roleMode: RankRewardRoleMode;
  voiceRewards: RankRewardEntry[];
  textRewards: RankRewardEntry[];
}

export interface RankSystemConfig {
  enabled: boolean;
  curve: RankCurveConfig;
  leaderboard: RankLeaderboardConfig;
  text: RankTextConfig;
  voice: RankVoiceConfig;
  rewards: RankRewardsConfig;
}

export type ModerationActionType =
  | "ban"
  | "unban"
  | "kick"
  | "timeout"
  | "untimeout"
  | "softban"
  | "warn"
  | "unwarn"
  | "jail"
  | "unjail"
  | "purge"
  | "lock"
  | "unlock"
  | "slowmode";

export type RolePolicyCapability =
  | ModerationActionType
  | "guard_quarantine"
  | "guard_restore"
  | "guard_log";

export interface RolePolicyLimit {
  actionType: ModerationActionType | "purge";
  maxDaily: number;
}

export interface RolePolicyConfig {
  roleId: string;
  label: string;
  capabilities: RolePolicyCapability[];
  dailyLimits: RolePolicyLimit[];
  autoPunishOnLimit: boolean;
  cooldownSeconds: number;
}

export type ModerationCaseType = ModerationActionType;
export type ModerationTargetType = "member" | "channel";
export type ModerationCaseStatus =
  | "pending"
  | "active"
  | "completed"
  | "removed"
  | "cancelled"
  | "failed"
  | "expired";

export interface ModerationConfig {
  jailRoleId: string | null;
  mutedRoleId: string | null;
  logChannelId: string | null;
  defaultDmEnabled: boolean;
  defaultTimeoutMinutes: number;
  defaultWarnPoints: number;
  purgeMaxLimit: number;
  safeFlowEnabled: boolean;
  globalBanEnabled: boolean;
  roleLimits: LimitConfigEntry[];
  userLimits: LimitConfigEntry[];
  rolePolicies: RolePolicyConfig[];
  strictRoleOnly: boolean;
  adminWhitelistUserIds: string[];
}

export interface ModerationLimit {
  actionType: ModerationActionType;
  maxDaily: number;
}

export interface LimitConfigEntry {
  targetId: string;
  limits: ModerationLimit[];
}

export interface AutoModGuardConfig {
  enabled: boolean;
  blockLinks: boolean;
  blockInvites: boolean;
  blockProfanity: boolean;
  blockSpam: boolean;
  blockMassMentions: boolean;
  massMentionThreshold: number;
  blockStaffMentions: boolean;
  exemptRoleIds: string[];
  exemptChannelIds: string[];
  actionType: "block" | "timeout" | "alert";
  timeoutMinutes: number;
  alertChannelId: string | null;
}

export interface UltraProtectionConfig {
  enabled: boolean;
  quarantineRoleId: string | null;
  whitelist: ProtectionIdentityConfig;
  blacklist: ProtectionIdentityConfig;
  schedule: GuardScheduleConfig;
  channelGuard: ChannelGuardConfig;
  categoryGuard: CategoryGuardConfig;
  webhookGuard: GuardFeatureConfig;
  botGuard: BotGuardConfig;
  guildSettingsGuard: GuardFeatureConfig;
  bulkActionGuard: BulkActionGuardConfig;
  manualActionGuard: GuardFeatureConfig;
  roleGuard: RoleGuardConfig;
  antiRaidGuard: AntiRaidGuardConfig;
  inviteLinkGuard: InviteLinkGuardConfig;
  messageNukeGuard: MessageNukeGuardConfig;
  settingsRollbackGuard: SettingsRollbackGuardConfig;
  serverBackup: ServerBackupConfig;
  autoModGuard: AutoModGuardConfig;
}

export interface SupervisorConfig {
  roles: RoleConfig;
  voice: VoiceConfig;
  ticket: TicketConfig;
  alerts: AlertConfig;
  unproven: UnprovenConfig;
  bannedWords: BannedWordConfig[];
  channelAnalysis: ChannelAnalysisConfig;
  rankSystem: RankSystemConfig;
  moderation: ModerationConfig;
  ultraProtection: UltraProtectionConfig;
}

export interface RuntimeEnv {
  discordToken: string;
  discordClientId: string;
  discordGuildId: string;
  ownerId: string | null;
  databaseUrl: string;
  redisUrl: string;
  timezone: string;
  logLevel: string;
  panelHost: string;
  panelPort: number;
}
