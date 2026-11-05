import { ChannelType, Client, GatewayIntentBits, Partials } from "discord.js";

import {
  createLogger,
  recordServiceHeartbeat,
  createRedisClient,
  createSqlClient,
  getRuntimeEnv
} from "../../../packages/shared/src";
import { handleChannelDelete } from "./events/channel-delete";
import { handleGuildMemberUpdate } from "./events/guild-member-update";
import { handleMessageDelete, handleMessageDeleteBulk } from "./events/message-delete";
import { handleInteraction } from "./events/interaction-create";
import { handleMessageCreate } from "./events/message-create";
import { handleMessageUpdate } from "./events/message-update";
import { handleVoiceStateUpdate } from "./events/voice-state-update";
import { syncApplicationCommands } from "./lib/command-sync";
import { buildCommandDefinitions } from "./lib/register-commands";
import { ConfigStore } from "./services/config-store";
import { MemberService } from "./services/member-service";
import { ModerationCommandService } from "./services/moderation-command-service";
import { ModersonService } from "./services/moderson-service";
import { MessageSyncService } from "./services/message-sync-service";
import { ModerationService } from "./services/moderation-service";
import { PolicyService } from "./services/policy-service";
import { PresenceService } from "./services/presence-service";
import { GuardService } from "./services/guard-service";
import { RankService } from "./services/rank-service";
import { RoleChangeService } from "./services/role-change-service";
import { StaffMessageAuditService } from "./services/staff-message-audit-service";
import { TicketService } from "./services/ticket-service";
import { AutoModService } from "./services/automod-service";
import type { BotContext } from "./types";

async function createOptionalRedis(redisUrl: string, logger: ReturnType<typeof createLogger>) {
  if (!redisUrl) {
    return { redis: null, subscriber: null };
  }

  const redis = createRedisClient(redisUrl);
  const subscriber = redis.duplicate();
  const handleRedisError = (source: string) => (error: unknown) => {
    logger.warn({ error, source }, "Redis baglantisi kullanilamiyor. Bot Redis olmadan devam edecek.");
  };
  redis.on("error", handleRedisError("redis"));
  subscriber.on("error", handleRedisError("subscriber"));

  try {
    await Promise.race([
      Promise.all([redis.connect(), subscriber.connect()]),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Redis connection timed out.")), 2_500)
      )
    ]);
    return { redis, subscriber };
  } catch (error) {
    logger.warn({ error }, "Redis erisilemedi. Redis bagimli ozellikler devre disi kalacak.");
    redis.disconnect(false);
    subscriber.disconnect(false);
    return { redis: null, subscriber: null };
  }
}

