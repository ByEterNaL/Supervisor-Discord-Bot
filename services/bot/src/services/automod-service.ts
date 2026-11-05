import {
  Client,
  Guild,
  AutoModerationRuleEventType,
  AutoModerationRuleTriggerType,
  AutoModerationActionType,
  AutoModerationRuleKeywordPresetType,
  AutoModerationRuleCreateOptions,
  AutoModerationActionOptions
} from "discord.js";
import type { Logger } from "pino";
import type { SupervisorConfig } from "../../../../packages/shared/src";

const RULE_PREFIX = "Supervisor_AutoMod_";

export class AutoModService {
  constructor(private client: Client, private logger: Logger) {}

  public async syncGuildAutoMod(guild: Guild, config: SupervisorConfig) {
    const am = config.ultraProtection?.autoModGuard;
    if (!am) return;

    try {
      const existingRules = await guild.autoModerationRules.fetch();
      
      // Determine what actions to apply based on config
      const actions: AutoModerationActionOptions[] = [];
      if (am.actionType === "block" || am.actionType === "timeout") {
        actions.push({ type: AutoModerationActionType.BlockMessage });
      }
      if (am.actionType === "timeout") {
        actions.push({
          type: AutoModerationActionType.Timeout,
          metadata: { durationSeconds: Math.min(am.timeoutMinutes * 60, 2419200) } // max 28 days
        });
      }
      if (am.alertChannelId) {
        actions.push({
          type: AutoModerationActionType.SendAlertMessage,
          metadata: { channel: am.alertChannelId }
        });
      }

      // Base properties for all our rules
      const baseRule = {
        eventType: AutoModerationRuleEventType.MessageSend,
        actions,
        enabled: am.enabled,
        exemptRoles: am.exemptRoleIds || [],
        exemptChannels: am.exemptChannelIds || []
      };

      const desiredRules = new Map<string, AutoModerationRuleCreateOptions>();

      if (am.enabled) {
        if (am.blockLinks) {
          desiredRules.set(`${RULE_PREFIX}Links`, {
            ...baseRule,
            name: `${RULE_PREFIX}Links`,
            triggerType: AutoModerationRuleTriggerType.Keyword,
            triggerMetadata: {
              regexPatterns: [
                "(?:https?://)[a-zA-Z0-9-]+\\.[a-zA-Z0-9-]+",
                "[a-zA-Z0-9-]+\\.(?:com|net|org|gg|me|io|co|xyz|info|tr)(?:/|\\b)",
                "\\b(?:com|gg|net|org)\\s*/\\s*\\S+",
                "\\.(?:com|gg|net|org)\\s*/\\s*\\S+"
              ]
            }
          });
        }

        if (am.blockInvites && !am.blockLinks) { // if blockLinks is true, invites are blocked anyway
          desiredRules.set(`${RULE_PREFIX}Invites`, {
            ...baseRule,
            name: `${RULE_PREFIX}Invites`,
            triggerType: AutoModerationRuleTriggerType.Keyword,
            triggerMetadata: {
              regexPatterns: [
                "(?:https?://)?(?:discord(?:app)?\\.(?:com/invite|gg)/[a-zA-Z0-9]+)",
                "discord\\s*\\.\\s*gg\\s*/\\s*[a-zA-Z0-9]+",
                "discord\\s*app\\s*\\.\\s*com\\s*/\\s*invite\\s*/\\s*[a-zA-Z0-9]+"
              ]
            }
          });
        }

        if (am.blockProfanity) {
          desiredRules.set(`${RULE_PREFIX}Profanity`, {
            ...baseRule,
            name: `${RULE_PREFIX}Profanity`,
            triggerType: AutoModerationRuleTriggerType.KeywordPreset,
            triggerMetadata: {
              presets: [
                AutoModerationRuleKeywordPresetType.Profanity,
                AutoModerationRuleKeywordPresetType.SexualContent,
                AutoModerationRuleKeywordPresetType.Slurs
              ]
            }
          });
        }

        if (am.blockSpam) {
          desiredRules.set(`${RULE_PREFIX}Spam`, {
            ...baseRule,
            name: `${RULE_PREFIX}Spam`,
            triggerType: AutoModerationRuleTriggerType.Spam
          });
        }

        if (am.blockMassMentions) {
          desiredRules.set(`${RULE_PREFIX}Mentions`, {
            ...baseRule,
            name: `${RULE_PREFIX}Mentions`,
            triggerType: AutoModerationRuleTriggerType.MentionSpam,
            triggerMetadata: {
              mentionTotalLimit: am.massMentionThreshold
            }
          });
        }

        if (am.blockStaffMentions) {
          const staffRoles = [
            ...(config.roles.staffRoleIds || []),
            ...(config.roles.upperStaffRoleIds || []),
            ...(config.roles.supervisorRoleIds || [])
          ];
          if (staffRoles.length > 0) {
            desiredRules.set(`${RULE_PREFIX}StaffMentions`, {
              ...baseRule,
              name: `${RULE_PREFIX}StaffMentions`,
              triggerType: AutoModerationRuleTriggerType.Keyword,
              triggerMetadata: {
                keywordFilter: staffRoles.map(id => `*<@&${id}>*`).slice(0, 1000) // limit keyword count to discord limits
              }
            });
          }
        }
      }

      // Reconcile
      for (const [id, existing] of existingRules) {
        if (!existing.name.startsWith(RULE_PREFIX)) continue; // Don't touch rules we don't manage

        const desired = desiredRules.get(existing.name);
        if (!desired) {
          await existing.delete();
          this.logger.info({ guildId: guild.id, rule: existing.name }, "Deleted old AutoMod rule");
        } else {
          await existing.edit({ ...desired, reason: "AutoMod Guard config updated" });
          desiredRules.delete(existing.name); // Mark as done
        }
      }

      // Create remaining
      for (const [name, desired] of desiredRules) {
        await guild.autoModerationRules.create({ ...desired, name, reason: "AutoMod Guard initialized" });
        this.logger.info({ guildId: guild.id, rule: name }, "Created new AutoMod rule");
      }

    } catch (error) {
      this.logger.error({ error, guildId: guild.id }, "Failed to sync AutoMod rules");
    }
  }
}
