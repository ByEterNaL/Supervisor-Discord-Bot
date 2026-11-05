import { createCanvas, loadImage } from "@napi-rs/canvas";

import { compactXp } from "./command-ui";

interface RankTrackCard {
  key: "voice" | "text";
  label: string;
  level: number;
  totalXp: number;
  currentLevelXp: number;
  nextLevelXp: number;
  progressPercent: number;
  position: number | null;
}

interface RankCardInput {
  name: string;
  handle: string;
  memberLabel: string;
  avatarUrl: string | null;
  guildName: string;
  focusType: "ikisi" | "ses" | "metin";
  tracks: RankTrackCard[];
}

interface LeaderboardRowCard {
  position: number;
  name: string;
  avatarUrl: string | null;
  level: number;
  totalXp: number;
  progressPercent: number;
  isRequester: boolean;
}

interface LeaderboardCardInput {
  title: string;
  subtitle: string;
  guildName: string;
  rows: LeaderboardRowCard[];
}

const TRACK_THEME = {
  voice: {
    start: "#ffb056",
    end: "#ff6f61",
    glow: "rgba(255, 162, 83, 0.24)"
  },
  text: {
    start: "#70dfd1",
    end: "#4aa5ff",
    glow: "rgba(89, 208, 194, 0.24)"
  }
} as const;

function roundRectPath(
  ctx: ReturnType<ReturnType<typeof createCanvas>["getContext"]>,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
) {
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
  ctx.closePath();
}

function fillRoundedRect(
  ctx: ReturnType<ReturnType<typeof createCanvas>["getContext"]>,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  fillStyle: string | CanvasGradient
) {
  roundRectPath(ctx, x, y, width, height, radius);
  ctx.fillStyle = fillStyle;
  ctx.fill();
}

function strokeRoundedRect(
  ctx: ReturnType<ReturnType<typeof createCanvas>["getContext"]>,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  strokeStyle: string | CanvasGradient,
  lineWidth = 1
) {
  roundRectPath(ctx, x, y, width, height, radius);
  ctx.strokeStyle = strokeStyle;
  ctx.lineWidth = lineWidth;
  ctx.stroke();
}

function addBackdrop(ctx: ReturnType<ReturnType<typeof createCanvas>["getContext"]>, width: number, height: number) {
  const base = ctx.createLinearGradient(0, 0, width, height);
  base.addColorStop(0, "#081018");
  base.addColorStop(0.45, "#0d1722");
  base.addColorStop(1, "#111a26");
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, width, height);

  const orbA = ctx.createRadialGradient(width * 0.18, height * 0.16, 0, width * 0.18, height * 0.16, width * 0.28);
  orbA.addColorStop(0, "rgba(255, 163, 81, 0.28)");
  orbA.addColorStop(1, "rgba(255, 163, 81, 0)");
  ctx.fillStyle = orbA;
  ctx.fillRect(0, 0, width, height);

  const orbB = ctx.createRadialGradient(width * 0.84, height * 0.2, 0, width * 0.84, height * 0.2, width * 0.24);
  orbB.addColorStop(0, "rgba(89, 208, 194, 0.18)");
  orbB.addColorStop(1, "rgba(89, 208, 194, 0)");
  ctx.fillStyle = orbB;
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = "rgba(255, 255, 255, 0.035)";
  ctx.lineWidth = 1;
  for (let i = 0; i < 8; i += 1) {
    ctx.beginPath();
    ctx.moveTo(width * 0.58, height * (i / 8));
    ctx.lineTo(width, height * ((i + 1) / 8));
    ctx.stroke();
  }
}

function trimText(
  ctx: ReturnType<ReturnType<typeof createCanvas>["getContext"]>,
  text: string,
  maxWidth: number
) {
  if (ctx.measureText(text).width <= maxWidth) {
    return text;
  }

  let value = text;
  while (value.length > 1 && ctx.measureText(`${value}...`).width > maxWidth) {
    value = value.slice(0, -1);
  }
  return `${value}...`;
}

