import type { GuildChannel } from "discord.js";

import type { BotContext } from "../types";

export async function handleChannelDelete(channel: GuildChannel, context: BotContext) {
  await context.ticketService.markDeleted(channel.id);
}