async function main() {
  const env = getRuntimeEnv();
  const bootedAt = new Date();
  const logger = createLogger(env.logLevel);
  const sql = createSqlClient(env.databaseUrl);
  const { redis, subscriber } = await createOptionalRedis(env.redisUrl, logger);
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildModeration
    ],
    partials: [Partials.Channel, Partials.Message]
  });

  const configStore = new ConfigStore(sql, subscriber, logger);
  await configStore.init();

  const memberService = new MemberService(sql, logger, () => configStore.get());
  const modersonService = new ModersonService(sql, redis, logger, configStore, memberService);
  const moderationService = new ModerationService(sql, logger, memberService, () => configStore.get());
  const policyService = new PolicyService(sql, logger, () => configStore.get());
  const moderationCommandService = new ModerationCommandService(
    sql,
    logger,
    memberService,
    () => configStore.get(),
    policyService
  );
  const messageSyncService = new MessageSyncService(
    sql,
    logger,
    memberService,
    moderationService,
    env.timezone
  );
  const presenceService = new PresenceService(sql, logger, memberService, () => configStore.get());
  const ticketService = new TicketService(sql, logger, memberService, () => configStore.get());
  const guardService = new GuardService(
    sql,
    logger,
    memberService,
    () => configStore.get(),
    env.timezone
  );
  const rankService = new RankService(sql, logger, memberService, () => configStore.get());
  const roleChangeService = new RoleChangeService(sql, logger, memberService);
  const staffMessageAuditService = new StaffMessageAuditService(sql, logger, memberService);
  const autoModService = new AutoModService(client, logger);

  // Sync AutoMod on config change
  configStore.on("configChange", async (newConfig) => {
    try {
      const guild = await client.guilds.fetch(env.discordGuildId);
      if (guild) {
        await autoModService.syncGuildAutoMod(guild, newConfig);
      }
    } catch (e) {
      logger.error({ error: e }, "Failed to sync AutoMod on config change");
    }
  });

  const context: BotContext = {
    client,
    env,
    sql,
    redis,
    logger,
    configStore,
    memberService,
    modersonService,
    moderationCommandService,
    messageSyncService,
    presenceService,
    ticketService,
    moderationService,
    guardService,
    rankService,
    roleChangeService,
    staffMessageAuditService
  };

  client.once("ready", async () => {
    logger.info({ botUser: client.user?.tag }, "Discord bot connected.");
    const guild = await client.guilds.fetch(env.discordGuildId).then((value) => value.fetch());
    await recordServiceHeartbeat(sql, "bot", bootedAt, {
      guildId: env.discordGuildId,
      userTag: client.user?.tag ?? null
    });
    setInterval(async () => {
      try {
        await recordServiceHeartbeat(sql, "bot", bootedAt, {
          guildId: env.discordGuildId,
          userTag: client.user?.tag ?? null
        });
      } catch (error) {
        logger.error({ error }, "Bot heartbeat update failed.");
      }
    }, 30_000).unref();

    const commandDefinitions = buildCommandDefinitions();
    void (async () => {
      try {
        const syncResult = await syncApplicationCommands({
          token: env.discordToken,
          applicationId: env.discordClientId,
          guildId: env.discordGuildId,
          guildCommands: commandDefinitions
        });
        logger.info(
          {
            guildId: env.discordGuildId,
            commandCount: commandDefinitions.length,
            sync: syncResult
          },
          "Slash commands synchronized."
        );
      } catch (error) {
        logger.error({ error, guildId: env.discordGuildId }, "Slash command sync failed.");
      }
    })();

    await memberService.syncRoleCatalog(guild);
    await memberService.syncChannelCatalog(guild);
    await presenceService.syncGuild(guild);
    await guardService.maybeCreateAutoBackup(guild);
    await autoModService.syncGuildAutoMod(guild, configStore.get());
    messageSyncService.start(client);

    setInterval(async () => {
      try {
        await presenceService.reconcileGuild(guild);
        await moderationService.pollAuditLogs(guild);
        await guardService.pollAuditLogs(guild);
        await moderationCommandService.processExpiredJails(guild);
        await rankService.processPendingLevelEffects(guild);
        await rankService.processRewardSyncJobs(guild);
      } catch (error) {
        logger.error({ error }, "Audit log polling failed.");
      }
    }, 60_000).unref();
  });

  client.on("interactionCreate", async (interaction) => {
    try {
      await handleInteraction(interaction, context);
    } catch (error) {
      logger.error({ error, interactionId: interaction.id }, "Interaction handler failed.");
      if (interaction.isRepliable() && !interaction.replied) {
        if (interaction.deferred) {
          await interaction.editReply({
            content: "Islem sirasinda beklenmeyen bir hata olustu."
          });
        } else {
          await interaction.reply({
            content: "Islem sirasinda beklenmeyen bir hata olustu.",
            ephemeral: true
          });
        }
      }
    }
  });

  client.on("messageCreate", async (message) => {
    try {
      await handleMessageCreate(message, context);
    } catch (error) {
      logger.error({ error, messageId: message.id }, "Message handler failed.");
    }
    try {
      await guardService.handleMessageForInviteLink(message);
    } catch (error) {
      logger.error({ error, messageId: message.id }, "Invite/link guard failed.");
    }
  });

  client.on("messageUpdate", async (oldMessage, newMessage) => {
    try {
      await handleMessageUpdate(oldMessage, newMessage, context);
    } catch (error) {
      logger.error({ error, messageId: newMessage.id }, "Message update handler failed.");
    }
  });

  client.on("messageDelete", async (message) => {
    try {
      await handleMessageDelete(message, context);
    } catch (error) {
      logger.error({ error, messageId: message.id }, "Message delete handler failed.");
    }
    try {
      await guardService.handleMessageDeletedForNuke(message);
    } catch (error) {
      logger.error({ error, messageId: message.id }, "Message nuke guard failed.");
    }
  });

  client.on("messageDeleteBulk", async (messages, channel) => {
    try {
      await handleMessageDeleteBulk(messages, context);
    } catch (error) {
      logger.error({ error, messageCount: messages.size }, "Bulk message delete handler failed.");
    }
    try {
      const guild = "guild" in channel ? channel.guild : null;
      await guardService.handleMessageBulkDeletedForNuke(guild, messages.size);
    } catch (error) {
      logger.error({ error, messageCount: messages.size }, "Bulk message nuke guard failed.");
    }
  });

  client.on("voiceStateUpdate", async (oldState, newState) => {
    try {
      await handleVoiceStateUpdate(oldState, newState, context);
    } catch (error) {
      logger.error({ error, userId: newState.id || oldState.id }, "Voice state handler failed.");
    }
  });

  client.on("channelDelete", async (channel) => {
    try {
      if ("guild" in channel) {
        if (!channel.isThread()) {
          await guardService.handleChannelDelete(channel);
        }
        await memberService.syncChannelCatalog(channel.guild);
      }
      if (channel.type === ChannelType.GuildText) {
        await handleChannelDelete(channel, context);
      }
    } catch (error) {
      logger.error({ error, channelId: channel.id }, "Channel delete handler failed.");
    }
  });

  client.on("channelCreate", async (channel) => {
    if (!("guild" in channel)) {
      return;
    }

    try {
      if (!channel.isThread()) {
        await guardService.handleChannelCreate(channel);
      }
      await memberService.syncChannelCatalog(channel.guild);
    } catch (error) {
      logger.error({ error, channelId: channel.id }, "Channel create sync failed.");
    }
  });

  client.on("channelUpdate", async (_oldChannel, newChannel) => {
    if (!("guild" in newChannel)) {
      return;
    }

    try {
      if (!newChannel.isThread() && "guild" in _oldChannel && !_oldChannel.isThread()) {
        await guardService.handleChannelUpdate(_oldChannel, newChannel);
      }
      await memberService.syncChannelCatalog(newChannel.guild);
    } catch (error) {
      logger.error({ error, channelId: newChannel.id }, "Channel update sync failed.");
    }
  });

  client.on("guildMemberAdd", async (member) => {
    try {
      await guardService.handleBotAdd(member);
      if (!member.user.bot) {
        await memberService.syncMember(member);
      }
      await guardService.handleMemberJoinForRaid(member);
    } catch (error) {
      logger.error({ error, memberId: member.id }, "Guild member add handler failed.");
    }
  });

  client.on("roleCreate", async (role) => {
    try {
      await guardService.handleRoleCreate(role);
      await memberService.syncRoleCatalog(role.guild);
    } catch (error) {
      logger.error({ error, roleId: role.id }, "Role create guard failed.");
    }
  });

  client.on("roleDelete", async (role) => {
    try {
      await guardService.handleRoleDelete(role);
      await memberService.syncRoleCatalog(role.guild);
    } catch (error) {
      logger.error({ error, roleId: role.id }, "Role delete guard failed.");
    }
  });

  client.on("roleUpdate", async (oldRole, newRole) => {
    try {
      await guardService.handleRoleUpdate(oldRole, newRole);
      await memberService.syncRoleCatalog(newRole.guild);
    } catch (error) {
      logger.error({ error, roleId: newRole.id }, "Role update guard failed.");
    }
  });

  client.on("guildUpdate", async (oldGuild, newGuild) => {
    try {
      await guardService.handleGuildUpdate(oldGuild, newGuild);
    } catch (error) {
      logger.error({ error, guildId: newGuild.id }, "Guild update guard failed.");
    }
  });

  client.on("guildMemberUpdate", async (oldMember, newMember) => {
    if (newMember.partial) {
      return;
    }
    try {
      await handleGuildMemberUpdate(oldMember, newMember, context);
    } catch (error) {
      logger.error({ error, memberId: newMember.id }, "Guild member update handler failed.");
    }
  });

  client.on("roleCreate", async (role) => {
    try {
      await roleChangeService.handleRoleCreate(role);
      await memberService.syncRoleCatalog(role.guild);
    } catch (error) {
      logger.error({ error, guildId: role.guild.id }, "Role create sync failed.");
    }
  });

  client.on("roleDelete", async (role) => {
    try {
      await roleChangeService.handleRoleDelete(role);
      await memberService.syncRoleCatalog(role.guild);
    } catch (error) {
      logger.error({ error, guildId: role.guild.id }, "Role delete sync failed.");
    }
  });

  client.on("roleUpdate", async (oldRole, newRole) => {
    try {
      await roleChangeService.handleRoleUpdate(oldRole, newRole);
      await memberService.syncRoleCatalog(newRole.guild);
    } catch (error) {
      logger.error({ error, guildId: newRole.guild.id }, "Role update sync failed.");
    }
  });

  await client.login(env.discordToken);
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
