import type { VoiceState } from "discord.js";

import type { BotContext } from "../types";

export async function handleVoiceStateUpdate(
  oldState: VoiceState,
  newState: VoiceState,
  context: BotContext
) {
  await context.presenceService.handleVoiceStateUpdate(oldState, newState);
}

