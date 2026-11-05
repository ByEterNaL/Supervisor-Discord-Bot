import { getRuntimeEnv } from "../packages/shared/src";
import { syncApplicationCommands } from "../services/bot/src/lib/command-sync";
import { buildCommandDefinitions } from "../services/bot/src/lib/register-commands";

async function main() {
  const env = getRuntimeEnv();
  const definitions = buildCommandDefinitions();
  const result = await syncApplicationCommands({
    token: env.discordToken,
    applicationId: env.discordClientId,
    guildId: env.discordGuildId,
    guildCommands: definitions
  });

  // eslint-disable-next-line no-console
  console.log(
    "Command sync complete:",
    JSON.stringify(
      {
        total: definitions.length,
        global: result.global,
        guild: result.guild
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("Command sync failed:", error);
  process.exit(1);
});