async function drawAvatar(
  ctx: ReturnType<ReturnType<typeof createCanvas>["getContext"]>,
  avatarUrl: string | null,
  label: string,
  x: number,
  y: number,
  size: number
) {
  ctx.save();
  roundRectPath(ctx, x, y, size, size, size / 2);
  ctx.clip();

  const fallback = ctx.createLinearGradient(x, y, x + size, y + size);
  fallback.addColorStop(0, "#ffb056");
  fallback.addColorStop(1, "#59d0c2");
  ctx.fillStyle = fallback;
  ctx.fillRect(x, y, size, size);

  if (avatarUrl) {
    try {
      const avatar = await loadImage(avatarUrl);
      ctx.drawImage(avatar, x, y, size, size);
    } catch {
      ctx.fillStyle = "rgba(8, 16, 24, 0.22)";
      ctx.fillRect(x, y, size, size);
    }
  }

  if (!avatarUrl) {
    ctx.fillStyle = "#081018";
    ctx.font = `700 ${Math.floor(size * 0.34)}px "Segoe UI"`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label.slice(0, 2).toUpperCase(), x + size / 2, y + size / 2);
  }

  ctx.restore();
  strokeRoundedRect(ctx, x - 2, y - 2, size + 4, size + 4, size / 2 + 2, "rgba(255,255,255,0.12)", 2);
}

