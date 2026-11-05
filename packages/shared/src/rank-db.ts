import type { Sql } from "postgres";

import { levelFromXp } from "./rank";
import type { MemberType, RankCurveConfig, RankXpType } from "./types";

export interface ApplyRankXpInput {
  guildId: string;
  userId: string;
  memberType: MemberType;
  xpType: RankXpType;
  xpDelta: number;
  sourceType: string;
  sourceRef?: string | null;
  payload?: Record<string, unknown>;
  createdAt?: Date;
}

export interface ApplyRankXpResult {
  applied: boolean;
  oldLevel: number;
  newLevel: number;
  oldXp: number;
  newXp: number;
  memberType: MemberType;
}

interface RankProfileRow {
  member_type: MemberType;
  voice_xp: number | string;
  text_xp: number | string;
  voice_level: number | string;
  text_level: number | string;
}

function toSafeInt(value: number | string | null | undefined) {
  const numeric = typeof value === "string" ? Number(value) : (value ?? 0);
  if (!Number.isFinite(numeric)) {
    return 0;
  }

  return Math.max(0, Math.floor(numeric));
}

export async function applyRankXp(
  sql: Sql,
  curve: RankCurveConfig,
  input: ApplyRankXpInput
): Promise<ApplyRankXpResult> {
  const xpDelta = Math.max(0, Math.floor(input.xpDelta));
  if (xpDelta <= 0) {
    return {
      applied: false,
      oldLevel: 0,
      newLevel: 0,
      oldXp: 0,
      newXp: 0,
      memberType: input.memberType
    };
  }

  return sql.begin(async (transaction) => {
    const tx = transaction as unknown as Sql;

    if (input.sourceRef) {
      const [existingEvent] = await tx<{ id: string }[]>`
        SELECT id
        FROM rank_events
        WHERE guild_id = ${input.guildId}
          AND xp_type = ${input.xpType}
          AND source_type = ${input.sourceType}
          AND source_ref = ${input.sourceRef}
        LIMIT 1
      `;

      if (existingEvent) {
        const [currentProfile] = await tx<RankProfileRow[]>`
          SELECT member_type, voice_xp, text_xp, voice_level, text_level
          FROM rank_profiles
          WHERE guild_id = ${input.guildId}
            AND user_id = ${input.userId}
          LIMIT 1
        `;

        const currentXp = toSafeInt(
          input.xpType === "voice" ? currentProfile?.voice_xp : currentProfile?.text_xp
        );
        const currentLevel = toSafeInt(
          input.xpType === "voice" ? currentProfile?.voice_level : currentProfile?.text_level
        );

        return {
          applied: false,
          oldLevel: currentLevel,
          newLevel: currentLevel,
          oldXp: currentXp,
          newXp: currentXp,
          memberType: currentProfile?.member_type ?? input.memberType
        };
      }
    }

    const [currentProfile] = await tx<RankProfileRow[]>`
      SELECT member_type, voice_xp, text_xp, voice_level, text_level
      FROM rank_profiles
      WHERE guild_id = ${input.guildId}
        AND user_id = ${input.userId}
      FOR UPDATE
    `;

    const currentVoiceXp = toSafeInt(currentProfile?.voice_xp);
    const currentTextXp = toSafeInt(currentProfile?.text_xp);
    const currentVoiceLevel = toSafeInt(currentProfile?.voice_level);
    const currentTextLevel = toSafeInt(currentProfile?.text_level);
    const oldXp = input.xpType === "voice" ? currentVoiceXp : currentTextXp;
    const oldLevel = input.xpType === "voice" ? currentVoiceLevel : currentTextLevel;
    const newXp = oldXp + xpDelta;
    const newLevel = levelFromXp(newXp, curve);
    const nextVoiceXp = input.xpType === "voice" ? newXp : currentVoiceXp;
    const nextTextXp = input.xpType === "text" ? newXp : currentTextXp;
    const nextVoiceLevel = input.xpType === "voice" ? newLevel : currentVoiceLevel;
    const nextTextLevel = input.xpType === "text" ? newLevel : currentTextLevel;
    const createdAt = input.createdAt ?? new Date();
    const payload = JSON.stringify(input.payload ?? {});

    await tx`
      INSERT INTO rank_profiles (
        guild_id,
        user_id,
        member_type,
        voice_xp,
        text_xp,
        voice_level,
        text_level
      )
      VALUES (
        ${input.guildId},
        ${input.userId},
        ${input.memberType},
        ${nextVoiceXp},
        ${nextTextXp},
        ${nextVoiceLevel},
        ${nextTextLevel}
      )
      ON CONFLICT (guild_id, user_id)
      DO UPDATE SET
        member_type = EXCLUDED.member_type,
        voice_xp = EXCLUDED.voice_xp,
        text_xp = EXCLUDED.text_xp,
        voice_level = EXCLUDED.voice_level,
        text_level = EXCLUDED.text_level,
        updated_at = NOW()
    `;

    await tx`
      INSERT INTO rank_events (
        guild_id,
        user_id,
        member_type,
        xp_type,
        event_type,
        xp_delta,
        total_xp,
        level_after,
        source_type,
        source_ref,
        payload,
        created_at
      )
      VALUES (
        ${input.guildId},
        ${input.userId},
        ${input.memberType},
        ${input.xpType},
        'xp_gain',
        ${xpDelta},
        ${newXp},
        ${newLevel},
        ${input.sourceType},
        ${input.sourceRef ?? null},
        CAST(${payload} AS jsonb),
        ${createdAt}
      )
    `;

    if (newLevel > oldLevel) {
      for (let level = oldLevel + 1; level <= newLevel; level += 1) {
        const levelPayload = JSON.stringify({
          ...(input.payload ?? {}),
          levelReached: level
        });
        const levelSourceRef = input.sourceRef ? `${input.sourceRef}:level:${level}` : null;
        await tx`
          INSERT INTO rank_events (
            guild_id,
            user_id,
            member_type,
            xp_type,
            event_type,
            xp_delta,
            total_xp,
            level_after,
            source_type,
            source_ref,
            payload,
            created_at
          )
          VALUES (
            ${input.guildId},
            ${input.userId},
            ${input.memberType},
            ${input.xpType},
            'level_up',
            0,
            ${newXp},
            ${level},
            ${input.sourceType},
            ${levelSourceRef},
            CAST(${levelPayload} AS jsonb),
            ${createdAt}
          )
        `;
      }
    }

    return {
      applied: true,
      oldLevel,
      newLevel,
      oldXp,
      newXp,
      memberType: input.memberType
    };
  });
}
