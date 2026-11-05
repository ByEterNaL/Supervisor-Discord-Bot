import { config as loadDotEnv } from "dotenv";
import { existsSync, readFileSync } from "fs";
import path from "path";
import { z } from "zod";

import { RuntimeEnv } from "./types";

loadDotEnv();

const settingsFileSchema = z.object({
  discord: z
    .object({
      token: z.string().default(""),
      clientId: z.string().default(""),
      guildId: z.string().default(""),
      ownerId: z.string().nullable().default(null)
    })
    .default({
      token: "",
      clientId: "",
      guildId: "",
      ownerId: null
    }),
  runtime: z
    .object({
      databaseUrl: z.string().default("postgres://postgres:postgres@localhost:5432/discord_supervisor"),
      redisUrl: z.string().default(""),
      timezone: z.string().default("Europe/Istanbul"),
      logLevel: z.string().default("info")
    })
    .default({
      databaseUrl: "postgres://postgres:postgres@localhost:5432/discord_supervisor",
      redisUrl: "",
      timezone: "Europe/Istanbul",
      logLevel: "info"
    }),
  panel: z
    .object({
      host: z.string().default("127.0.0.1"),
      port: z.number().int().positive().default(8000)
    })
    .default({
      host: "127.0.0.1",
      port: 8000
    })
});

function loadSettingsFile() {
  const settingsPath = path.resolve(process.cwd(), "settings.json");
  if (!existsSync(settingsPath)) {
    return settingsFileSchema.parse({});
  }

  const rawFile = readFileSync(settingsPath, "utf8");
  return settingsFileSchema.parse(JSON.parse(rawFile));
}

function normalizeRedisUrl(value: string | undefined) {
  if (!value) {
    return "";
  }

  const normalized = value.trim();
  if (!normalized) {
    return "";
  }

  const lowerCased = normalized.toLowerCase();
  if (lowerCased === "disabled" || lowerCased === "none" || lowerCased === "off") {
    return "";
  }

  return normalized;
}

const envSchema = z.object({
  discordToken: z.string().min(1),
  discordClientId: z.string().min(1),
  discordGuildId: z.string().min(1),
  ownerId: z.string().nullable(),
  databaseUrl: z.string().min(1),
  redisUrl: z.string(),
  timezone: z.string().default("Europe/Istanbul"),
  logLevel: z.string().default("info"),
  panelHost: z.string().default("127.0.0.1"),
  panelPort: z.coerce.number().int().positive().default(8000)
});

export function getRuntimeEnv(): RuntimeEnv {
  const settings = loadSettingsFile();
  const env = envSchema.parse({
    discordToken: process.env.DISCORD_TOKEN ?? settings.discord.token,
    discordClientId: process.env.DISCORD_CLIENT_ID ?? settings.discord.clientId,
    discordGuildId: process.env.DISCORD_GUILD_ID ?? settings.discord.guildId,
    ownerId: process.env.OWNER_ID ?? settings.discord.ownerId,
    databaseUrl: process.env.DATABASE_URL ?? settings.runtime.databaseUrl,
    redisUrl: normalizeRedisUrl(process.env.REDIS_URL ?? settings.runtime.redisUrl),
    timezone: process.env.SUPERVISOR_TIMEZONE ?? settings.runtime.timezone,
    logLevel: process.env.LOG_LEVEL ?? settings.runtime.logLevel,
    panelHost: process.env.PANEL_HOST ?? settings.panel.host,
    panelPort: process.env.PANEL_PORT ?? settings.panel.port
  });

  return {
    discordToken: env.discordToken,
    discordClientId: env.discordClientId,
    discordGuildId: env.discordGuildId,
    ownerId: env.ownerId,
    databaseUrl: env.databaseUrl,
    redisUrl: env.redisUrl,
    timezone: env.timezone,
    logLevel: env.logLevel,
    panelHost: env.panelHost,
    panelPort: env.panelPort
  };
}
