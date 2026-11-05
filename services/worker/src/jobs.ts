import type { Sql } from "postgres";

import { CONFIG_KEY, mergeConfig, type SupervisorConfig } from "../../../packages/shared/src";

const UNPROVEN_PROOF_WINDOW_MINUTES = 5;

async function loadConfig(sql: Sql): Promise<SupervisorConfig> {
  const [row] = await sql<{ value: unknown }[]>`
    SELECT value
    FROM config_entries
    WHERE key = ${CONFIG_KEY}
    LIMIT 1
  `;

  return mergeConfig(row?.value ?? {});
}

export async function ensureFuturePartitions(sql: Sql) {
  await sql`
    SELECT ensure_month_partition('voice_active_segments', (date_trunc('month', now()) + INTERVAL '1 month')::date)
  `;
  await sql`
    SELECT ensure_month_partition('camera_segments', (date_trunc('month', now()) + INTERVAL '1 month')::date)
  `;
  await sql`
    SELECT ensure_month_partition('stream_segments', (date_trunc('month', now()) + INTERVAL '1 month')::date)
  `;
}

export async function refreshDailyMetrics(sql: Sql, timezone: string) {
  await sql.unsafe(
    `
      WITH period AS (
        SELECT (timezone($1, now()))::date AS bucket_date
      )
      DELETE FROM member_daily_metrics
      WHERE bucket_date = (SELECT bucket_date FROM period)
    `,
    [timezone]
  );

  await sql.unsafe(
    `
      WITH period AS (
        SELECT (timezone($1, now()))::date AS bucket_date
      ),
      voice AS (
        SELECT guild_id, user_id, (timezone($1, started_at))::date AS bucket_date, SUM(duration_seconds)::int AS value
        FROM voice_active_segments
        WHERE (timezone($1, started_at))::date = (SELECT bucket_date FROM period)
        GROUP BY guild_id, user_id, bucket_date
      ),
      camera AS (
        SELECT guild_id, user_id, (timezone($1, started_at))::date AS bucket_date, SUM(duration_seconds)::int AS value
        FROM camera_segments
        WHERE (timezone($1, started_at))::date = (SELECT bucket_date FROM period)
        GROUP BY guild_id, user_id, bucket_date
      ),
      stream AS (
        SELECT guild_id, user_id, (timezone($1, started_at))::date AS bucket_date, SUM(duration_seconds)::int AS value
        FROM stream_segments
        WHERE (timezone($1, started_at))::date = (SELECT bucket_date FROM period)
        GROUP BY guild_id, user_id, bucket_date
      ),
      ticket_opened AS (
        SELECT guild_id, owner_id AS user_id, (timezone($1, created_at))::date AS bucket_date, COUNT(*)::int AS value
        FROM ticket_sessions
        WHERE (timezone($1, created_at))::date = (SELECT bucket_date FROM period)
        GROUP BY guild_id, owner_id, bucket_date
      ),
      ticket_claims_agg AS (
        SELECT ts.guild_id, tc.claimer_id AS user_id, (timezone($1, tc.claimed_at))::date AS bucket_date, COUNT(*)::int AS value
        FROM ticket_claims tc
        JOIN ticket_sessions ts ON ts.id = tc.ticket_id
        WHERE (timezone($1, tc.claimed_at))::date = (SELECT bucket_date FROM period)
        GROUP BY ts.guild_id, tc.claimer_id, bucket_date
      ),
      ticket_messages_agg AS (
        SELECT guild_id, author_id AS user_id, (timezone($1, created_at))::date AS bucket_date, COUNT(*)::int AS value
        FROM ticket_messages
        WHERE author_id IS NOT NULL
          AND author_type IN ('staff', 'user')
          AND (timezone($1, created_at))::date = (SELECT bucket_date FROM period)
        GROUP BY guild_id, author_id, bucket_date
      ),
      bans AS (
        SELECT guild_id, actor_id AS user_id, (timezone($1, created_at))::date AS bucket_date, COUNT(*)::int AS value
        FROM moderation_actions
        WHERE action_type = 'ban'
          AND (timezone($1, created_at))::date = (SELECT bucket_date FROM period)
        GROUP BY guild_id, actor_id, bucket_date
      ),
      kicks AS (
        SELECT guild_id, actor_id AS user_id, (timezone($1, created_at))::date AS bucket_date, COUNT(*)::int AS value
        FROM moderation_actions
        WHERE action_type = 'kick'
          AND (timezone($1, created_at))::date = (SELECT bucket_date FROM period)
        GROUP BY guild_id, actor_id, bucket_date
      ),
      timeouts AS (
        SELECT guild_id, actor_id AS user_id, (timezone($1, created_at))::date AS bucket_date, COUNT(*)::int AS value
        FROM moderation_actions
        WHERE action_type = 'timeout'
          AND (timezone($1, created_at))::date = (SELECT bucket_date FROM period)
        GROUP BY guild_id, actor_id, bucket_date
      ),
      union_keys AS (
        SELECT guild_id, user_id, bucket_date FROM voice
        UNION
        SELECT guild_id, user_id, bucket_date FROM camera
        UNION
        SELECT guild_id, user_id, bucket_date FROM stream
        UNION
        SELECT guild_id, user_id, bucket_date FROM ticket_opened
        UNION
        SELECT guild_id, user_id, bucket_date FROM ticket_claims_agg
        UNION
        SELECT guild_id, user_id, bucket_date FROM ticket_messages_agg
        UNION
        SELECT guild_id, user_id, bucket_date FROM bans
        UNION
        SELECT guild_id, user_id, bucket_date FROM kicks
        UNION
        SELECT guild_id, user_id, bucket_date FROM timeouts
      )
      INSERT INTO member_daily_metrics (
        guild_id,
        user_id,
        member_type,
        bucket_date,
        voice_active_seconds,
        camera_seconds,
        stream_seconds,
        ticket_opened_count,
        ticket_claim_count,
        ticket_message_count,
        moderation_ban_count,
        moderation_kick_count,
        moderation_timeout_count
      )
      SELECT
        union_keys.guild_id,
        union_keys.user_id,
        COALESCE(members.member_type, 'user'),
        union_keys.bucket_date,
        COALESCE(voice.value, 0),
        COALESCE(camera.value, 0),
        COALESCE(stream.value, 0),
        COALESCE(ticket_opened.value, 0),
        COALESCE(ticket_claims_agg.value, 0),
        COALESCE(ticket_messages_agg.value, 0),
        COALESCE(bans.value, 0),
        COALESCE(kicks.value, 0),
        COALESCE(timeouts.value, 0)
      FROM union_keys
      LEFT JOIN members
        ON members.guild_id = union_keys.guild_id
       AND members.user_id = union_keys.user_id
      LEFT JOIN voice
        ON voice.guild_id = union_keys.guild_id
       AND voice.user_id = union_keys.user_id
       AND voice.bucket_date = union_keys.bucket_date
      LEFT JOIN camera
        ON camera.guild_id = union_keys.guild_id
       AND camera.user_id = union_keys.user_id
       AND camera.bucket_date = union_keys.bucket_date
      LEFT JOIN stream
        ON stream.guild_id = union_keys.guild_id
       AND stream.user_id = union_keys.user_id
       AND stream.bucket_date = union_keys.bucket_date
      LEFT JOIN ticket_opened
        ON ticket_opened.guild_id = union_keys.guild_id
       AND ticket_opened.user_id = union_keys.user_id
       AND ticket_opened.bucket_date = union_keys.bucket_date
      LEFT JOIN ticket_claims_agg
        ON ticket_claims_agg.guild_id = union_keys.guild_id
       AND ticket_claims_agg.user_id = union_keys.user_id
       AND ticket_claims_agg.bucket_date = union_keys.bucket_date
      LEFT JOIN ticket_messages_agg
        ON ticket_messages_agg.guild_id = union_keys.guild_id
       AND ticket_messages_agg.user_id = union_keys.user_id
       AND ticket_messages_agg.bucket_date = union_keys.bucket_date
      LEFT JOIN bans
        ON bans.guild_id = union_keys.guild_id
       AND bans.user_id = union_keys.user_id
       AND bans.bucket_date = union_keys.bucket_date
      LEFT JOIN kicks
        ON kicks.guild_id = union_keys.guild_id
       AND kicks.user_id = union_keys.user_id
       AND kicks.bucket_date = union_keys.bucket_date
      LEFT JOIN timeouts
        ON timeouts.guild_id = union_keys.guild_id
       AND timeouts.user_id = union_keys.user_id
       AND timeouts.bucket_date = union_keys.bucket_date
    `,
    [timezone]
  );
}

