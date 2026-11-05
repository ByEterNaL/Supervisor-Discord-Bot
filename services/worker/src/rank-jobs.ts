import type { Logger } from "pino";
import type { Sql } from "postgres";

import {
  CONFIG_KEY,
  applyRankXp,
  mergeConfig,
  type MemberType,
  type SupervisorConfig
} from "../../../packages/shared/src";

interface RankBackfillJobRow {
  status: "pending" | "running" | "completed" | "failed";
  job_started_at: Date;
  voice_cutoff_at: Date | null;
  text_cutoff_date: string | null;
  voice_last_user_id: number | null;
  text_last_user_id: number | null;
  processed_voice_rows: number;
  processed_text_rows: number;
}

interface VoiceBackfillRow {
  user_id: string;
  member_type: MemberType | null;
  total_seconds: number;
}

interface TextBackfillRow {
  user_id: string;
  member_type: MemberType | null;
  eligible_message_count: number;
}

interface VoiceCandidateRow {
  user_id: string;
  member_type: MemberType | null;
  last_processed_at: Date | null;
  carry_seconds: number;
}

async function loadConfig(sql: Sql): Promise<SupervisorConfig> {
  const [row] = await sql<{ value: unknown }[]>`
    SELECT value
    FROM config_entries
    WHERE key = ${CONFIG_KEY}
    LIMIT 1
  `;

  return mergeConfig(row?.value ?? {});
}

async function ensureBackfillJob(sql: Sql, guildId: string, timezone: string) {
  const [existing] = await sql<RankBackfillJobRow[]>`
    SELECT
      status,
      job_started_at,
      voice_cutoff_at,
      text_cutoff_date::text,
      voice_last_user_id,
      text_last_user_id,
      processed_voice_rows,
      processed_text_rows
    FROM rank_backfill_jobs
    WHERE guild_id = ${guildId}
    LIMIT 1
  `;

  if (existing) {
    return existing;
  }

  const [cutoffRow] = await sql<{ text_cutoff_date: string }[]>`
    SELECT (((timezone(${timezone}, now()))::date) - INTERVAL '1 day')::date::text AS text_cutoff_date
  `;

  const [created] = await sql<RankBackfillJobRow[]>`
    INSERT INTO rank_backfill_jobs (
      guild_id,
      status,
      job_started_at,
      voice_cutoff_at,
      text_cutoff_date
    )
    VALUES (
      ${guildId},
      'pending',
      NOW(),
      NOW(),
      ${cutoffRow?.text_cutoff_date ?? null}
    )
    RETURNING
      status,
      job_started_at,
      voice_cutoff_at,
      text_cutoff_date::text,
      voice_last_user_id,
      text_last_user_id,
      processed_voice_rows,
      processed_text_rows
  `;

  return created;
}

