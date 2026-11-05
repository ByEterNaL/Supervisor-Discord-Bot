import type { Message, PartialMessage, ReadonlyCollection, Snowflake } from "discord.js";

import type { BotContext } from "../types";

export async function handleMessageDelete(
  message: Message | PartialMessage,
  context: BotContext
) {
  await context.staffMessageAuditService.handleMessageDelete(message);
}

export async function handleMessageDeleteBulk(
  messages: ReadonlyCollection<Snowflake, Message | PartialMessage>,
  context: BotContext
) {
  for (const message of messages.values()) {
    await context.staffMessageAuditService.handleMessageDelete(message);
  }
}
