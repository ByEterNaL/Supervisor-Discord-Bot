import type { Message, PartialMessage } from "discord.js";

import type { BotContext } from "../types";

export async function handleMessageUpdate(
  oldMessage: Message | PartialMessage,
  newMessage: Message | PartialMessage,
  context: BotContext
) {
  await context.staffMessageAuditService.handleMessageUpdate(oldMessage, newMessage);
}
