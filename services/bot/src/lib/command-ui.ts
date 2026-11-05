import { EmbedBuilder, type APIEmbedField, type User } from "discord.js";

export type CommandTone = "accent" | "critical" | "warning" | "neutral" | "success";

const TONE_COLORS: Record<CommandTone, number> = {
  accent: 0xffa347,
  critical: 0xff5c7a,
  warning: 0xffb457,
  neutral: 0x59d0c2,
  success: 0x55d07b
};

const TONE_FOOTERS: Record<CommandTone, string> = {
  accent: "Supervisor Discord Bot • Komut Merkezi",
  critical: "Supervisor Discord Bot • Kritik İşlem",
  warning: "Supervisor Discord Bot • Dikkat Gerektirir",
  neutral: "Supervisor Discord Bot • Denetim Merkezi",
  success: "Supervisor Discord Bot • İşlem Tamamlandı"
};

interface CommandEmbedOptions {
  tone: CommandTone;
  title: string;
  description?: string;
  authorName?: string;
  authorIcon?: string | null;
  thumbnail?: string | null;
  image?: string | null;
  footer?: string;
  fields?: APIEmbedField[];
  timestamp?: Date;
}

export function commandColor(tone: CommandTone) {
  return TONE_COLORS[tone];
}

export function createCommandEmbed(options: CommandEmbedOptions) {
  const embed = new EmbedBuilder()
    .setColor(commandColor(options.tone))
    .setTitle(options.title)
    .setFooter({ text: options.footer ?? TONE_FOOTERS[options.tone] })
    .setTimestamp(options.timestamp ?? new Date());

  if (options.description) {
    embed.setDescription(options.description);
  }

  if (options.authorName) {
    embed.setAuthor({
      name: options.authorName,
      iconURL: options.authorIcon ?? undefined
    });
  }

  if (options.thumbnail) {
    embed.setThumbnail(options.thumbnail);
  }

  if (options.image) {
    embed.setImage(options.image);
  }

  if (options.fields?.length) {
    embed.addFields(options.fields);
  }

  return embed;
}

export function progressBar(percent: number, length = 14) {
  const safePercent = Math.max(0, Math.min(100, Math.floor(percent)));
  const filled = Math.round((safePercent / 100) * length);
  return `${"█".repeat(filled)}${"░".repeat(Math.max(0, length - filled))}`;
}

export function compactXp(value: number) {
  const safe = Math.max(0, Math.floor(value));
  if (safe >= 1_000_000) {
    return `${(safe / 1_000_000).toFixed(safe >= 10_000_000 ? 0 : 1)}M`;
  }
  if (safe >= 1_000) {
    return `${(safe / 1_000).toFixed(safe >= 10_000 ? 0 : 1)}K`;
  }
  return safe.toString();
}

export function memberDisplay(user: User) {
  return user.discriminator === "0" ? `@${user.username}` : user.tag;
}