function drawTrackCard(
  ctx: ReturnType<ReturnType<typeof createCanvas>["getContext"]>,
  track: RankTrackCard,
  x: number,
  y: number,
  width: number,
  height: number
) {
  const theme = TRACK_THEME[track.key];
  const cardGradient = ctx.createLinearGradient(x, y, x + width, y + height);
  cardGradient.addColorStop(0, "rgba(255,255,255,0.05)");
  cardGradient.addColorStop(1, "rgba(255,255,255,0.02)");
  fillRoundedRect(ctx, x, y, width, height, 28, cardGradient);
  strokeRoundedRect(ctx, x, y, width, height, 28, "rgba(255,255,255,0.08)");

  ctx.save();
  ctx.shadowColor = theme.glow;
  ctx.shadowBlur = 30;
  fillRoundedRect(ctx, x + 24, y + 22, width - 48, height - 44, 24, "rgba(255,255,255,0.015)");
  ctx.restore();

  ctx.fillStyle = "#9ab0bf";
  ctx.font = '600 26px "Segoe UI"';
  ctx.fillText(track.label.toUpperCase(), x + 34, y + 56);

  ctx.fillStyle = "#f6f1e8";
  ctx.font = '700 84px "Segoe UI"';
  ctx.fillText(`${track.level}`, x + 34, y + 152);

  ctx.font = '600 30px "Segoe UI"';
  ctx.fillStyle = "rgba(246, 241, 232, 0.9)";
  ctx.fillText("Seviye", x + 154, y + 148);

  ctx.fillStyle = "#d6dde4";
  ctx.font = '600 24px "Segoe UI"';
  ctx.fillText(`${compactXp(track.totalXp)} XP`, x + 34, y + 196);

  const pillWidth = 158;
  const pillGradient = ctx.createLinearGradient(x + width - pillWidth - 30, y + 28, x + width - 30, y + 78);
  pillGradient.addColorStop(0, theme.start);
  pillGradient.addColorStop(1, theme.end);
  fillRoundedRect(ctx, x + width - pillWidth - 30, y + 28, pillWidth, 46, 18, pillGradient);
  ctx.fillStyle = "#081018";
  ctx.font = '700 22px "Segoe UI"';
  ctx.textAlign = "center";
  ctx.fillText(`%${track.progressPercent}`, x + width - pillWidth / 2 - 30, y + 58);
  ctx.textAlign = "left";

  const barX = x + 34;
  const barY = y + height - 100;
  const barWidth = width - 68;
  fillRoundedRect(ctx, barX, barY, barWidth, 24, 12, "rgba(255,255,255,0.08)");
  const safeProgressPercent = Math.max(0, Math.min(100, track.progressPercent));
  const progressWidth = Math.floor((safeProgressPercent / 100) * barWidth);
  if (progressWidth > 0) {
    const barGradient = ctx.createLinearGradient(barX, barY, barX + barWidth, barY);
    barGradient.addColorStop(0, theme.start);
    barGradient.addColorStop(1, theme.end);
    fillRoundedRect(ctx, barX, barY, Math.max(18, progressWidth), 24, 12, barGradient);
  }

  ctx.fillStyle = "#9ab0bf";
  ctx.font = '600 20px "Segoe UI"';
  ctx.fillText(
    `${compactXp(track.currentLevelXp)} / ${compactXp(track.nextLevelXp)} XP`,
    barX,
    barY + 46
  );

  ctx.textAlign = "right";
  ctx.fillStyle = "#f6f1e8";
  ctx.font = '700 22px "Segoe UI"';
  ctx.fillText(
    track.position ? `Sıra #${track.position}` : "Sıra yok",
    x + width - 34,
    barY + 46
  );
  ctx.textAlign = "left";
}
export async function renderRankCard(input: RankCardInput) {
  const singleMode = input.focusType !== "ikisi";
  const width = 1380;
  const height = singleMode ? 620 : 780;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  addBackdrop(ctx, width, height);

  const shellGradient = ctx.createLinearGradient(30, 30, width - 30, height - 30);
  shellGradient.addColorStop(0, "rgba(255,255,255,0.06)");
  shellGradient.addColorStop(1, "rgba(255,255,255,0.025)");
  fillRoundedRect(ctx, 30, 28, width - 60, height - 56, 34, shellGradient);
  strokeRoundedRect(ctx, 30, 28, width - 60, height - 56, 34, "rgba(255,255,255,0.08)", 1.4);

  await drawAvatar(ctx, input.avatarUrl, input.name, 78, 76, 150);

  ctx.fillStyle = "#9cb1bf";
  ctx.font = '600 24px "Segoe UI"';
  ctx.fillText(input.guildName.toUpperCase(), 258, 104);

  ctx.fillStyle = "#f6f1e8";
  ctx.font = '700 62px "Segoe UI"';
  ctx.fillText(trimText(ctx, input.name, 700), 256, 176);

  ctx.fillStyle = "#b8c7d3";
  ctx.font = '600 28px "Segoe UI"';
  ctx.fillText(trimText(ctx, input.handle, 640), 258, 218);

  fillRoundedRect(ctx, 258, 244, 164, 46, 18, "rgba(255,255,255,0.08)");
  ctx.fillStyle = "#f6f1e8";
  ctx.font = '700 20px "Segoe UI"';
  ctx.textAlign = "center";
  ctx.fillText(input.memberLabel, 340, 273);
  ctx.textAlign = "left";

  const heroText = singleMode ? "Odak kart\u0131" : "\u00c7ift kulvar kart\u0131";
  fillRoundedRect(ctx, width - 254, 80, 176, 46, 18, "rgba(255,255,255,0.08)");
  ctx.fillStyle = "#9cb1bf";
  ctx.font = '700 18px "Segoe UI"';
  ctx.textAlign = "center";
  ctx.fillText(heroText, width - 166, 110);
  ctx.textAlign = "left";

  const visibleTracks =
    input.focusType === "ikisi"
      ? input.tracks
      : input.tracks.filter((item) => item.key === (input.focusType === "ses" ? "voice" : "text"));

  if (singleMode) {
    drawTrackCard(ctx, visibleTracks[0], 78, 336, width - 156, 224);
  } else {
    drawTrackCard(ctx, visibleTracks[0], 78, 336, (width - 190) / 2, 338);
    drawTrackCard(ctx, visibleTracks[1], 98 + (width - 190) / 2, 336, (width - 190) / 2, 338);
  }

  return canvas.encode("png");
}