export async function refreshWeeklyMetrics(sql: Sql, timezone: string) {
  await sql.unsafe(
    `
      WITH period AS (
        SELECT date_trunc('week', timezone($1, now()))::date AS week_start
      )
      DELETE FROM member_weekly_metrics
      WHERE week_start = (SELECT week_start FROM period)
    `,
    [timezone]
  );

  await sql.unsafe(
    `
      WITH period AS (
        SELECT date_trunc('week', timezone($1, now()))::date AS week_start
      ),
      daily AS (
        SELECT *
        FROM member_daily_metrics
        WHERE bucket_date >= (SELECT week_start FROM period)
          AND bucket_date < (SELECT week_start FROM period) + INTERVAL '7 day'
      )
      INSERT INTO member_weekly_metrics (
        guild_id,
        user_id,
        member_type,
        week_start,
        voice_active_seconds,
        camera_seconds,
        stream_seconds,
        ticket_opened_count,
        ticket_claim_count,
        ticket_message_count,
        moderation_ban_count,
        moderation_kick_count,
        moderation_timeout_count
      )
      SELECT
        guild_id,
        user_id,
        MAX(member_type) AS member_type,
        (SELECT week_start FROM period),
        SUM(voice_active_seconds)::int,
        SUM(camera_seconds)::int,
        SUM(stream_seconds)::int,
        SUM(ticket_opened_count)::int,
        SUM(ticket_claim_count)::int,
        SUM(ticket_message_count)::int,
        SUM(moderation_ban_count)::int,
        SUM(moderation_kick_count)::int,
        SUM(moderation_timeout_count)::int
      FROM daily
      GROUP BY guild_id, user_id
    `,
    [timezone]
  );
}