export async function processRankBackfill(
  sql: Sql,
  logger: Logger,
  guildId: string,
  timezone: string
) {
  if (!guildId) {
    return;
  }

  const config = await loadConfig(sql);
  if (!config.rankSystem.voice.enabled && !config.rankSystem.text.enabled) {
    return;
  }

  const job = await ensureBackfillJob(sql, guildId, timezone);
  if (!job || job.status === "completed") {
    return;
  }

  await sql`
    UPDATE rank_backfill_jobs
    SET status = 'running',
        last_error = NULL
    WHERE guild_id = ${guildId}
  `;

  try {
    const voiceRows = config.rankSystem.voice.enabled
      ? await sql.unsafe<VoiceBackfillRow[]>(
          `
            SELECT
              segment.user_id::text AS user_id,
              MAX(members.member_type) AS member_type,
              SUM(segment.duration_seconds)::int AS total_seconds
            FROM voice_active_segments AS segment
            LEFT JOIN members
              ON members.guild_id = segment.guild_id
             AND members.user_id = segment.user_id
            WHERE ${[
              "segment.guild_id = $1",
              job.voice_cutoff_at ? `segment.ended_at < $2` : null,
              job.voice_last_user_id !== null
                ? `segment.user_id > $${job.voice_cutoff_at ? 3 : 2}`
                : null
            ]
              .filter(Boolean)
              .join(" AND ")}
            GROUP BY segment.user_id
            ORDER BY segment.user_id ASC
            LIMIT 250
          `,
          [
            guildId,
            ...(job.voice_cutoff_at ? [job.voice_cutoff_at] : []),
            ...(job.voice_last_user_id !== null ? [job.voice_last_user_id] : [])
          ]
        )
      : [];

    if (voiceRows.length > 0) {
      let lastUserId = job.voice_last_user_id;

      for (const row of voiceRows) {
        const minChunkSeconds = Math.max(1, config.rankSystem.voice.minAwardChunkSeconds);
        const awardableSeconds =
          Math.floor(Math.max(0, row.total_seconds) / minChunkSeconds) * minChunkSeconds;
        const xpDelta =
          Math.floor(awardableSeconds / 60) * config.rankSystem.voice.xpPerActiveMinute;
        const sourceRef = `voice-backfill:${job.job_started_at.toISOString()}:user:${row.user_id}`;

        if (xpDelta > 0) {
          await applyRankXp(sql, config.rankSystem.curve, {
            guildId,
            userId: row.user_id,
            memberType: row.member_type ?? "user",
            xpType: "voice",
            xpDelta,
            sourceType: "backfill",
            sourceRef,
            payload: {
              totalSeconds: row.total_seconds
            },
            createdAt: job.voice_cutoff_at ?? job.job_started_at
          });

          await sql`
            UPDATE rank_events
            SET role_sync_processed_at = NOW(),
                announcement_processed_at = NOW()
            WHERE guild_id = ${guildId}
              AND user_id = ${row.user_id}
              AND source_type = 'backfill'
              AND source_ref = ${sourceRef}
          `;
          await sql`
            UPDATE rank_events
            SET role_sync_processed_at = NOW(),
                announcement_processed_at = NOW()
            WHERE guild_id = ${guildId}
              AND user_id = ${row.user_id}
              AND source_type = 'backfill'
              AND source_ref LIKE ${`${sourceRef}:level:%`}
          `;
        }

        lastUserId = Number(row.user_id);
      }

      await sql`
        UPDATE rank_backfill_jobs
        SET voice_last_user_id = ${lastUserId ?? null},
            processed_voice_rows = processed_voice_rows + ${voiceRows.length}
        WHERE guild_id = ${guildId}
      `;

      return;
    }

    const textRows = config.rankSystem.text.enabled
      ? await sql.unsafe<TextBackfillRow[]>(
          `
            SELECT
              daily.user_id::text AS user_id,
              MAX(members.member_type) AS member_type,
              SUM(LEAST(daily.total_messages, 120))::int AS eligible_message_count
            FROM (
              SELECT
                guild_id,
                user_id,
                bucket_date,
                SUM(message_count)::bigint AS total_messages
              FROM guild_message_daily_stats
              GROUP BY guild_id, user_id, bucket_date
            ) AS daily
            LEFT JOIN members
              ON members.guild_id = daily.guild_id
             AND members.user_id = daily.user_id
            WHERE ${[
              "daily.guild_id = $1",
              job.text_cutoff_date ? `daily.bucket_date <= $2::date` : null,
              job.text_last_user_id !== null
                ? `daily.user_id > $${job.text_cutoff_date ? 3 : 2}`
                : null
            ]
              .filter(Boolean)
              .join(" AND ")}
            GROUP BY daily.user_id
            ORDER BY daily.user_id ASC
            LIMIT 250
          `,
          [
            guildId,
            ...(job.text_cutoff_date ? [job.text_cutoff_date] : []),
            ...(job.text_last_user_id !== null ? [job.text_last_user_id] : [])
          ]
        )
      : [];

    if (textRows.length > 0) {
      let lastUserId = job.text_last_user_id;

      for (const row of textRows) {
        const xpDelta =
          Math.max(0, row.eligible_message_count) * config.rankSystem.text.xpPerEligibleMessage;
        const sourceRef = `text-backfill:${job.text_cutoff_date ?? "none"}:user:${row.user_id}`;

        if (xpDelta > 0) {
          await applyRankXp(sql, config.rankSystem.curve, {
            guildId,
            userId: row.user_id,
            memberType: row.member_type ?? "user",
            xpType: "text",
            xpDelta,
            sourceType: "backfill",
            sourceRef,
            payload: {
              eligibleMessages: row.eligible_message_count,
              cutoffDate: job.text_cutoff_date
            },
            createdAt: job.job_started_at
          });

          await sql`
            UPDATE rank_events
            SET role_sync_processed_at = NOW(),
                announcement_processed_at = NOW()
            WHERE guild_id = ${guildId}
              AND user_id = ${row.user_id}
              AND source_type = 'backfill'
              AND source_ref = ${sourceRef}
          `;
          await sql`
            UPDATE rank_events
            SET role_sync_processed_at = NOW(),
                announcement_processed_at = NOW()
            WHERE guild_id = ${guildId}
              AND user_id = ${row.user_id}
              AND source_type = 'backfill'
              AND source_ref LIKE ${`${sourceRef}:level:%`}
          `;
        }

        lastUserId = Number(row.user_id);
      }

      await sql`
        UPDATE rank_backfill_jobs
        SET text_last_user_id = ${lastUserId ?? null},
            processed_text_rows = processed_text_rows + ${textRows.length}
        WHERE guild_id = ${guildId}
      `;

      return;
    }

    await sql`
      UPDATE rank_backfill_jobs
      SET status = 'completed',
          completed_at = NOW(),
          last_error = NULL
      WHERE guild_id = ${guildId}
    `;

    await sql`
      INSERT INTO rank_reward_sync_jobs (guild_id, status, requested_at)
      VALUES (${guildId}, 'pending', NOW())
      ON CONFLICT (guild_id)
      DO UPDATE SET
        status = 'pending',
        requested_at = NOW(),
        completed_at = NULL,
        last_error = NULL
    `;
  } catch (error) {
    await sql`
      UPDATE rank_backfill_jobs
      SET status = 'failed',
          last_error = ${error instanceof Error ? error.message : String(error)}
      WHERE guild_id = ${guildId}
    `;
    logger.error({ error, guildId }, "Rank backfill job failed.");
  }
}

