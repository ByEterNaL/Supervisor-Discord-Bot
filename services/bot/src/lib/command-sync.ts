import { REST, Routes } from "discord.js";

interface SyncCommandDefinition {
  type?: number;
  name: string;
  description?: string;
  options?: any[];
  default_member_permissions?: string | null;
  dm_permission?: boolean;
  nsfw?: boolean;
}

export interface SyncCommandsResult {
  global: { created: number; updated: number; deleted: number; unchanged: number };
  guild: { created: number; updated: number; deleted: number; unchanged: number };
}

export async function syncApplicationCommands(params: {
  token: string;
  applicationId: string;
  guildId: string;
  guildCommands: SyncCommandDefinition[];
}) {
  const rest = new REST({ version: "10" }).setToken(params.token);
  const globalListRoute = Routes.applicationCommands(params.applicationId);
  const guildListRoute = Routes.applicationGuildCommands(params.applicationId, params.guildId);

  // Optionally wipe out global commands so there's no duplication, 
  // since the user wants them in the server (Guild) specifically.
  const globalObj = await rest.put(globalListRoute, { body: [] }) as any[];
  
  // Set all commands for the guild at once
  const guildObj = await rest.put(guildListRoute, { body: params.guildCommands }) as any[];

  return {
    global: { created: 0, updated: 0, deleted: globalObj?.length || 0, unchanged: 0 },
    guild: { created: guildObj?.length || 0, updated: 0, deleted: 0, unchanged: 0 }
  } satisfies SyncCommandsResult;
}