export async function refreshMonthlyMetrics(sql: Sql, timezone: string) {
  await sql.unsafe(
    `
      WITH period AS (
        SELECT date_trunc('month', timezone($1, now()))::date AS month_start
      )
      DELETE FROM member_monthly_metrics
      WHERE month_start = (SELECT month_start FROM period)
    `,
    [timezone]
  );

  await sql.unsafe(
    `
      WITH period AS (
        SELECT date_trunc('month', timezone($1, now()))::date AS month_start
      ),
      daily AS (
        SELECT *
        FROM member_daily_metrics
        WHERE bucket_date >= (SELECT month_start FROM period)
          AND bucket_date < ((SELECT month_start FROM period) + INTERVAL '1 month')
      )
      INSERT INTO member_monthly_metrics (
        guild_id,
        user_id,
        member_type,
        month_start,
        voice_active_seconds,
        camera_seconds,
        stream_seconds,
        ticket_opened_count,
        ticket_claim_count,
        ticket_message_count,
        moderation_ban_count,
        moderation_kick_count,
        moderation_timeout_count
      )
      SELECT
        guild_id,
        user_id,
        MAX(member_type) AS member_type,
        (SELECT month_start FROM period),
        SUM(voice_active_seconds)::int,
        SUM(camera_seconds)::int,
        SUM(stream_seconds)::int,
        SUM(ticket_opened_count)::int,
        SUM(ticket_claim_count)::int,
        SUM(ticket_message_count)::int,
        SUM(moderation_ban_count)::int,
        SUM(moderation_kick_count)::int,
        SUM(moderation_timeout_count)::int
      FROM daily
      GROUP BY guild_id, user_id
    `,
    [timezone]
  );
}

export async function refreshAlerts(sql: Sql, timezone: string) {
  const config = await loadConfig(sql);
  const staleMinutes = config.alerts.staleTicketMinutes;
  const unclaimedMinutes = config.alerts.unclaimedTicketMinutes;
  const openThreshold = config.alerts.openTicketThreshold;

  await sql`
    UPDATE alerts
    SET resolved_at = NOW()
    WHERE resolved_at IS NULL
      AND alert_type IN ('stale_ticket', 'unclaimed_ticket', 'ticket_overload')
  `;

  await sql.unsafe(
    `
      INSERT INTO alerts (guild_id, alert_type, severity, member_id, payload)
      SELECT
        guild_id,
        'stale_ticket',
        'warning',
        claimed_by,
        jsonb_build_object(
          'ticket_id', id,
          'channel_id', channel_id,
          'created_at', created_at,
          'minutes_open', EXTRACT(EPOCH FROM (NOW() - created_at)) / 60
        )
      FROM ticket_sessions
      WHERE status = 'open'
        AND created_at <= NOW() - ($1 || ' minutes')::interval
    `,
    [String(staleMinutes)]
  );

  await sql.unsafe(
    `
      INSERT INTO alerts (guild_id, alert_type, severity, member_id, payload)
      SELECT
        guild_id,
        'unclaimed_ticket',
        'critical',
        NULL,
        jsonb_build_object(
          'ticket_id', id,
          'channel_id', channel_id,
          'created_at', created_at
        )
      FROM ticket_sessions
      WHERE status = 'open'
        AND claimed_by IS NULL
        AND created_at <= NOW() - ($1 || ' minutes')::interval
    `,
    [String(unclaimedMinutes)]
  );

  await sql.unsafe(
    `
      INSERT INTO alerts (guild_id, alert_type, severity, member_id, payload)
      SELECT
        guild_id,
        'ticket_overload',
        'warning',
        NULL,
        jsonb_build_object('open_ticket_count', COUNT(*))
      FROM ticket_sessions
      WHERE status = 'open'
      GROUP BY guild_id
      HAVING COUNT(*) >= $1
    `,
    [openThreshold]
  );
}

