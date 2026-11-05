import type { GuildMember, Message, PartialMessage } from "discord.js";
import type { Logger } from "pino";
import type { Sql } from "postgres";

import type { MemberService } from "./member-service";

interface StaffMessageStateRow {
  message_id: string;
  guild_id: string;
  message_created_at: Date;
  channel_id: string;
  channel_name: string;
  author_id: string;
  author_display_name: string;
  author_avatar_url: string | null;
  content: string;
  attachment_urls: unknown;
}

export class StaffMessageAuditService {
  constructor(
    private readonly sql: Sql,
    private readonly logger: Logger,
    private readonly memberService: MemberService
  ) {}

  async trackMessageCreate(message: Message) {
    if (!message.inGuild() || message.author.bot || !message.member) {
      return;
    }

    if (this.memberService.getMemberType(message.member) !== "staff") {
      return;
    }

    await this.memberService.syncMember(message.member);
    await this.upsertState(message, message.member, null);
  }

  async handleMessageUpdate(oldMessage: Message | PartialMessage, newMessage: Message | PartialMessage) {
    const resolved = await this.resolveMessage(newMessage);
    if (!resolved?.inGuild() || resolved.author.bot) {
      return;
    }

    const member =
      resolved.member ?? (await resolved.guild.members.fetch(resolved.author.id).catch(() => null));
    if (!member || this.memberService.getMemberType(member) !== "staff") {
      return;
    }

    await this.memberService.syncMember(member);

    const state = await this.getState(resolved.id);
    const previousContent = state?.content ?? this.getMessageContent(oldMessage);
    const previousAttachments = state
      ? this.readAttachmentUrls(state.attachment_urls)
      : this.getAttachmentUrls(oldMessage);
    const nextContent = this.getMessageContent(resolved);
    const nextAttachments = this.getAttachmentUrls(resolved);

    if (
      previousContent === nextContent &&
      this.attachmentListsEqual(previousAttachments, nextAttachments)
    ) {
      await this.upsertState(resolved, member, resolved.editedAt ?? new Date());
      return;
    }

    await this.sql`
      INSERT INTO staff_message_events (
        guild_id,
        message_id,
        channel_id,
        channel_name,
        author_id,
        author_display_name,
        author_avatar_url,
        actor_id,
        actor_display_name,
        event_type,
        before_content,
        after_content,
        before_attachment_urls,
        after_attachment_urls,
        message_created_at
      )
      VALUES (
        ${resolved.guild.id},
        ${resolved.id},
        ${resolved.channelId},
        ${this.getChannelName(resolved)},
        ${member.id},
        ${member.displayName},
        ${member.displayAvatarURL()},
        ${member.id},
        ${member.displayName},
        'edit',
        ${previousContent || null},
        ${nextContent || null},
        CAST(${JSON.stringify(previousAttachments)} AS jsonb),
        CAST(${JSON.stringify(nextAttachments)} AS jsonb),
        ${state?.message_created_at ?? resolved.createdAt}
      )
    `;

    await this.upsertState(resolved, member, resolved.editedAt ?? new Date());
  }

  async handleMessageDelete(message: Message | PartialMessage) {
    if (!message.guildId) {
      return;
    }

    const state = await this.getState(message.id);
    if (!state) {
      return;
    }

    const attachmentUrls = this.readAttachmentUrls(state.attachment_urls);

    await this.sql`
      INSERT INTO staff_message_events (
        guild_id,
        message_id,
        channel_id,
        channel_name,
        author_id,
        author_display_name,
        author_avatar_url,
        actor_id,
        actor_display_name,
        event_type,
        before_content,
        after_content,
        before_attachment_urls,
        after_attachment_urls,
        message_created_at
      )
      VALUES (
        ${state.guild_id},
        ${state.message_id},
        ${state.channel_id},
        ${state.channel_name},
        ${state.author_id},
        ${state.author_display_name},
        ${state.author_avatar_url},
        ${state.author_id},
        ${state.author_display_name},
        'delete',
        ${state.content || null},
        ${null},
        CAST(${JSON.stringify(attachmentUrls)} AS jsonb),
        CAST(${JSON.stringify([])} AS jsonb),
        ${state.message_created_at}
      )
    `;

    await this.sql`
      UPDATE staff_message_states
      SET deleted_at = NOW()
      WHERE message_id = ${message.id}
    `;
  }

  private async resolveMessage(message: Message | PartialMessage) {
    if (!message.partial) {
      return message;
    }

    try {
      return await message.fetch();
    } catch (error) {
      this.logger.warn({ error, messageId: message.id }, "Partial message fetch failed.");
      return null;
    }
  }

  private async upsertState(message: Message, member: GuildMember, editedAt: Date | null) {
    await this.sql`
      INSERT INTO staff_message_states (
        message_id,
        guild_id,
        channel_id,
        channel_name,
        author_id,
        author_display_name,
        author_avatar_url,
        content,
        attachment_urls,
        message_created_at,
        last_edited_at,
        deleted_at
      )
      VALUES (
        ${message.id},
        ${message.guildId},
        ${message.channelId},
        ${this.getChannelName(message)},
        ${member.id},
        ${member.displayName},
        ${member.displayAvatarURL()},
        ${this.getMessageContent(message)},
        CAST(${JSON.stringify(this.getAttachmentUrls(message))} AS jsonb),
        ${message.createdAt},
        ${editedAt},
        ${null}
      )
      ON CONFLICT (message_id)
      DO UPDATE SET
        channel_id = EXCLUDED.channel_id,
        channel_name = EXCLUDED.channel_name,
        author_display_name = EXCLUDED.author_display_name,
        author_avatar_url = EXCLUDED.author_avatar_url,
        content = EXCLUDED.content,
        attachment_urls = EXCLUDED.attachment_urls,
        last_edited_at = COALESCE(EXCLUDED.last_edited_at, staff_message_states.last_edited_at),
        deleted_at = NULL,
        updated_at = NOW()
    `;
  }

  private async getState(messageId: string) {
    const [row] = await this.sql<StaffMessageStateRow[]>`
      SELECT
        message_id,
        guild_id,
        channel_id,
        channel_name,
        author_id,
        author_display_name,
        author_avatar_url,
        content,
        attachment_urls,
        message_created_at
      FROM staff_message_states
      WHERE message_id = ${messageId}
      LIMIT 1
    `;

    return row ?? null;
  }

  private getChannelName(message: Message | PartialMessage) {
    if ("name" in message.channel && typeof message.channel.name === "string") {
      return message.channel.name;
    }

    return "Bilinmeyen Kanal";
  }

  private getMessageContent(message: Message | PartialMessage | null) {
    if (!message || typeof message.content !== "string") {
      return "";
    }

    return message.content.trim();
  }

  private getAttachmentUrls(message: Message | PartialMessage | null) {
    if (!message) {
      return [];
    }

    return [...message.attachments.values()].map((attachment) => attachment.url).sort();
  }

  private readAttachmentUrls(value: unknown) {
    if (Array.isArray(value)) {
      return value.filter((item): item is string => typeof item === "string").sort();
    }

    if (typeof value === "string") {
      try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed)
          ? parsed.filter((item): item is string => typeof item === "string").sort()
          : [];
      } catch {
        return [];
      }
    }

    return [];
  }

  private attachmentListsEqual(left: string[], right: string[]) {
    if (left.length !== right.length) {
      return false;
    }

    return left.every((item, index) => item === right[index]);
  }
}
