import type { GuildMember, PartialGuildMember } from "discord.js";

import type { BotContext } from "../types";

export async function handleGuildMemberUpdate(
  oldMember: GuildMember | PartialGuildMember,
  newMember: GuildMember | PartialGuildMember,
  context: BotContext
) {
  if ("partial" in newMember && newMember.partial) {
    return;
  }

  if (!("partial" in oldMember) || !oldMember.partial) {
    await context.roleChangeService.handleMemberRoleUpdate(
      oldMember as GuildMember,
      newMember as GuildMember
    );
  }

  await context.memberService.syncMember(newMember as GuildMember);
}
