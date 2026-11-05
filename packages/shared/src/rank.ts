import type {
  RankCurveConfig,
  RankRewardEntry,
  RankRewardRoleMode,
  RankXpType
} from "./types";

export interface RankProgress {
  level: number;
  totalXp: number;
  currentLevelXp: number;
  nextLevelXp: number;
  progressPercent: number;
}

export function xpForNextLevel(level: number, curve: RankCurveConfig) {
  const safeLevel = Math.max(level, 0);
  return Math.max(
    1,
    Math.floor(
      curve.baseXp + curve.linearXp * safeLevel + curve.quadraticXp * safeLevel * safeLevel
    )
  );
}

export function levelFromXp(totalXp: number, curve: RankCurveConfig) {
  let xp = Math.max(0, Math.floor(totalXp));
  let level = 0;

  while (xp >= xpForNextLevel(level, curve)) {
    xp -= xpForNextLevel(level, curve);
    level += 1;
  }

  return level;
}

export function rankProgress(totalXp: number, curve: RankCurveConfig): RankProgress {
  const safeTotalXp = Math.max(0, Math.floor(totalXp));
  let remainingXp = safeTotalXp;
  let level = 0;

  while (remainingXp >= xpForNextLevel(level, curve)) {
    remainingXp -= xpForNextLevel(level, curve);
    level += 1;
  }

  const nextLevelXp = xpForNextLevel(level, curve);
  const progressPercent = nextLevelXp > 0 ? Math.min(100, Math.floor((remainingXp / nextLevelXp) * 100)) : 0;

  return {
    level,
    totalXp: safeTotalXp,
    currentLevelXp: remainingXp,
    nextLevelXp,
    progressPercent
  };
}

export function resolveRewardRoleIds(
  level: number,
  rewards: RankRewardEntry[],
  roleMode: RankRewardRoleMode
) {
  const normalizedRewards = [...rewards]
    .filter((item) => item.level > 0 && item.roleId)
    .sort((left, right) => left.level - right.level);

  if (roleMode === "stacking") {
    return normalizedRewards
      .filter((item) => item.level <= level)
      .map((item) => item.roleId);
  }

  const highest = [...normalizedRewards].reverse().find((item) => item.level <= level);
  return highest ? [highest.roleId] : [];
}

export function rankTypeLabel(type: RankXpType) {
  return type === "voice" ? "Ses" : "Metin";
}