async function drawLeaderboardRow(
  ctx: ReturnType<ReturnType<typeof createCanvas>["getContext"]>,
  row: LeaderboardRowCard,
  x: number,
  y: number,
  width: number
) {
  const baseFill = row.isRequester ? "rgba(255, 163, 81, 0.11)" : "rgba(255,255,255,0.04)";
  fillRoundedRect(ctx, x, y, width, 84, 24, baseFill);
  strokeRoundedRect(
    ctx,
    x,
    y,
    width,
    84,
    24,
    row.isRequester ? "rgba(255, 163, 81, 0.34)" : "rgba(255,255,255,0.08)",
    row.isRequester ? 1.6 : 1
  );

  const medalColors =
    row.position === 1
      ? ["#ffd879", "#ff9c4d"]
      : row.position === 2
        ? ["#d5e5ef", "#8fb0c6"]
        : row.position === 3
          ? ["#f6ba8f", "#f48b64"]
          : ["#2b3441", "#1c2530"];

  const rankGradient = ctx.createLinearGradient(x + 18, y + 18, x + 62, y + 62);
  rankGradient.addColorStop(0, medalColors[0]);
  rankGradient.addColorStop(1, medalColors[1]);
  fillRoundedRect(ctx, x + 16, y + 20, 48, 44, 18, rankGradient);

  ctx.fillStyle = row.position <= 3 ? "#081018" : "#dce6ee";
  ctx.font = '700 20px "Segoe UI"';
  ctx.textAlign = "center";
  ctx.fillText(`#${row.position}`, x + 40, y + 48);
  ctx.textAlign = "left";

  await drawAvatar(ctx, row.avatarUrl, row.name, x + 82, y + 12, 58);

  ctx.fillStyle = "#f6f1e8";
  ctx.font = '700 26px "Segoe UI"';
  ctx.fillText(trimText(ctx, row.name, width - 430), x + 158, y + 38);

  ctx.fillStyle = "#9ab0bf";
  ctx.font = '600 19px "Segoe UI"';
  ctx.fillText(`Seviye ${row.level} - %${row.progressPercent} ilerleme`, x + 158, y + 65);

  const valueGradient = ctx.createLinearGradient(x + width - 250, y + 14, x + width - 46, y + 52);
  valueGradient.addColorStop(0, "#70dfd1");
  valueGradient.addColorStop(1, "#4aa5ff");
  fillRoundedRect(ctx, x + width - 232, y + 14, 188, 38, 16, valueGradient);
  ctx.fillStyle = "#081018";
  ctx.font = '700 18px "Segoe UI"';
  ctx.textAlign = "center";
  ctx.fillText(`${compactXp(row.totalXp)} XP`, x + width - 138, y + 39);
  ctx.textAlign = "left";

  fillRoundedRect(ctx, x + width - 232, y + 54, 188, 10, 5, "rgba(255,255,255,0.08)");
  const safeProgressPercent = Math.max(0, Math.min(100, row.progressPercent));
  const progressWidth = Math.floor((safeProgressPercent / 100) * 188);
  if (progressWidth > 0) {
    const progressGradient = ctx.createLinearGradient(x + width - 232, y + 54, x + width - 44, y + 54);
    progressGradient.addColorStop(0, "#ffb056");
    progressGradient.addColorStop(1, "#ff6f61");
    fillRoundedRect(ctx, x + width - 232, y + 54, Math.max(18, progressWidth), 10, 5, progressGradient);
  }
}

export async function renderLeaderboardCard(input: LeaderboardCardInput) {
  const width = 1380;
  const rowHeight = 84;
  const rowGap = 18;
  const topOffset = 244;
  const bottomPadding = 90;
  const height = Math.max(560, topOffset + input.rows.length * (rowHeight + rowGap) + bottomPadding);
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  addBackdrop(ctx, width, height);
  fillRoundedRect(ctx, 30, 28, width - 60, height - 56, 34, "rgba(12, 20, 29, 0.78)");
  strokeRoundedRect(ctx, 30, 28, width - 60, height - 56, 34, "rgba(255,255,255,0.08)", 1.4);

  ctx.fillStyle = "#9cb1bf";
  ctx.font = '700 22px "Segoe UI"';
  ctx.fillText(input.guildName.toUpperCase(), 76, 92);

  ctx.fillStyle = "#f6f1e8";
  ctx.font = '700 58px "Segoe UI"';
  ctx.fillText(trimText(ctx, input.title, width - 220), 74, 156);

  ctx.fillStyle = "#b8c7d3";
  ctx.font = '600 24px "Segoe UI"';
  ctx.fillText(trimText(ctx, input.subtitle, width - 220), 76, 196);

  let rowY = topOffset;
  for (const row of input.rows) {
    await drawLeaderboardRow(ctx, row, 70, rowY, width - 140);
    rowY += rowHeight + rowGap;
  }

  return canvas.encode("png");
}