export async function processRankVoiceXp(sql: Sql, logger: Logger, guildId: string) {
  if (!guildId) {
    return;
  }

  const config = await loadConfig(sql);
  if (!config.rankSystem.voice.enabled) {
    return;
  }

  const [backfill] = await sql<RankBackfillJobRow[]>`
    SELECT
      status,
      job_started_at,
      voice_cutoff_at,
      text_cutoff_date::text,
      voice_last_user_id,
      text_last_user_id,
      processed_voice_rows,
      processed_text_rows
    FROM rank_backfill_jobs
    WHERE guild_id = ${guildId}
    LIMIT 1
  `;

  if (!backfill || backfill.status !== "completed") {
    return;
  }

  const now = new Date();
  const bootstrapAt = backfill.voice_cutoff_at ?? backfill.job_started_at;
  const candidates = await sql<VoiceCandidateRow[]>`
    WITH candidate_users AS (
      SELECT user_id
      FROM rank_voice_state
      WHERE guild_id = ${guildId}
      UNION
      SELECT user_id
      FROM live_presence_sessions
      WHERE guild_id = ${guildId}
        AND session_type = 'voice'
      UNION
      SELECT DISTINCT user_id
      FROM voice_active_segments
      WHERE guild_id = ${guildId}
        AND ended_at >= ${bootstrapAt}
    )
    SELECT
      candidate_users.user_id::text AS user_id,
      members.member_type,
      rank_voice_state.last_processed_at,
      COALESCE(rank_voice_state.carry_seconds, 0) AS carry_seconds
    FROM candidate_users
    LEFT JOIN rank_voice_state
      ON rank_voice_state.guild_id = ${guildId}
     AND rank_voice_state.user_id = candidate_users.user_id
    LEFT JOIN members
      ON members.guild_id = ${guildId}
     AND members.user_id = candidate_users.user_id
  `;

  for (const candidate of candidates) {
    try {
      const startAt = candidate.last_processed_at ?? bootstrapAt;
      if (startAt >= now) {
        continue;
      }

      const [row] = await sql<{ total_seconds: number }[]>`
        WITH bounds AS (
          SELECT ${startAt}::timestamptz AS start_at, ${now}::timestamptz AS end_at
        )
        SELECT COALESCE(SUM(source.duration_seconds), 0)::int AS total_seconds
        FROM (
          SELECT
            GREATEST(
              EXTRACT(EPOCH FROM (
                LEAST(segment.ended_at, bounds.end_at) - GREATEST(segment.started_at, bounds.start_at)
              )),
              0
            )::int AS duration_seconds
          FROM voice_active_segments AS segment
          CROSS JOIN bounds
          WHERE segment.guild_id = ${guildId}
            AND segment.user_id = ${candidate.user_id}
            AND segment.ended_at > bounds.start_at
            AND segment.started_at < bounds.end_at
          UNION ALL
          SELECT
            GREATEST(
              EXTRACT(EPOCH FROM (
                LEAST(bounds.end_at, live.last_confirmed_at + INTERVAL '90 seconds')
                - GREATEST(live.started_at, bounds.start_at)
              )),
              0
            )::int AS duration_seconds
          FROM live_presence_sessions AS live
          CROSS JOIN bounds
          WHERE live.guild_id = ${guildId}
            AND live.user_id = ${candidate.user_id}
            AND live.session_type = 'voice'
            AND live.started_at < bounds.end_at
        ) AS source
      `;

      const baseSeconds = Math.max(0, row?.total_seconds ?? 0);
      const carriedSeconds = Math.max(0, candidate.carry_seconds ?? 0);
      const totalSeconds = baseSeconds + carriedSeconds;
      const minChunkSeconds = Math.max(1, config.rankSystem.voice.minAwardChunkSeconds);
      const awardableSeconds = Math.floor(totalSeconds / minChunkSeconds) * minChunkSeconds;
      const nextCarrySeconds = totalSeconds - awardableSeconds;
      const xpDelta =
        Math.floor(awardableSeconds / 60) * config.rankSystem.voice.xpPerActiveMinute;

      await sql`
        INSERT INTO rank_voice_state (guild_id, user_id, last_processed_at, carry_seconds)
        VALUES (${guildId}, ${candidate.user_id}, ${now}, ${nextCarrySeconds})
        ON CONFLICT (guild_id, user_id)
        DO UPDATE SET
          last_processed_at = EXCLUDED.last_processed_at,
          carry_seconds = EXCLUDED.carry_seconds,
          updated_at = NOW()
      `;

      if (xpDelta <= 0) {
        continue;
      }

      await applyRankXp(sql, config.rankSystem.curve, {
        guildId,
        userId: candidate.user_id,
        memberType: candidate.member_type ?? "user",
        xpType: "voice",
        xpDelta,
        sourceType: "voice-runtime",
        sourceRef: `voice-runtime:${candidate.user_id}:${now.toISOString()}`,
        payload: {
          awardableSeconds
        },
        createdAt: now
      });
    } catch (error) {
      logger.error({ error, guildId, userId: candidate.user_id }, "Voice rank award failed.");
    }
  }
}
