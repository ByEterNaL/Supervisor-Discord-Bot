import type { Message } from "discord.js";

import type { BotContext } from "../types";

export async function handleMessageCreate(message: Message, context: BotContext) {
  if (!message.guildId) {
    return;
  }

  if (!message.author.bot) {
    if (message.member) {
      await context.memberService.syncMember(message.member);
    }
    await context.messageSyncService.trackServerMessage(message);
    await context.staffMessageAuditService.trackMessageCreate(message);

    const config = context.configStore.get();
    
    // Check for banned words
    if (config.bannedWords && config.bannedWords.length > 0) {
      const channelRules = config.bannedWords.filter(rule => rule.channelId === message.channelId);
      if (channelRules.length > 0) {
        const messageContentLower = message.content.toLowerCase();
        for (const rule of channelRules) {
          if (!rule.words || rule.words.length === 0) continue;
          
          // Regex oluşturarak Event Loop (ReDoS) yükünü hafifletiyoruz.
          const pattern = rule.words
            .map(w => w.toLowerCase().trim())
            .filter(Boolean)
            .map(w => w.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&'))
            .join('|');
            
          if (!pattern) continue;
          const regex = new RegExp(`(${pattern})`, 'i');
          
          const hasBannedWord = regex.test(messageContentLower);

          if (hasBannedWord) {
            try {
              await message.delete();
              return; // Stop further processing if deleted
            } catch (error) {
              console.error(`Gereksiz kelime silinemedi (ID: ${message.id}):`, error);
            }
          }
        }
      }
    }

    await context.rankService.handleMessageXp(message);
    await context.moderationService.handleChannelAnalysisMessage(message);

    try {
      await context.guardService.handleMessageForInviteLink(message);
    } catch (error) {
      console.error(`Invite link guard failed (msg: ${message.id}):`, error);
    }

    if (
      config.unproven.proofChannelId &&
      message.channelId === config.unproven.proofChannelId &&
      message.author &&
      message.guild
    ) {
      const member = message.member ?? await message.guild.members.fetch(message.author.id).catch(() => null);
      if (member) {
        const hasTargetRole = config.unproven.targetRoleIds.some((roleId) =>
          member.roles.cache.has(roleId)
        );

        if (hasTargetRole) {
        await context.sql`
          INSERT INTO moderation_proof_messages (
            guild_id,
            channel_id,
            message_id,
            author_id,
            created_at
          )
          VALUES (
            ${message.guildId},
            ${message.channelId},
            ${message.id},
            ${message.author.id},
            ${message.createdAt}
          )
          ON CONFLICT (message_id) DO NOTHING
        `;
        }
      }
    }
  }

  await context.ticketService.logTicketMessage({
    guildId: message.guildId,
    channelId: message.channelId,
    messageId: message.id,
    authorId: message.author.bot ? null : message.author.id,
    authorType: message.author.bot
      ? "system"
      : message.member
        ? context.memberService.getMemberType(message.member)
        : "user",
    contentLength: message.content.length
  });
}