export async function checkUnprovenActions(sql: Sql) {
  // Keep a strict 1-to-1 mapping between actions and proof messages.
  // An action should only be marked as unproven after the full proof window expires.
  const matchProofToAction = async (action: {
    id: string;
    guild_id: string;
    actor_id: string;
    created_at: Date;
  }) => {
    const [proof] = await sql<{ id: string }[]>`
      UPDATE moderation_proof_messages
      SET action_id = ${action.id}
      WHERE id = (
        SELECT id FROM moderation_proof_messages
        WHERE guild_id = ${action.guild_id}
          AND author_id = ${action.actor_id}
          AND action_id IS NULL
          AND created_at >= ${action.created_at}
          AND created_at <= ${action.created_at} + ${UNPROVEN_PROOF_WINDOW_MINUTES} * INTERVAL '1 minute'
        ORDER BY created_at ASC
        LIMIT 1
      )
      RETURNING id
    `;

    return proof;
  };

  const repairableActions = await sql<{
    id: string;
    guild_id: string;
    actor_id: string;
    target_id: string;
    created_at: Date;
  }[]>`
    SELECT ma.id, ma.guild_id, ma.actor_id, ma.target_id, ma.created_at
    FROM unproven_actions ua
    JOIN moderation_actions ma ON ma.id = ua.action_id
    WHERE EXISTS (
      SELECT 1
      FROM moderation_proof_messages mpm
      WHERE mpm.guild_id = ma.guild_id
        AND mpm.author_id = ma.actor_id
        AND mpm.action_id IS NULL
        AND mpm.created_at >= ma.created_at
        AND mpm.created_at <= ma.created_at + ${UNPROVEN_PROOF_WINDOW_MINUTES} * INTERVAL '1 minute'
    )
    ORDER BY ma.created_at ASC
  `;

  for (const action of repairableActions) {
    const proof = await matchProofToAction(action);

    if (!proof) {
      continue;
    }

    await sql`
      DELETE FROM unproven_actions
      WHERE action_id = ${action.id}
    `;
  }

  const pendingActions = await sql<{
    id: string;
    guild_id: string;
    actor_id: string;
    target_id: string;
    created_at: Date;
  }[]>`
    WITH config_roles AS (
      SELECT jsonb_array_elements_text(value->'unproven'->'targetRoleIds') AS role_id
      FROM config_entries
      WHERE key = 'supervisor.config'
    ),
    target_actors AS (
      SELECT DISTINCT user_id
      FROM staff_roles sr
      JOIN members m ON m.guild_id = sr.guild_id
      WHERE sr.role_id::text IN (SELECT role_id FROM config_roles)
    )
    SELECT ma.id, ma.guild_id, ma.actor_id, ma.target_id, ma.created_at
    FROM moderation_actions ma
    WHERE ma.created_at <= NOW() - ${UNPROVEN_PROOF_WINDOW_MINUTES} * INTERVAL '1 minute'
      AND ma.actor_id IN (SELECT user_id FROM target_actors)
      AND NOT EXISTS (
        SELECT 1
        FROM moderation_proof_messages mpm
        WHERE mpm.action_id = ma.id
      )
    ORDER BY ma.created_at ASC
  `;

  for (const action of pendingActions) {
    const proof = await matchProofToAction(action);

    if (proof) {
      await sql`
        DELETE FROM unproven_actions
        WHERE action_id = ${action.id}
      `;
      continue;
    }

    await sql`
      INSERT INTO unproven_actions (action_id, guild_id, actor_id, target_id)
      VALUES (${action.id}, ${action.guild_id}, ${action.actor_id}, ${action.target_id})
      ON CONFLICT (action_id) DO NOTHING
    `;
  }
}
