from __future__ import annotations

import json
from datetime import datetime, timezone
from time import perf_counter
from typing import Any

from redis import Redis
from redis.exceptions import RedisError
from sqlalchemy import text

from .config import DEFAULT_CONFIG, deep_merge, settings
from .db import engine

CONFIG_KEY = "supervisor.config"
CONFIG_CHANGED_CHANNEL = "supervisor:config-changed"

PERIOD_WINDOW_META = {
    "day": {
        "start_expression": "(timezone(:timezone, now()))::date",
        "end_expression": "((timezone(:timezone, now()))::date + INTERVAL '1 day')",
        "start_ts_expression": "(date_trunc('day', timezone(:timezone, now())) AT TIME ZONE :timezone)",
        "end_ts_expression": "((date_trunc('day', timezone(:timezone, now())) + INTERVAL '1 day') AT TIME ZONE :timezone)",
    },
    "week": {
        "start_expression": "((timezone(:timezone, now()))::date - INTERVAL '6 day')",
        "end_expression": "((timezone(:timezone, now()))::date + INTERVAL '1 day')",
        "start_ts_expression": "((date_trunc('day', timezone(:timezone, now())) - INTERVAL '6 day') AT TIME ZONE :timezone)",
        "end_ts_expression": "((date_trunc('day', timezone(:timezone, now())) + INTERVAL '1 day') AT TIME ZONE :timezone)",
    },
    "month": {
        "start_expression": "((timezone(:timezone, now()))::date - INTERVAL '29 day')",
        "end_expression": "((timezone(:timezone, now()))::date + INTERVAL '1 day')",
        "start_ts_expression": "((date_trunc('day', timezone(:timezone, now())) - INTERVAL '29 day') AT TIME ZONE :timezone)",
        "end_ts_expression": "((date_trunc('day', timezone(:timezone, now())) + INTERVAL '1 day') AT TIME ZONE :timezone)",
    },
}

RISKY_PERMISSION_NAMES = {
    "Administrator",
    "BanMembers",
    "KickMembers",
    "ManageGuild",
    "ManageRoles",
    "ManageChannels",
    "ModerateMembers",
    "ViewAuditLog",
    "ManageWebhooks",
}


def period_window_meta(period: str) -> dict[str, str]:
    return PERIOD_WINDOW_META.get(period, PERIOD_WINDOW_META["day"])


def json_object(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value

    if isinstance(value, str):
        try:
            decoded = json.loads(value)
        except json.JSONDecodeError:
            return {}
        return decoded if isinstance(decoded, dict) else {}

    return {}


def json_array(value: Any) -> list[Any]:
    if isinstance(value, list):
        return value

    if isinstance(value, str):
        try:
            decoded = json.loads(value)
        except json.JSONDecodeError:
            return []
        return decoded if isinstance(decoded, list) else []

    return []


def _normalize_guard_log_search_text(item: dict[str, Any]) -> str:
    payload = item.get("payload") or {}
    try:
        payload_text = json.dumps(payload, ensure_ascii=False, default=str)
    except TypeError:
        payload_text = str(payload)

    text_parts = [
        str(item.get("feature_key") or ""),
        str(item.get("event_type") or ""),
        str(item.get("actor_name") or ""),
        str(item.get("actor_id") or ""),
        str(item.get("target_name") or ""),
        str(item.get("target_id") or ""),
        str(item.get("action_taken") or ""),
        str(item.get("reason") or ""),
        payload_text,
    ]
    return " ".join(part.lower() for part in text_parts if part)


def _role_payload_is_risky(action_type: str, payload: dict[str, Any]) -> bool:
    if action_type == "delete":
        return True

    snapshots = [
        json_object(payload.get("snapshot")),
        json_object(payload.get("roleSnapshot")),
        json_object(payload.get("afterSnapshot")),
    ]
    for snapshot in snapshots:
        permissions = set(str(name) for name in json_array(snapshot.get("permissions")))
        if permissions & RISKY_PERMISSION_NAMES:
            return True

    for change in json_array(payload.get("changes")):
        if not isinstance(change, dict):
            continue
        if str(change.get("field")) != "permissions":
            continue
        old_value = {str(name) for name in json_array(change.get("oldValue"))}
        new_value = {str(name) for name in json_array(change.get("newValue"))}
        if (old_value | new_value) & RISKY_PERMISSION_NAMES:
            return True

    return False


def metrics_period_cte(period: str) -> str:
    window = period_window_meta(period)
    return f"""
        daily_metrics AS (
          SELECT
            guild_id,
            user_id,
            MAX(member_type) AS member_type,
            SUM(voice_active_seconds)::int AS voice_active_seconds,
            SUM(camera_seconds)::int AS camera_seconds,
            SUM(stream_seconds)::int AS stream_seconds,
            SUM(ticket_opened_count)::int AS ticket_opened_count,
            SUM(ticket_claim_count)::int AS ticket_claim_count,
            SUM(ticket_message_count)::int AS ticket_message_count
          FROM member_daily_metrics
          WHERE bucket_date >= {window['start_expression']}
            AND bucket_date < {window['end_expression']}
          GROUP BY guild_id, user_id
        ),
        moderation_metrics AS (
          SELECT
            guild_id,
            actor_id AS user_id,
            COUNT(*) FILTER (WHERE action_type = 'ban')::int AS moderation_ban_count,
            COUNT(*) FILTER (WHERE action_type = 'kick')::int AS moderation_kick_count,
            COUNT(*) FILTER (WHERE action_type = 'timeout')::int AS moderation_timeout_count
          FROM moderation_actions
          WHERE created_at >= {window['start_ts_expression']}
            AND created_at < LEAST(NOW(), {window['end_ts_expression']})
          GROUP BY guild_id, actor_id
        ),
        metrics AS (
          SELECT
            COALESCE(daily_metrics.guild_id, moderation_metrics.guild_id) AS guild_id,
            COALESCE(daily_metrics.user_id, moderation_metrics.user_id) AS user_id,
            COALESCE(daily_metrics.member_type, members.member_type, 'user') AS member_type,
            COALESCE(daily_metrics.voice_active_seconds, 0) AS voice_active_seconds,
            COALESCE(daily_metrics.camera_seconds, 0) AS camera_seconds,
            COALESCE(daily_metrics.stream_seconds, 0) AS stream_seconds,
            COALESCE(daily_metrics.ticket_opened_count, 0) AS ticket_opened_count,
            COALESCE(daily_metrics.ticket_claim_count, 0) AS ticket_claim_count,
            COALESCE(daily_metrics.ticket_message_count, 0) AS ticket_message_count,
            COALESCE(moderation_metrics.moderation_ban_count, 0) AS moderation_ban_count,
            COALESCE(moderation_metrics.moderation_kick_count, 0) AS moderation_kick_count,
            COALESCE(moderation_metrics.moderation_timeout_count, 0) AS moderation_timeout_count
          FROM daily_metrics
          FULL OUTER JOIN moderation_metrics
            ON moderation_metrics.guild_id = daily_metrics.guild_id
           AND moderation_metrics.user_id = daily_metrics.user_id
          LEFT JOIN members
            ON members.guild_id = COALESCE(daily_metrics.guild_id, moderation_metrics.guild_id)
           AND members.user_id = COALESCE(daily_metrics.user_id, moderation_metrics.user_id)
        )
    """


def presence_period_ctes(period: str) -> str:
    window = period_window_meta(period)
    start_ts = window["start_ts_expression"]
    end_ts = window["end_ts_expression"]

    def build_presence_cte(cte_name: str, segment_table: str, session_type: str) -> str:
        return f"""
        {cte_name} AS (
          SELECT
            source.guild_id,
            source.user_id,
            SUM(source.duration_seconds)::int AS total_seconds
          FROM (
            SELECT
              segment.guild_id,
              segment.user_id,
              GREATEST(
                EXTRACT(EPOCH FROM (LEAST(segment.ended_at, bounds.end_at) - GREATEST(segment.started_at, bounds.start_at))),
                0
              )::int AS duration_seconds
            FROM {segment_table} AS segment
            CROSS JOIN period_bounds AS bounds
            WHERE segment.ended_at > bounds.start_at
              AND segment.started_at < bounds.end_at
            UNION ALL
            SELECT
              live.guild_id,
              live.user_id,
              GREATEST(
                EXTRACT(EPOCH FROM (
                  LEAST(bounds.end_at, live.last_confirmed_at + INTERVAL '90 seconds')
                  - GREATEST(live.started_at, bounds.start_at)
                )),
                0
              )::int AS duration_seconds
            FROM live_presence_sessions AS live
            CROSS JOIN period_bounds AS bounds
            CROSS JOIN bot_presence_guard AS bot_guard
            WHERE live.session_type = '{session_type}'
              AND bot_guard.include_live_sessions
              AND live.started_at < bounds.end_at
          ) AS source
          WHERE source.duration_seconds > 0
          GROUP BY source.guild_id, source.user_id
        )"""

    return f"""
        period_bounds AS (
          SELECT
            {start_ts} AS start_at,
            LEAST(NOW(), {end_ts}) AS end_at
        ),
        bot_presence_guard AS (
          SELECT COALESCE(
            (
              SELECT last_seen_at >= NOW() - INTERVAL '90 seconds'
              FROM service_heartbeats
              WHERE service_name = 'bot'
              LIMIT 1
            ),
            FALSE
          ) AS include_live_sessions
        ),
        {build_presence_cte("voice_presence", "voice_active_segments", "voice")},
        {build_presence_cte("camera_presence", "camera_segments", "camera")},
        {build_presence_cte("stream_presence", "stream_segments", "stream")}
    """


def fetch_config() -> dict[str, Any]:
    import json
    with engine.begin() as connection:
        row = connection.execute(
            text("SELECT value FROM config_entries WHERE key = :key LIMIT 1"),
            {"key": CONFIG_KEY},
        ).mappings().first()
        
    val = row["value"] if row else {}
    if isinstance(val, str):
        try:
            val = json.loads(val)
        except json.JSONDecodeError:
            val = {}
            
    return deep_merge(DEFAULT_CONFIG, val)


def save_config(config: dict[str, Any]) -> None:
    payload = deep_merge(fetch_config(), config)
    with engine.begin() as connection:
        connection.execute(
            text(
                """
                INSERT INTO config_entries (key, value, updated_at)
                VALUES (:key, CAST(:value AS jsonb), NOW())
                ON CONFLICT (key)
                DO UPDATE SET value = CAST(:value AS jsonb), updated_at = NOW()
                """
            ),
            {"key": CONFIG_KEY, "value": json.dumps(payload)},
        )
    if settings.redis_url and settings.redis_url.lower() not in {"disabled", "none", "off", "false"}:
        try:
            redis = Redis.from_url(settings.redis_url)
            redis.publish(CONFIG_CHANGED_CHANNEL, "reload")
            redis.close()
        except (RedisError, ValueError):
            pass


def get_rank_backfill_status() -> dict[str, Any]:
    guild_id = settings.discord_guild_id
    default_status = {
        "status": "idle",
        "job_started_at": None,
        "voice_cutoff_at": None,
        "text_cutoff_date": None,
        "processed_voice_rows": 0,
        "processed_text_rows": 0,
        "last_error": None,
        "completed_at": None,
        "reward_sync_status": "idle",
        "reward_sync_requested_at": None,
        "reward_sync_completed_at": None,
        "reward_sync_last_error": None,
    }

    if not guild_id:
        return default_status

    with engine.begin() as connection:
        backfill_row = connection.execute(
            text(
                """
                SELECT
                  status,
                  job_started_at,
                  voice_cutoff_at,
                  text_cutoff_date,
                  processed_voice_rows,
                  processed_text_rows,
                  last_error,
                  completed_at
                FROM rank_backfill_jobs
                WHERE guild_id = :guild_id
                LIMIT 1
                """
            ),
            {"guild_id": guild_id},
        ).mappings().first()
        reward_row = connection.execute(
            text(
                """
                SELECT
                  status,
                  requested_at,
                  completed_at,
                  last_error
                FROM rank_reward_sync_jobs
                WHERE guild_id = :guild_id
                LIMIT 1
                """
            ),
            {"guild_id": guild_id},
        ).mappings().first()

    status = dict(default_status)
    if backfill_row:
        status.update(dict(backfill_row))
    if reward_row:
        status["reward_sync_status"] = reward_row["status"]
        status["reward_sync_requested_at"] = reward_row["requested_at"]
        status["reward_sync_completed_at"] = reward_row["completed_at"]
        status["reward_sync_last_error"] = reward_row["last_error"]
    return status


def request_rank_reward_sync() -> None:
    guild_id = settings.discord_guild_id
    if not guild_id:
        return

    with engine.begin() as connection:
        connection.execute(
            text(
                """
                INSERT INTO rank_reward_sync_jobs (guild_id, status, requested_at, completed_at, last_error)
                VALUES (:guild_id, 'pending', NOW(), NULL, NULL)
                ON CONFLICT (guild_id)
                DO UPDATE SET
                  status = 'pending',
                  requested_at = NOW(),
                  completed_at = NULL,
                  last_error = NULL
                """
            ),
            {"guild_id": guild_id},
        )


def reset_rank_system() -> None:
    guild_id = settings.discord_guild_id
    if not guild_id:
        return

    with engine.begin() as connection:
        connection.execute(
            text("DELETE FROM rank_events WHERE guild_id = :guild_id"),
            {"guild_id": guild_id},
        )
        connection.execute(
            text("DELETE FROM rank_profiles WHERE guild_id = :guild_id"),
            {"guild_id": guild_id},
        )
        connection.execute(
            text("DELETE FROM rank_text_state WHERE guild_id = :guild_id"),
            {"guild_id": guild_id},
        )
        connection.execute(
            text("DELETE FROM rank_voice_state WHERE guild_id = :guild_id"),
            {"guild_id": guild_id},
        )
        connection.execute(
            text("DELETE FROM rank_reward_sync_jobs WHERE guild_id = :guild_id"),
            {"guild_id": guild_id},
        )
        connection.execute(
            text(
                """
                INSERT INTO rank_backfill_jobs (
                  guild_id,
                  status,
                  job_started_at,
                  voice_cutoff_at,
                  text_cutoff_date,
                  voice_last_user_id,
                  text_last_user_id,
                  processed_voice_rows,
                  processed_text_rows,
                  last_error,
                  completed_at
                )
                VALUES (
                  :guild_id,
                  'completed',
                  NOW(),
                  NOW(),
                  ((timezone(:timezone, now()))::date - INTERVAL '1 day')::date,
                  NULL,
                  NULL,
                  0,
                  0,
                  NULL,
                  NOW()
                )
                ON CONFLICT (guild_id)
                DO UPDATE SET
                  status = 'completed',
                  job_started_at = NOW(),
                  voice_cutoff_at = NOW(),
                  text_cutoff_date = ((timezone(:timezone, now()))::date - INTERVAL '1 day')::date,
                  voice_last_user_id = NULL,
                  text_last_user_id = NULL,
                  processed_voice_rows = 0,
                  processed_text_rows = 0,
                  last_error = NULL,
                  completed_at = NOW()
                """
            ),
            {
                "guild_id": guild_id,
                "timezone": settings.timezone,
            },
        )


def list_rank_leaderboard(member_scope: str, xp_type: str, limit: int = 50) -> list[dict[str, Any]]:
    guild_id = settings.discord_guild_id
    if not guild_id:
        return []

    scope = member_scope if member_scope in {"user", "staff", "all"} else "user"
    member_filter = ""
    if scope in {"user", "staff"}:
        member_filter = "\n                  AND members.member_type = :member_type"

    with engine.begin() as connection:
        rows = connection.execute(
            text(
                f"""
                SELECT
                  members.user_id::text AS user_id,
                  members.username,
                  members.display_name,
                  members.avatar_url,
                  members.member_type,
                  COALESCE(rank_profiles.voice_xp, 0)::bigint AS voice_xp,
                  COALESCE(rank_profiles.text_xp, 0)::bigint AS text_xp,
                  COALESCE(rank_profiles.voice_level, 0)::int AS voice_level,
                  COALESCE(rank_profiles.text_level, 0)::int AS text_level,
                  CASE
                    WHEN :xp_type = 'voice' THEN COALESCE(rank_profiles.voice_xp, 0)
                    ELSE COALESCE(rank_profiles.text_xp, 0)
                  END::bigint AS selected_xp,
                  CASE
                    WHEN :xp_type = 'voice' THEN COALESCE(rank_profiles.voice_level, 0)
                    ELSE COALESCE(rank_profiles.text_level, 0)
                  END::int AS selected_level
                FROM members
                LEFT JOIN rank_profiles
                  ON rank_profiles.guild_id = members.guild_id
                 AND rank_profiles.user_id = members.user_id
                WHERE members.guild_id = :guild_id
                  {member_filter}
                ORDER BY
                  selected_xp DESC,
                  selected_level DESC,
                  members.display_name ASC
                LIMIT :limit
                """
            ),
            {
                "guild_id": guild_id,
                "member_type": scope,
                "xp_type": xp_type,
                "limit": limit,
            },
        ).mappings().all()

    return [dict(row) for row in rows]


def get_member_rank_detail(user_id: int, member_type: str) -> dict[str, Any]:
    guild_id = settings.discord_guild_id
    if not guild_id:
        return {"profile": None, "events": []}

    with engine.begin() as connection:
        profile_row = connection.execute(
            text(
                """
                WITH current_profile AS (
                  SELECT
                    members.guild_id,
                    members.user_id,
                    members.member_type,
                    COALESCE(rank_profiles.voice_xp, 0)::bigint AS voice_xp,
                    COALESCE(rank_profiles.text_xp, 0)::bigint AS text_xp,
                    COALESCE(rank_profiles.voice_level, 0)::int AS voice_level,
                    COALESCE(rank_profiles.text_level, 0)::int AS text_level
                  FROM members
                  LEFT JOIN rank_profiles
                    ON rank_profiles.guild_id = members.guild_id
                   AND rank_profiles.user_id = members.user_id
                  WHERE members.guild_id = :guild_id
                    AND members.user_id = :user_id
                    AND members.member_type = :member_type
                  LIMIT 1
                )
                SELECT
                  current_profile.*,
                  (
                    SELECT COUNT(*) + 1
                    FROM members
                    LEFT JOIN rank_profiles
                      ON rank_profiles.guild_id = members.guild_id
                     AND rank_profiles.user_id = members.user_id
                    WHERE members.guild_id = :guild_id
                      AND members.member_type = :member_type
                      AND (
                        COALESCE(rank_profiles.voice_xp, 0) > current_profile.voice_xp
                        OR (
                          COALESCE(rank_profiles.voice_xp, 0) = current_profile.voice_xp
                          AND members.user_id < current_profile.user_id
                        )
                      )
                  )::int AS voice_rank,
                  (
                    SELECT COUNT(*) + 1
                    FROM members
                    LEFT JOIN rank_profiles
                      ON rank_profiles.guild_id = members.guild_id
                     AND rank_profiles.user_id = members.user_id
                    WHERE members.guild_id = :guild_id
                      AND members.member_type = :member_type
                      AND (
                        COALESCE(rank_profiles.text_xp, 0) > current_profile.text_xp
                        OR (
                          COALESCE(rank_profiles.text_xp, 0) = current_profile.text_xp
                          AND members.user_id < current_profile.user_id
                        )
                      )
                  )::int AS text_rank
                FROM current_profile
                """
            ),
            {
                "guild_id": guild_id,
                "user_id": user_id,
                "member_type": member_type,
            },
        ).mappings().first()

        event_rows = connection.execute(
            text(
                """
                SELECT
                  xp_type,
                  event_type,
                  xp_delta,
                  total_xp,
                  level_after,
                  source_type,
                  payload,
                  created_at
                FROM rank_events
                WHERE guild_id = :guild_id
                  AND user_id = :user_id
                ORDER BY created_at DESC
                LIMIT 12
                """
            ),
            {"guild_id": guild_id, "user_id": user_id},
        ).mappings().all()

    events = []
    for row in event_rows:
        item = dict(row)
        item["payload"] = json_object(item.get("payload"))
        events.append(item)

    return {
        "profile": dict(profile_row) if profile_row else None,
        "events": events,
    }


def list_guild_roles() -> list[dict[str, Any]]:
    guild_id = settings.discord_guild_id
    if not guild_id:
        return []

    with engine.begin() as connection:
        rows = connection.execute(
            text(
                """
                SELECT
                  role_id::text AS role_id,
                  role_name,
                  position,
                  color_hex,
                  managed,
                  mentionable,
                  COALESCE(permissions, '0') AS permissions
                FROM guild_roles
                WHERE guild_id = :guild_id
                ORDER BY position DESC, role_name ASC
                """
            ),
            {"guild_id": guild_id},
        ).mappings().all()

    return [dict(row) for row in rows]


def list_role_change_events(limit: int = 30) -> list[dict[str, Any]]:
    guild_id = settings.discord_guild_id
    if not guild_id:
        return []

    with engine.begin() as connection:
        rows = connection.execute(
            text(
                """
                SELECT
                  id,
                  guild_id,
                  role_id::text AS role_id,
                  role_name,
                  action_type,
                  actor_id::text AS actor_id,
                  actor_name,
                  actor_avatar_url,
                  reason,
                  change_payload,
                  created_at
                FROM role_change_events
                WHERE guild_id = :guild_id
                ORDER BY created_at DESC
                LIMIT :limit
                """
            ),
            {"guild_id": guild_id, "limit": limit},
        ).mappings().all()

    items: list[dict[str, Any]] = []
    for row in rows:
        item = dict(row)
        item["change_payload"] = json_object(item.get("change_payload"))
        items.append(item)

    return items


def list_role_change_events_for_member(user_id: int, limit: int = 12) -> list[dict[str, Any]]:
    guild_id = settings.discord_guild_id
    if not guild_id:
        return []

    with engine.begin() as connection:
        rows = connection.execute(
            text(
                """
                SELECT
                  id,
                  guild_id,
                  role_id::text AS role_id,
                  role_name,
                  action_type,
                  actor_id::text AS actor_id,
                  actor_name,
                  actor_avatar_url,
                  reason,
                  change_payload,
                  created_at
                FROM role_change_events
                WHERE guild_id = :guild_id
                  AND (
                    actor_id = :user_id
                    OR change_payload -> 'targetMember' ->> 'id' = :user_id_text
                  )
                ORDER BY created_at DESC
                LIMIT :limit
                """
            ),
            {
                "guild_id": guild_id,
                "user_id": user_id,
                "user_id_text": str(user_id),
                "limit": limit,
            },
        ).mappings().all()

    items: list[dict[str, Any]] = []
    for row in rows:
        item = dict(row)
        item["change_payload"] = json_object(item.get("change_payload"))
        items.append(item)

    return items


def list_member_picker_options(member_type: str | None = None) -> list[dict[str, Any]]:
    guild_id = settings.discord_guild_id
    sql = """
        SELECT
          user_id::text AS user_id,
          display_name,
          username,
          avatar_url,
          member_type
        FROM members
        WHERE 1 = 1
    """
    params: dict[str, Any] = {}
    if guild_id:
        sql += "\n  AND guild_id = :guild_id"
        params["guild_id"] = guild_id
    if member_type:
        sql += "\n  AND member_type = :member_type"
        params["member_type"] = member_type
    sql += """
        ORDER BY
          CASE member_type WHEN 'staff' THEN 0 ELSE 1 END,
          display_name ASC,
          username ASC
    """
    with engine.begin() as connection:
        rows = connection.execute(
            text(sql),
            params,
        ).mappings().all()

    return [dict(row) for row in rows]


def get_member_directory_entry(user_id: int) -> dict[str, Any] | None:
    guild_id = settings.discord_guild_id
    sql = """
        SELECT
          user_id::text AS user_id,
          display_name,
          username,
          avatar_url,
          member_type
        FROM members
        WHERE user_id = :user_id
    """
    params: dict[str, Any] = {"user_id": user_id}
    if guild_id:
        sql += "\n  AND guild_id = :guild_id"
        params["guild_id"] = guild_id
    sql += "\nLIMIT 1"
    with engine.begin() as connection:
        row = connection.execute(
            text(sql),
            params,
        ).mappings().first()

    return dict(row) if row else None


def get_staff_message_audit_summary(period: str) -> dict[str, Any]:
    guild_id = settings.discord_guild_id
    if not guild_id:
        return {
            "total_events": 0,
            "edit_count": 0,
            "delete_count": 0,
            "active_staff_count": 0,
        }

    boundary = period_boundary(period)
    with engine.begin() as connection:
        row = connection.execute(
            text(
                """
                SELECT
                  COUNT(*)::int AS total_events,
                  COUNT(*) FILTER (WHERE event_type = 'edit')::int AS edit_count,
                  COUNT(*) FILTER (WHERE event_type = 'delete')::int AS delete_count,
                  COUNT(DISTINCT author_id)::int AS active_staff_count
                FROM staff_message_events
                WHERE guild_id = :guild_id
                  AND created_at >= :boundary
                """
            ),
            {"guild_id": guild_id, "boundary": boundary},
        ).mappings().one()

    return dict(row)


def list_staff_message_events(
    period: str,
    author_id: int | None = None,
    event_type: str | None = None,
    limit: int = 80,
) -> list[dict[str, Any]]:
    guild_id = settings.discord_guild_id
    if not guild_id:
        return []

    boundary = period_boundary(period)
    sql = """
        SELECT
          id,
          guild_id,
          message_id::text AS message_id,
          channel_id::text AS channel_id,
          channel_name,
          author_id::text AS author_id,
          author_display_name,
          author_avatar_url,
          actor_id::text AS actor_id,
          actor_display_name,
          event_type,
          before_content,
          after_content,
          before_attachment_urls,
          after_attachment_urls,
          message_created_at,
          created_at
        FROM staff_message_events
        WHERE guild_id = :guild_id
          AND created_at >= :boundary
    """
    params: dict[str, Any] = {
        "guild_id": guild_id,
        "boundary": boundary,
        "limit": limit,
    }
    if author_id is not None:
        sql += "\n  AND author_id = :author_id"
        params["author_id"] = author_id
    if event_type is not None:
        sql += "\n  AND event_type = :event_type"
        params["event_type"] = event_type
    sql += "\nORDER BY created_at DESC\nLIMIT :limit"
    with engine.begin() as connection:
        rows = connection.execute(
            text(sql),
            params,
        ).mappings().all()

    items: list[dict[str, Any]] = []
    for row in rows:
        item = dict(row)
        item["before_attachment_urls"] = json_array(item.get("before_attachment_urls"))
        item["after_attachment_urls"] = json_array(item.get("after_attachment_urls"))
        items.append(item)

    return items


def list_channel_analysis_actions(limit: int = 20) -> list[dict[str, Any]]:
    guild_id = settings.discord_guild_id
    if not guild_id:
        return []

    with engine.begin() as connection:
        timeout_rows = connection.execute(
            text(
                """
                SELECT
                  moderation_actions.id,
                  moderation_actions.target_id::text AS target_id,
                  COALESCE(members.display_name, moderation_actions.target_id::text) AS target_name,
                  members.avatar_url AS target_avatar_url,
                  moderation_actions.reason,
                  moderation_actions.created_at,
                  'timeout' AS status
                FROM moderation_actions
                LEFT JOIN members
                  ON members.guild_id = moderation_actions.guild_id
                 AND members.user_id = moderation_actions.target_id
                WHERE moderation_actions.guild_id = :guild_id
                  AND moderation_actions.action_type = 'timeout'
                  AND moderation_actions.reason LIKE 'Kanal Analizi:%'
                ORDER BY moderation_actions.created_at DESC
                LIMIT :limit
                """
            ),
            {"guild_id": guild_id, "limit": limit},
        ).mappings().all()

        blocked_rows = connection.execute(
            text(
                """
                SELECT
                  alerts.id,
                  alerts.member_id::text AS target_id,
                  COALESCE(members.display_name, alerts.payload ->> 'userName', alerts.member_id::text) AS target_name,
                  members.avatar_url AS target_avatar_url,
                  alerts.payload,
                  alerts.created_at,
                  'blocked' AS status
                FROM alerts
                LEFT JOIN members
                  ON members.guild_id = alerts.guild_id
                 AND members.user_id = alerts.member_id
                WHERE alerts.guild_id = :guild_id
                  AND alerts.alert_type = 'channel_analysis_blocked'
                ORDER BY alerts.created_at DESC
                LIMIT :limit
                """
            ),
            {"guild_id": guild_id, "limit": limit},
        ).mappings().all()

    items: list[dict[str, Any]] = []
    for row in timeout_rows:
        items.append(dict(row))

    for row in blocked_rows:
        item = dict(row)
        payload = json_object(item.get("payload"))
        channel_name = payload.get("channelName") or f"Kanal {payload.get('channelId')}"
        threshold = payload.get("threshold")
        message_count = payload.get("messageCount")
        blocked_reason = payload.get("blockedReason") or "Timeout uygulanamadı."
        item["reason"] = (
            f"#{channel_name} kanalında son 1 saatte {message_count} mesaj görüldü "
            f"(eşik: {threshold}). {blocked_reason}"
        )
        items.append(item)

    items.sort(
        key=lambda item: item.get("created_at").timestamp()
        if isinstance(item.get("created_at"), datetime)
        else 0,
        reverse=True,
    )
    return items[:limit]


def list_recent_moderation_activity_for_member(
    user_id: int,
    member_type: str,
    period: str,
    limit: int = 12,
) -> list[dict[str, Any]]:
    guild_id = settings.discord_guild_id
    if not guild_id:
        return []

    boundary = period_boundary(period)
    column_name = "actor_id" if member_type == "staff" else "target_id"
    with engine.begin() as connection:
        rows = connection.execute(
            text(
                f"""
                SELECT
                  moderation_actions.id,
                  moderation_actions.action_type,
                  moderation_actions.reason,
                  moderation_actions.created_at,
                  moderation_actions.actor_id::text AS actor_id,
                  actor.display_name AS actor_name,
                  moderation_actions.target_id::text AS target_id,
                  target.display_name AS target_name
                FROM moderation_actions
                LEFT JOIN members AS actor
                  ON actor.guild_id = moderation_actions.guild_id
                 AND actor.user_id = moderation_actions.actor_id
                LEFT JOIN members AS target
                  ON target.guild_id = moderation_actions.guild_id
                 AND target.user_id = moderation_actions.target_id
                WHERE moderation_actions.guild_id = :guild_id
                  AND moderation_actions.created_at >= :boundary
                  AND moderation_actions.{column_name} = :user_id
                ORDER BY moderation_actions.created_at DESC
                LIMIT :limit
                """
            ),
            {
                "guild_id": guild_id,
                "boundary": boundary,
                "user_id": user_id,
                "limit": limit,
            },
        ).mappings().all()

    return [dict(row) for row in rows]


def list_moderation_cases(
    limit: int = 80,
    case_type: str = "all",
    status: str = "all",
    actor_id: int | None = None,
    target_id: int | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
) -> list[dict[str, Any]]:
    guild_id = settings.discord_guild_id
    if not guild_id:
        return []

    clauses = ["moderation_cases.guild_id = :guild_id"]
    params: dict[str, Any] = {"guild_id": guild_id, "limit": max(10, min(limit, 120))}

    if case_type != "all":
        clauses.append("moderation_cases.case_type = :case_type")
        params["case_type"] = case_type
    if status != "all":
        clauses.append("moderation_cases.status = :status")
        params["status"] = status
    if actor_id:
        clauses.append("moderation_cases.actor_id = :actor_id")
        params["actor_id"] = actor_id
    if target_id:
        clauses.append("moderation_cases.target_id = :target_id")
        params["target_id"] = target_id
    if date_from:
        clauses.append("moderation_cases.created_at >= ((:date_from::date) AT TIME ZONE :timezone)")
        params["date_from"] = date_from
        params["timezone"] = settings.timezone
    if date_to:
        clauses.append(
            "moderation_cases.created_at < (((:date_to::date) + INTERVAL '1 day') AT TIME ZONE :timezone)"
        )
        params["date_to"] = date_to
        params["timezone"] = settings.timezone

    where_sql = " AND ".join(clauses)
    with engine.begin() as connection:
        rows = connection.execute(
            text(
                f"""
                SELECT
                  moderation_cases.id,
                  moderation_cases.case_type,
                  moderation_cases.status,
                  moderation_cases.target_type,
                  moderation_cases.target_id::text AS target_id,
                  moderation_cases.actor_id::text AS actor_id,
                  moderation_cases.reason,
                  moderation_cases.dm_requested,
                  moderation_cases.dm_status,
                  moderation_cases.proof_url,
                  moderation_cases.points,
                  moderation_cases.duration_seconds,
                  moderation_cases.expires_at,
                  moderation_cases.metadata,
                  moderation_cases.created_at,
                  moderation_cases.resolved_at,
                  COALESCE(actor.display_name, actor.username, moderation_cases.actor_id::text) AS actor_name,
                  COALESCE(target.display_name, target.username, moderation_cases.target_id::text) AS target_member_name,
                  guild_channels.channel_name AS target_channel_name
                FROM moderation_cases
                LEFT JOIN members AS actor
                  ON actor.guild_id = moderation_cases.guild_id
                 AND actor.user_id = moderation_cases.actor_id
                LEFT JOIN members AS target
                  ON target.guild_id = moderation_cases.guild_id
                 AND target.user_id = moderation_cases.target_id
                 AND moderation_cases.target_type = 'member'
                LEFT JOIN guild_channels
                  ON guild_channels.guild_id = moderation_cases.guild_id
                 AND guild_channels.channel_id = moderation_cases.target_id
                 AND moderation_cases.target_type = 'channel'
                WHERE {where_sql}
                ORDER BY moderation_cases.created_at DESC
                LIMIT :limit
                """
            ),
            params,
        ).mappings().all()

    return [dict(row) for row in rows]


def list_moderation_actions(
    limit: int = 80,
    action_type: str = "all",
    actor_id: int | None = None,
    target_id: int | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
) -> list[dict[str, Any]]:
    guild_id = settings.discord_guild_id
    if not guild_id:
        return []

    clauses = ["moderation_actions.guild_id = :guild_id"]
    params: dict[str, Any] = {"guild_id": guild_id, "limit": max(10, min(limit, 120))}

    if action_type != "all":
        clauses.append("moderation_actions.action_type = :action_type")
        params["action_type"] = action_type
    if actor_id:
        clauses.append("moderation_actions.actor_id = :actor_id")
        params["actor_id"] = actor_id
    if target_id:
        clauses.append("moderation_actions.target_id = :target_id")
        params["target_id"] = target_id
    if date_from:
        clauses.append("moderation_actions.created_at >= ((:date_from::date) AT TIME ZONE :timezone)")
        params["date_from"] = date_from
        params["timezone"] = settings.timezone
    if date_to:
        clauses.append(
            "moderation_actions.created_at < (((:date_to::date) + INTERVAL '1 day') AT TIME ZONE :timezone)"
        )
        params["date_to"] = date_to
        params["timezone"] = settings.timezone

    where_sql = " AND ".join(clauses)
    with engine.begin() as connection:
        rows = connection.execute(
            text(
                f"""
                SELECT
                  moderation_actions.id,
                  moderation_actions.case_id,
                  moderation_actions.action_type,
                  moderation_actions.target_id::text AS target_id,
                  moderation_actions.target_type,
                  moderation_actions.actor_id::text AS actor_id,
                  moderation_actions.reason,
                  moderation_actions.source,
                  moderation_actions.payload,
                  moderation_actions.created_at,
                  COALESCE(actor.display_name, actor.username, moderation_actions.actor_id::text) AS actor_name,
                  COALESCE(target.display_name, target.username, moderation_actions.target_id::text) AS target_member_name,
                  guild_channels.channel_name AS target_channel_name
                FROM moderation_actions
                LEFT JOIN members AS actor
                  ON actor.guild_id = moderation_actions.guild_id
                 AND actor.user_id = moderation_actions.actor_id
                LEFT JOIN members AS target
                  ON target.guild_id = moderation_actions.guild_id
                 AND target.user_id = moderation_actions.target_id
                 AND moderation_actions.target_type = 'member'
                LEFT JOIN guild_channels
                  ON guild_channels.guild_id = moderation_actions.guild_id
                 AND guild_channels.channel_id = moderation_actions.target_id
                 AND moderation_actions.target_type = 'channel'
                WHERE {where_sql}
                ORDER BY moderation_actions.created_at DESC
                LIMIT :limit
                """
            ),
            params,
        ).mappings().all()

    return [dict(row) for row in rows]


def list_moderation_cases_for_member(user_id: int, limit: int = 12) -> list[dict[str, Any]]:
    guild_id = settings.discord_guild_id
    if not guild_id:
        return []

    with engine.begin() as connection:
        rows = connection.execute(
            text(
                """
                SELECT
                  moderation_cases.id,
                  moderation_cases.case_type,
                  moderation_cases.status,
                  moderation_cases.reason,
                  moderation_cases.points,
                  moderation_cases.duration_seconds,
                  moderation_cases.dm_status,
                  moderation_cases.proof_url,
                  moderation_cases.created_at,
                  moderation_cases.resolved_at,
                  moderation_cases.metadata,
                  moderation_cases.actor_id::text AS actor_id,
                  COALESCE(actor.display_name, actor.username, moderation_cases.actor_id::text) AS actor_name
                FROM moderation_cases
                LEFT JOIN members AS actor
                  ON actor.guild_id = moderation_cases.guild_id
                 AND actor.user_id = moderation_cases.actor_id
                WHERE moderation_cases.guild_id = :guild_id
                  AND moderation_cases.target_type = 'member'
                  AND moderation_cases.target_id = :user_id
                ORDER BY moderation_cases.created_at DESC
                LIMIT :limit
                """
            ),
            {"guild_id": guild_id, "user_id": user_id, "limit": limit},
        ).mappings().all()

    return [dict(row) for row in rows]


def list_guild_channels() -> list[dict[str, Any]]:
    guild_id = settings.discord_guild_id
    if not guild_id:
        return []

    with engine.begin() as connection:
        rows = connection.execute(
            text(
                """
                SELECT
                  channel_id::text AS channel_id,
                  channel_name,
                  channel_kind,
                  discord_channel_type,
                  parent_id::text AS parent_id,
                  position
                FROM guild_channels
                WHERE guild_id = :guild_id
                ORDER BY
                  CASE channel_kind
                    WHEN 'category' THEN 0
                    WHEN 'text' THEN 1
                    WHEN 'announcement' THEN 2
                    WHEN 'voice' THEN 3
                    WHEN 'stage' THEN 4
                    WHEN 'forum' THEN 5
                    WHEN 'media' THEN 6
                    ELSE 7
                  END,
                  position DESC,
                  channel_name ASC
                """
            ),
            {"guild_id": guild_id},
        ).mappings().all()

    return [dict(row) for row in rows]


def list_server_backups(limit: int = 8) -> list[dict[str, Any]]:
    guild_id = settings.discord_guild_id
    if not guild_id:
        return []

    with engine.begin() as connection:
        rows = connection.execute(
            text(
                """
                SELECT
                  id,
                  backup_type,
                  created_by::text AS created_by,
                  summary,
                  created_at
                FROM server_backups
                WHERE guild_id = :guild_id
                ORDER BY created_at DESC
                LIMIT :limit
                """
            ),
            {"guild_id": guild_id, "limit": limit},
        ).mappings().all()

    items: list[dict[str, Any]] = []
    for row in rows:
        item = dict(row)
        item["summary"] = json_object(item.get("summary"))
        items.append(item)
    return items


def list_guard_log_events(
    limit: int = 80,
    source: str = "all",
    severity: str = "all",
    feature: str = "all",
    actor_id: int | None = None,
    query: str | None = None,
) -> list[dict[str, Any]]:
    guild_id = settings.discord_guild_id
    if not guild_id:
        return []

    normalized_limit = max(20, min(limit, 200))
    fetch_limit = max(normalized_limit * 3, 180)
    normalized_actor_id = str(actor_id) if actor_id is not None else None
    normalized_query = (query or "").strip().lower()

    with engine.begin() as connection:
        guard_rows = connection.execute(
            text(
                """
                SELECT
                  id,
                  feature_key,
                  event_type,
                  actor_id::text AS actor_id,
                  actor_name,
                  actor_avatar_url,
                  target_id,
                  target_name,
                  severity,
                  action_taken,
                  payload,
                  created_at
                FROM guard_events
                WHERE guild_id = :guild_id
                ORDER BY created_at DESC
                LIMIT :limit
                """
            ),
            {"guild_id": guild_id, "limit": fetch_limit},
        ).mappings().all()

        role_rows = connection.execute(
            text(
                """
                SELECT
                  id,
                  role_id::text AS role_id,
                  role_name,
                  action_type,
                  actor_id::text AS actor_id,
                  actor_name,
                  actor_avatar_url,
                  reason,
                  change_payload,
                  created_at
                FROM role_change_events
                WHERE guild_id = :guild_id
                ORDER BY created_at DESC
                LIMIT :limit
                """
            ),
            {"guild_id": guild_id, "limit": fetch_limit},
        ).mappings().all()

        moderation_rows = connection.execute(
            text(
                """
                SELECT
                  moderation_actions.id,
                  moderation_actions.action_type,
                  moderation_actions.reason,
                  moderation_actions.source,
                  moderation_actions.external_action_id,
                  moderation_actions.created_at,
                  moderation_actions.actor_id::text AS actor_id,
                  COALESCE(actor.display_name, actor.username, moderation_actions.actor_id::text) AS actor_name,
                  actor.avatar_url AS actor_avatar_url,
                  moderation_actions.target_id::text AS target_id,
                  COALESCE(target.display_name, target.username, moderation_actions.target_id::text) AS target_name
                FROM moderation_actions
                LEFT JOIN members AS actor
                  ON actor.guild_id = moderation_actions.guild_id
                 AND actor.user_id = moderation_actions.actor_id
                LEFT JOIN members AS target
                  ON target.guild_id = moderation_actions.guild_id
                 AND target.user_id = moderation_actions.target_id
                WHERE moderation_actions.guild_id = :guild_id
                ORDER BY moderation_actions.created_at DESC
                LIMIT :limit
                """
            ),
            {"guild_id": guild_id, "limit": fetch_limit},
        ).mappings().all()

        backup_rows = connection.execute(
            text(
                """
                SELECT
                  server_backups.id,
                  server_backups.backup_type,
                  server_backups.created_by::text AS created_by,
                  COALESCE(creator.display_name, creator.username, server_backups.created_by::text) AS created_by_name,
                  creator.avatar_url AS created_by_avatar_url,
                  server_backups.summary,
                  server_backups.payload,
                  server_backups.created_at
                FROM server_backups
                LEFT JOIN members AS creator
                  ON creator.guild_id = server_backups.guild_id
                 AND creator.user_id = server_backups.created_by
                WHERE server_backups.guild_id = :guild_id
                ORDER BY server_backups.created_at DESC
                LIMIT :limit
                """
            ),
            {"guild_id": guild_id, "limit": fetch_limit},
        ).mappings().all()

    events: list[dict[str, Any]] = []

    for row in guard_rows:
        item = dict(row)
        payload = json_object(item.get("payload"))
        events.append(
            {
                "log_id": f"guard-{item['id']}",
                "source": "guard",
                "feature_key": str(item.get("feature_key") or "guard"),
                "event_type": str(item.get("event_type") or "event"),
                "severity": str(item.get("severity") or "warning"),
                "actor_id": item.get("actor_id"),
                "actor_name": item.get("actor_name") or item.get("actor_id") or "Bilinmeyen",
                "actor_avatar_url": item.get("actor_avatar_url"),
                "target_id": item.get("target_id"),
                "target_name": item.get("target_name") or item.get("target_id"),
                "action_taken": item.get("action_taken") or "İşlendi",
                "reason": payload.get("auditReason") or payload.get("reason"),
                "payload": payload,
                "created_at": item.get("created_at"),
            }
        )

    for row in role_rows:
        item = dict(row)
        payload = json_object(item.get("change_payload"))
        action_type = str(item.get("action_type") or "update")
        risky = _role_payload_is_risky(action_type, payload)
        events.append(
            {
                "log_id": f"role-{item['id']}",
                "source": "role",
                "feature_key": "role-history",
                "event_type": action_type,
                "severity": "critical" if risky else "warning",
                "actor_id": item.get("actor_id"),
                "actor_name": item.get("actor_name") or item.get("actor_id") or "Bilinmeyen",
                "actor_avatar_url": item.get("actor_avatar_url"),
                "target_id": item.get("role_id"),
                "target_name": item.get("role_name") or item.get("role_id"),
                "action_taken": "Rol Kaydı",
                "reason": item.get("reason"),
                "payload": payload,
                "created_at": item.get("created_at"),
            }
        )

    for row in moderation_rows:
        item = dict(row)
        action_type = str(item.get("action_type") or "timeout")
        source_name = str(item.get("source") or "bot")
        feature_key = "manual-action-guard" if source_name == "audit-log" else "moderation"
        events.append(
            {
                "log_id": f"moderation-{item['id']}",
                "source": "moderation",
                "feature_key": feature_key,
                "event_type": action_type,
                "severity": "critical" if source_name == "audit-log" else "warning",
                "actor_id": item.get("actor_id"),
                "actor_name": item.get("actor_name") or item.get("actor_id") or "Bilinmeyen",
                "actor_avatar_url": item.get("actor_avatar_url"),
                "target_id": item.get("target_id"),
                "target_name": item.get("target_name") or item.get("target_id"),
                "action_taken": "Moderasyon Kaydı" if source_name == "audit-log" else "Bot Moderasyonu",
                "reason": item.get("reason"),
                "payload": {
                    "source": source_name,
                    "reason": item.get("reason"),
                    "externalActionId": item.get("external_action_id"),
                },
                "created_at": item.get("created_at"),
            }
        )

    for row in backup_rows:
        item = dict(row)
        summary = json_object(item.get("summary"))
        payload = json_object(item.get("payload"))
        events.append(
            {
                "log_id": f"backup-{item['id']}",
                "source": "backup",
                "feature_key": "server-backup",
                "event_type": str(item.get("backup_type") or "manual"),
                "severity": "info",
                "actor_id": item.get("created_by"),
                "actor_name": item.get("created_by_name") or item.get("created_by") or "Sistem",
                "actor_avatar_url": item.get("created_by_avatar_url"),
                "target_id": None,
                "target_name": "Sunucu Yedeği",
                "action_taken": "Yedek Oluşturuldu",
                "reason": None,
                "payload": {
                    "summary": summary,
                    "payload": payload,
                },
                "created_at": item.get("created_at"),
            }
        )

    filtered: list[dict[str, Any]] = []
    for event in events:
        if source != "all" and event.get("source") != source:
            continue
        if severity != "all" and event.get("severity") != severity:
            continue
        if feature != "all" and event.get("feature_key") != feature:
            continue
        if normalized_actor_id and str(event.get("actor_id") or "") != normalized_actor_id:
            continue
        if normalized_query and normalized_query not in _normalize_guard_log_search_text(event):
            continue
        filtered.append(event)

    filtered.sort(
        key=lambda item: item.get("created_at") or datetime.min.replace(tzinfo=timezone.utc),
        reverse=True,
    )
    return filtered[:normalized_limit]


def delete_server_backup(backup_id: int) -> bool:
    guild_id = settings.discord_guild_id
    if not guild_id:
        return False

    with engine.begin() as connection:
        result = connection.execute(
            text(
                """
                DELETE FROM server_backups
                WHERE id = :backup_id
                  AND guild_id = :guild_id
                """
            ),
            {"backup_id": backup_id, "guild_id": guild_id},
        )

    return (result.rowcount or 0) > 0


def create_server_backup(backup_type: str = "manual", created_by: int | None = None) -> None:
    guild_id = settings.discord_guild_id
    if not guild_id:
        return

    roles = list_guild_roles()
    channels = list_guild_channels()
    payload = {
        "capturedAt": datetime.now().isoformat(),
        "config": fetch_config().get("ultraProtection", {}),
        "roles": roles,
        "channels": channels,
    }
    summary = {
        "roleCount": len(roles),
        "channelCount": len(channels),
        "backupType": backup_type,
    }

    with engine.begin() as connection:
        connection.execute(
            text(
                """
                INSERT INTO server_backups (
                  guild_id,
                  backup_type,
                  created_by,
                  summary,
                  payload
                )
                VALUES (
                  :guild_id,
                  :backup_type,
                  :created_by,
                  CAST(:summary AS jsonb),
                  CAST(:payload AS jsonb)
                )
                """
            ),
            {
                "guild_id": guild_id,
                "backup_type": backup_type,
                "created_by": created_by,
                "summary": json.dumps(summary),
                "payload": json.dumps(payload),
            },
        )


def get_system_health() -> dict[str, Any]:
    guild_id = settings.discord_guild_id
    db_started = perf_counter()
    payload: dict[str, Any] = {
        "database": {
            "status": "critical",
            "latency_ms": None,
            "checked_at": None,
            "error": None,
        },
        "redis": {
            "status": "disabled",
            "latency_ms": None,
            "checked_at": None,
            "error": None,
        },
        "heartbeats": {},
        "open_alert_count": 0,
        "role_changes_last_day": 0,
        "failed_sync_channel_count": 0,
        "message_audit_events_last_day": 0,
    }

    db_now = datetime.now().astimezone()
    try:
        with engine.begin() as connection:
            db_now_row = connection.execute(
                text("SELECT NOW() AS checked_at")
            ).mappings().one()
            counts_row = connection.execute(
                text(
                    """
                    SELECT
                      (SELECT COUNT(*)::int FROM alerts WHERE resolved_at IS NULL) AS open_alert_count,
                      (
                        SELECT COUNT(*)::int
                        FROM role_change_events
                        WHERE guild_id = :guild_id
                          AND created_at >= NOW() - INTERVAL '1 day'
                      ) AS role_changes_last_day,
                      (
                        SELECT COUNT(*)::int
                        FROM guild_message_sync_channels
                        WHERE guild_id = :guild_id
                          AND status = 'failed'
                      ) AS failed_sync_channel_count,
                      (
                        SELECT COUNT(*)::int
                        FROM staff_message_events
                        WHERE guild_id = :guild_id
                          AND created_at >= NOW() - INTERVAL '1 day'
                      ) AS message_audit_events_last_day
                    """
                ),
                {"guild_id": guild_id or 0},
            ).mappings().one()
            heartbeat_rows = connection.execute(
                text(
                    """
                    SELECT
                      service_name,
                      payload,
                      started_at,
                      last_seen_at
                    FROM service_heartbeats
                    """
                )
            ).mappings().all()

        db_now = db_now_row["checked_at"]
        payload["database"] = {
            "status": "healthy",
            "latency_ms": int((perf_counter() - db_started) * 1000),
            "checked_at": db_now,
            "error": None,
        }
        payload["open_alert_count"] = counts_row["open_alert_count"] or 0
        payload["role_changes_last_day"] = counts_row["role_changes_last_day"] or 0
        payload["failed_sync_channel_count"] = counts_row["failed_sync_channel_count"] or 0
        payload["message_audit_events_last_day"] = counts_row["message_audit_events_last_day"] or 0
        payload["heartbeats"] = {
            row["service_name"]: {
                "payload": json_object(row["payload"]),
                "started_at": row["started_at"],
                "last_seen_at": row["last_seen_at"],
            }
            for row in heartbeat_rows
        }
    except Exception as exc:
        payload["database"] = {
            "status": "critical",
            "latency_ms": int((perf_counter() - db_started) * 1000),
            "checked_at": None,
            "error": str(exc),
        }
        return payload

    redis_url = (settings.redis_url or "").strip()
    if redis_url.lower() in {"", "disabled", "none", "off", "false"}:
        payload["redis"]["checked_at"] = db_now
        return payload

    redis_client = None
    redis_started = perf_counter()
    try:
        redis_client = Redis.from_url(
            redis_url,
            socket_connect_timeout=1,
            socket_timeout=1,
        )
        redis_client.ping()
        payload["redis"] = {
            "status": "healthy",
            "latency_ms": int((perf_counter() - redis_started) * 1000),
            "checked_at": db_now,
            "error": None,
        }
    except (RedisError, ValueError) as exc:
        payload["redis"] = {
            "status": "critical",
            "latency_ms": int((perf_counter() - redis_started) * 1000),
            "checked_at": db_now,
            "error": str(exc),
        }
    finally:
        if redis_client is not None:
            redis_client.close()

    return payload


def get_overview(period: str) -> dict[str, Any]:
    window = period_window_meta(period)
    presence_ctes = presence_period_ctes(period)
    metrics_cte = metrics_period_cte(period)
    sql = f"""
        WITH
        {metrics_cte},
        {presence_ctes},
        server_messages AS (
          SELECT guild_id, user_id, SUM(message_count)::int AS value
          FROM guild_message_daily_stats
          WHERE bucket_date >= {window['start_expression']}
            AND bucket_date < {window['end_expression']}
          GROUP BY guild_id, user_id
        )
        SELECT
          (
            SELECT COUNT(*)
            FROM members
            LEFT JOIN metrics
              ON metrics.guild_id = members.guild_id
             AND metrics.user_id = members.user_id
            LEFT JOIN voice_presence
              ON voice_presence.guild_id = members.guild_id
             AND voice_presence.user_id = members.user_id
            LEFT JOIN server_messages
              ON server_messages.guild_id = members.guild_id
             AND server_messages.user_id = members.user_id
            WHERE members.member_type = 'staff'
              AND members.user_id != :discord_client_id
              AND (
                COALESCE(voice_presence.total_seconds, 0) > 0
                OR COALESCE(metrics.ticket_claim_count, 0) > 0
                OR COALESCE(metrics.ticket_message_count, 0) > 0
                OR COALESCE(metrics.moderation_ban_count, 0) > 0
                OR COALESCE(metrics.moderation_kick_count, 0) > 0
                OR COALESCE(metrics.moderation_timeout_count, 0) > 0
                OR COALESCE(server_messages.value, 0) > 0
              )
          ) AS active_staff_count,
          (
            SELECT COUNT(*)
            FROM ticket_sessions
            WHERE status = 'open'
          ) AS open_ticket_count,
          (
            SELECT COUNT(*)
            FROM ticket_sessions
            WHERE status = 'open'
              AND claimed_by IS NOT NULL
          ) AS claimed_ticket_count,
          (
            SELECT COALESCE(SUM(voice_presence.total_seconds), 0)
            FROM voice_presence
            JOIN members
              ON members.guild_id = voice_presence.guild_id
             AND members.user_id = voice_presence.user_id
            WHERE members.member_type = 'staff' AND members.user_id != :discord_client_id
          ) AS staff_voice_seconds,
          (
            SELECT COALESCE(SUM(camera_presence.total_seconds), 0)
            FROM camera_presence
            JOIN members
              ON members.guild_id = camera_presence.guild_id
             AND members.user_id = camera_presence.user_id
            WHERE members.member_type = 'staff' AND members.user_id != :discord_client_id
          ) AS camera_seconds,
          (
            SELECT COALESCE(SUM(stream_presence.total_seconds), 0)
            FROM stream_presence
            JOIN members
              ON members.guild_id = stream_presence.guild_id
             AND members.user_id = stream_presence.user_id
            WHERE members.member_type = 'staff' AND members.user_id != :discord_client_id
          ) AS stream_seconds,
          (
            SELECT COALESCE(
              SUM(
                moderation_ban_count
                + moderation_kick_count
                + moderation_timeout_count
              ),
              0
            )
            FROM metrics
            WHERE member_type = 'staff' AND user_id != :discord_client_id
          ) AS moderation_actions,
          (
            SELECT COUNT(*)
            FROM alerts
            WHERE resolved_at IS NULL
          ) AS alert_count
    """
    with engine.begin() as connection:
        row = connection.execute(text(sql), {"timezone": settings.timezone, "discord_client_id": settings.discord_client_id or "0"}).mappings().one()
    return dict(row)


def list_members(member_type: str, period: str) -> list[dict[str, Any]]:
    window = period_window_meta(period)
    presence_ctes = presence_period_ctes(period)
    metrics_cte = metrics_period_cte(period)
    sql = f"""
        WITH
        {metrics_cte},
        {presence_ctes},
        period_messages AS (
          SELECT guild_id, user_id, SUM(message_count)::bigint AS period_message_count
          FROM guild_message_daily_stats
          WHERE bucket_date >= {window['start_expression']}
            AND bucket_date < {window['end_expression']}
          GROUP BY guild_id, user_id
        ),
        total_messages AS (
          SELECT guild_id, user_id, SUM(message_count)::bigint AS total_message_count
          FROM guild_message_daily_stats
          GROUP BY guild_id, user_id
        )
        SELECT
          members.user_id,
          members.username,
          members.display_name,
          members.avatar_url,
          members.member_type,
          COALESCE(voice_presence.total_seconds, 0) AS voice_active_seconds,
          COALESCE(camera_presence.total_seconds, 0) AS camera_seconds,
          COALESCE(stream_presence.total_seconds, 0) AS stream_seconds,
          COALESCE(period_messages.period_message_count, 0)::bigint AS server_message_count,
          COALESCE(total_messages.total_message_count, 0)::bigint AS total_message_count,
          COALESCE(metrics.ticket_opened_count, 0) AS ticket_opened_count,
          COALESCE(metrics.ticket_claim_count, 0) AS ticket_claim_count,
          COALESCE(metrics.ticket_message_count, 0) AS ticket_message_count,
          COALESCE(metrics.moderation_ban_count, 0) AS moderation_ban_count,
          COALESCE(metrics.moderation_kick_count, 0) AS moderation_kick_count,
          COALESCE(metrics.moderation_timeout_count, 0) AS moderation_timeout_count
        FROM members
        LEFT JOIN metrics
          ON metrics.guild_id = members.guild_id
         AND metrics.user_id = members.user_id
        LEFT JOIN voice_presence
          ON voice_presence.guild_id = members.guild_id
         AND voice_presence.user_id = members.user_id
        LEFT JOIN camera_presence
          ON camera_presence.guild_id = members.guild_id
         AND camera_presence.user_id = members.user_id
        LEFT JOIN stream_presence
          ON stream_presence.guild_id = members.guild_id
         AND stream_presence.user_id = members.user_id
        LEFT JOIN period_messages
          ON period_messages.guild_id = members.guild_id
         AND period_messages.user_id = members.user_id
        LEFT JOIN total_messages
          ON total_messages.guild_id = members.guild_id
         AND total_messages.user_id = members.user_id
        WHERE members.member_type = :member_type AND members.user_id != :discord_client_id
        ORDER BY
          COALESCE(metrics.ticket_claim_count, 0) DESC,
          COALESCE(total_messages.total_message_count, 0) DESC,
          COALESCE(voice_presence.total_seconds, 0) DESC,
          members.display_name ASC
    """
    with engine.begin() as connection:
        rows = connection.execute(
            text(sql), {"member_type": member_type, "timezone": settings.timezone, "discord_client_id": settings.discord_client_id or "0"}
        ).mappings().all()
    return [dict(row) for row in rows]


def get_member_detail(user_id: int, member_type: str, period: str) -> dict[str, Any]:
    metrics_cte = metrics_period_cte(period)
    boundary = period_boundary(period)
    window = period_window_meta(period)
    presence_ctes = presence_period_ctes(period)
    detail_sql = f"""
        WITH
        {metrics_cte},
        {presence_ctes},
        period_messages AS (
          SELECT guild_id, user_id, SUM(message_count)::bigint AS period_message_count
          FROM guild_message_daily_stats
          WHERE bucket_date >= {window['start_expression']}
            AND bucket_date < {window['end_expression']}
          GROUP BY guild_id, user_id
        ),
        total_messages AS (
          SELECT guild_id, user_id, SUM(message_count)::bigint AS total_message_count
          FROM guild_message_daily_stats
          GROUP BY guild_id, user_id
        )
        SELECT
          members.user_id,
          members.username,
          members.display_name,
          members.avatar_url,
          members.member_type,
          COALESCE(voice_presence.total_seconds, 0) AS voice_active_seconds,
          COALESCE(camera_presence.total_seconds, 0) AS camera_seconds,
          COALESCE(stream_presence.total_seconds, 0) AS stream_seconds,
          COALESCE(period_messages.period_message_count, 0)::bigint AS server_message_count,
          COALESCE(total_messages.total_message_count, 0)::bigint AS total_message_count,
          COALESCE(metrics.ticket_opened_count, 0) AS ticket_opened_count,
          COALESCE(metrics.ticket_claim_count, 0) AS ticket_claim_count,
          COALESCE(metrics.ticket_message_count, 0) AS ticket_message_count,
          COALESCE(metrics.moderation_ban_count, 0) AS moderation_ban_count,
          COALESCE(metrics.moderation_kick_count, 0) AS moderation_kick_count,
          COALESCE(metrics.moderation_timeout_count, 0) AS moderation_timeout_count
        FROM members
        LEFT JOIN metrics
          ON metrics.guild_id = members.guild_id
         AND metrics.user_id = members.user_id
        LEFT JOIN voice_presence
          ON voice_presence.guild_id = members.guild_id
         AND voice_presence.user_id = members.user_id
        LEFT JOIN camera_presence
          ON camera_presence.guild_id = members.guild_id
         AND camera_presence.user_id = members.user_id
        LEFT JOIN stream_presence
          ON stream_presence.guild_id = members.guild_id
         AND stream_presence.user_id = members.user_id
        LEFT JOIN period_messages
          ON period_messages.guild_id = members.guild_id
         AND period_messages.user_id = members.user_id
        LEFT JOIN total_messages
          ON total_messages.guild_id = members.guild_id
         AND total_messages.user_id = members.user_id
        WHERE members.user_id = :user_id
          AND members.member_type = :member_type
        LIMIT 1
    """

    channel_sql = f"""
        WITH period_bounds AS (
          SELECT
            {window['start_ts_expression']} AS start_at,
            LEAST(NOW(), {window['end_ts_expression']}) AS end_at
        ),
        channel_totals AS (
          SELECT
            source.channel_id,
            SUM(source.total_seconds)::int AS total_seconds
          FROM (
            SELECT
              segment.channel_id,
              GREATEST(
                EXTRACT(EPOCH FROM (LEAST(segment.ended_at, bounds.end_at) - GREATEST(segment.started_at, bounds.start_at))),
                0
              )::int AS total_seconds
            FROM voice_active_segments AS segment
            CROSS JOIN period_bounds AS bounds
            WHERE segment.user_id = :user_id
              AND segment.ended_at > bounds.start_at
              AND segment.started_at < bounds.end_at
            UNION ALL
            SELECT
              live.channel_id,
              GREATEST(
                EXTRACT(EPOCH FROM (
                  LEAST(bounds.end_at, live.last_confirmed_at + INTERVAL '90 seconds')
                  - GREATEST(live.started_at, bounds.start_at)
                )),
                0
              )::int AS total_seconds
            FROM live_presence_sessions AS live
            CROSS JOIN period_bounds AS bounds
            WHERE live.user_id = :user_id
              AND live.session_type = 'voice'
              AND live.started_at < bounds.end_at
          ) AS source
          WHERE source.total_seconds > 0
          GROUP BY source.channel_id
        )
        SELECT
          channel_totals.channel_id,
          guild_channels.channel_name,
          total_seconds
        FROM channel_totals
        LEFT JOIN guild_channels
          ON guild_channels.guild_id = :guild_id
         AND guild_channels.channel_id = channel_totals.channel_id
        ORDER BY total_seconds DESC
        LIMIT 10
    """

    heatmap_sql = """
        SELECT
          EXTRACT(HOUR FROM timezone(:timezone, started_at))::int AS hour,
          SUM(duration_seconds)::int AS total_seconds
        FROM voice_active_segments
        WHERE user_id = :user_id
          AND started_at >= :boundary
        GROUP BY hour
        ORDER BY hour
    """

    tickets_sql = """
        SELECT
          ts.id,
          ts.channel_id,
          ts.status,
          ts.created_at,
          ts.claimed_by,
          COALESCE(message_counts.message_count, 0) AS message_count
        FROM ticket_sessions ts
        LEFT JOIN (
          SELECT ticket_id, COUNT(*)::int AS message_count
          FROM ticket_messages
          WHERE author_id = :user_id
          GROUP BY ticket_id
        ) AS message_counts ON message_counts.ticket_id = ts.id
        WHERE
          (ts.owner_id = :user_id OR ts.claimed_by = :user_id OR message_counts.ticket_id IS NOT NULL)
        ORDER BY ts.created_at DESC
        LIMIT 10
    """

    with engine.begin() as connection:
        detail = connection.execute(
            text(detail_sql),
            {"user_id": user_id, "member_type": member_type, "timezone": settings.timezone},
        ).mappings().first()
        channels = connection.execute(
            text(channel_sql),
            {
                "user_id": user_id,
                "boundary": boundary,
                "guild_id": settings.discord_guild_id,
                "timezone": settings.timezone,
            },
        ).mappings().all()
        heatmap = connection.execute(
            text(heatmap_sql),
            {"user_id": user_id, "boundary": boundary, "timezone": settings.timezone},
        ).mappings().all()
        tickets = connection.execute(text(tickets_sql), {"user_id": user_id}).mappings().all()

    return {
        "detail": dict(detail) if detail else None,
        "channels": [dict(row) for row in channels],
        "heatmap": [dict(row) for row in heatmap],
        "tickets": [dict(row) for row in tickets],
    }


def get_ticket_analytics(period: str) -> dict[str, Any]:
    boundary = period_boundary(period)
    metrics_cte = metrics_period_cte(period)
    with engine.begin() as connection:
        summary = connection.execute(
            text(
                """
                SELECT
                  COUNT(*)::int AS total_tickets,
                  COUNT(*) FILTER (WHERE status = 'open')::int AS open_tickets,
                  COUNT(*) FILTER (WHERE claimed_by IS NOT NULL)::int AS claimed_tickets,
                  COALESCE(AVG(EXTRACT(EPOCH FROM (first_response_at - created_at))), 0)::int AS avg_first_response_seconds,
                  COALESCE(AVG(EXTRACT(EPOCH FROM (archived_at - created_at))), 0)::int AS avg_archive_seconds
                FROM ticket_sessions
                WHERE created_at >= :boundary
                """
            ),
            {"boundary": boundary},
        ).mappings().one()

        categories = connection.execute(
            text(
                """
                SELECT category_key, COUNT(*)::int AS total
                FROM ticket_sessions
                WHERE created_at >= :boundary
                GROUP BY category_key
                ORDER BY total DESC
                """
            ),
            {"boundary": boundary},
        ).mappings().all()

        claimers = connection.execute(
            text(
                f"""
                WITH
                {metrics_cte}
                SELECT
                  members.display_name,
                  members.avatar_url,
                  metrics.user_id,
                  metrics.ticket_claim_count
                FROM metrics
                JOIN members ON members.guild_id = metrics.guild_id AND members.user_id = metrics.user_id
                WHERE members.member_type = 'staff'
                ORDER BY metrics.ticket_claim_count DESC, members.display_name ASC
                LIMIT 10
                """
            ),
            {"timezone": settings.timezone},
        ).mappings().all()

        writers = connection.execute(
            text(
                """
                SELECT
                  members.display_name,
                  members.avatar_url,
                  ticket_messages.author_id AS user_id,
                  COUNT(*)::int AS message_count
                FROM ticket_messages
                JOIN members
                  ON members.guild_id = ticket_messages.guild_id
                 AND members.user_id = ticket_messages.author_id
                WHERE ticket_messages.author_type = 'staff'
                  AND ticket_messages.created_at >= :boundary
                GROUP BY members.display_name, members.avatar_url, ticket_messages.author_id
                ORDER BY message_count DESC, members.display_name ASC
                LIMIT 10
                """
            ),
            {"boundary": boundary},
        ).mappings().all()

    return {
        "summary": dict(summary),
        "categories": [dict(row) for row in categories],
        "claimers": [dict(row) for row in claimers],
        "writers": [dict(row) for row in writers],
    }


def get_action_analytics(period: str) -> dict[str, Any]:
    boundary = period_boundary(period)
    with engine.begin() as connection:
        summary = connection.execute(
            text(
                """
                SELECT
                  COUNT(*)::int AS total_actions,
                  COUNT(*) FILTER (WHERE action_type = 'ban')::int AS bans,
                  COUNT(*) FILTER (WHERE action_type = 'kick')::int AS kicks,
                  COUNT(*) FILTER (WHERE action_type = 'timeout')::int AS timeouts
                FROM moderation_actions
                WHERE created_at >= :boundary
                """
            ),
            {"boundary": boundary},
        ).mappings().one()

        leaders = connection.execute(
            text(
                """
                SELECT
                  members.display_name,
                  members.avatar_url,
                  moderation_actions.actor_id AS user_id,
                  COUNT(*) FILTER (WHERE moderation_actions.action_type = 'ban')::int AS bans,
                  COUNT(*) FILTER (WHERE moderation_actions.action_type = 'kick')::int AS kicks,
                  COUNT(*) FILTER (WHERE moderation_actions.action_type = 'timeout')::int AS timeouts
                FROM moderation_actions
                JOIN members
                  ON members.guild_id = moderation_actions.guild_id
                 AND members.user_id = moderation_actions.actor_id
                WHERE moderation_actions.created_at >= :boundary
                GROUP BY members.display_name, members.avatar_url, moderation_actions.actor_id
                ORDER BY (
                  COUNT(*) FILTER (
                    WHERE moderation_actions.action_type IN ('ban', 'kick', 'timeout')
                  )
                ) DESC, members.display_name ASC
                LIMIT 10
                """
            ),
            {"boundary": boundary},
        ).mappings().all()

        timeline = connection.execute(
            text(
                """
                SELECT
                  to_char(timezone(:timezone, created_at), 'YYYY-MM-DD HH24:00') AS bucket,
                  COUNT(*)::int AS total,
                  COUNT(*) FILTER (WHERE action_type = 'ban')::int AS bans,
                  COUNT(*) FILTER (WHERE action_type = 'kick')::int AS kicks,
                  COUNT(*) FILTER (WHERE action_type = 'timeout')::int AS timeouts
                FROM moderation_actions
                WHERE created_at >= :boundary
                GROUP BY bucket
                ORDER BY bucket
                """
            ),
            {"boundary": boundary, "timezone": settings.timezone},
        ).mappings().all()

    return {
        "summary": dict(summary),
        "leaders": [dict(row) for row in leaders],
        "timeline": [dict(row) for row in timeline],
    }


def get_voice_analytics(period: str) -> dict[str, Any]:
    window = period_window_meta(period)
    presence_ctes = presence_period_ctes(period)
    with engine.begin() as connection:
        summary = connection.execute(
            text(
                f"""
                WITH
                {presence_ctes},
                channel_totals AS (
                  SELECT
                    source.guild_id,
                    source.channel_id,
                    SUM(source.total_seconds)::int AS total_seconds
                  FROM (
                    SELECT
                      segment.guild_id,
                      segment.channel_id,
                      GREATEST(
                        EXTRACT(EPOCH FROM (LEAST(segment.ended_at, bounds.end_at) - GREATEST(segment.started_at, bounds.start_at))),
                        0
                      )::int AS total_seconds
                    FROM voice_active_segments AS segment
                    CROSS JOIN period_bounds AS bounds
                    WHERE segment.ended_at > bounds.start_at
                      AND segment.started_at < bounds.end_at
                    UNION ALL
                    SELECT
                      live.guild_id,
                      live.channel_id,
                      GREATEST(
                        EXTRACT(EPOCH FROM (
                          LEAST(bounds.end_at, live.last_confirmed_at + INTERVAL '90 seconds')
                          - GREATEST(live.started_at, bounds.start_at)
                        )),
                        0
                      )::int AS total_seconds
                    FROM live_presence_sessions AS live
                    CROSS JOIN period_bounds AS bounds
                    WHERE live.session_type = 'voice'
                      AND live.started_at < bounds.end_at
                  ) AS source
                  WHERE source.total_seconds > 0
                  GROUP BY source.guild_id, source.channel_id
                )
                SELECT
                  COALESCE(SUM(CASE WHEN members.member_type = 'staff' THEN voice_presence.total_seconds ELSE 0 END), 0)::int AS staff_voice_seconds,
                  COALESCE(SUM(CASE WHEN members.member_type = 'staff' THEN camera_presence.total_seconds ELSE 0 END), 0)::int AS camera_seconds,
                  COALESCE(SUM(CASE WHEN members.member_type = 'staff' THEN stream_presence.total_seconds ELSE 0 END), 0)::int AS stream_seconds,
                  COALESCE(SUM(CASE WHEN members.member_type = 'user' THEN voice_presence.total_seconds ELSE 0 END), 0)::int AS user_voice_seconds,
                  COUNT(*) FILTER (
                    WHERE members.member_type = 'staff'
                      AND (
                        COALESCE(voice_presence.total_seconds, 0) > 0
                        OR COALESCE(camera_presence.total_seconds, 0) > 0
                        OR COALESCE(stream_presence.total_seconds, 0) > 0
                      )
                  )::int AS active_staff_count,
                  COUNT(*) FILTER (
                    WHERE members.member_type = 'user'
                      AND COALESCE(voice_presence.total_seconds, 0) > 0
                  )::int AS active_user_count,
                  (SELECT COUNT(*)::int FROM channel_totals) AS active_room_count
                FROM members
                LEFT JOIN voice_presence
                  ON voice_presence.guild_id = members.guild_id
                 AND voice_presence.user_id = members.user_id
                LEFT JOIN camera_presence
                  ON camera_presence.guild_id = members.guild_id
                 AND camera_presence.user_id = members.user_id
                LEFT JOIN stream_presence
                  ON stream_presence.guild_id = members.guild_id
                 AND stream_presence.user_id = members.user_id
                """
            ),
            {"timezone": settings.timezone},
        ).mappings().one()

        channels = connection.execute(
            text(
                f"""
                WITH period_bounds AS (
                  SELECT
                    {window['start_ts_expression']} AS start_at,
                    LEAST(NOW(), {window['end_ts_expression']}) AS end_at
                ),
                channel_totals AS (
                  SELECT
                    source.guild_id,
                    source.channel_id,
                    SUM(source.total_seconds)::int AS total_seconds
                  FROM (
                    SELECT
                      segment.guild_id,
                      segment.channel_id,
                      GREATEST(
                        EXTRACT(EPOCH FROM (LEAST(segment.ended_at, bounds.end_at) - GREATEST(segment.started_at, bounds.start_at))),
                        0
                      )::int AS total_seconds
                    FROM voice_active_segments AS segment
                    CROSS JOIN period_bounds AS bounds
                    WHERE segment.ended_at > bounds.start_at
                      AND segment.started_at < bounds.end_at
                    UNION ALL
                    SELECT
                      live.guild_id,
                      live.channel_id,
                      GREATEST(
                        EXTRACT(EPOCH FROM (
                          LEAST(bounds.end_at, live.last_confirmed_at + INTERVAL '90 seconds')
                          - GREATEST(live.started_at, bounds.start_at)
                        )),
                        0
                      )::int AS total_seconds
                    FROM live_presence_sessions AS live
                    CROSS JOIN period_bounds AS bounds
                    WHERE live.session_type = 'voice'
                      AND live.started_at < bounds.end_at
                  ) AS source
                  WHERE source.total_seconds > 0
                  GROUP BY source.guild_id, source.channel_id
                )
                SELECT
                  channel_totals.channel_id,
                  COALESCE(guild_channels.channel_name, channel_totals.channel_id::text) AS channel_name,
                  total_seconds
                FROM channel_totals
                LEFT JOIN guild_channels
                  ON guild_channels.guild_id = channel_totals.guild_id
                 AND guild_channels.channel_id = channel_totals.channel_id
                ORDER BY total_seconds DESC
                LIMIT 10
                """
            ),
            {"timezone": settings.timezone},
        ).mappings().all()

        staff = connection.execute(
            text(
                f"""
                WITH
                {presence_ctes}
                SELECT
                  members.display_name,
                  members.user_id,
                  members.avatar_url,
                  COALESCE(voice_presence.total_seconds, 0) AS voice_active_seconds,
                  COALESCE(camera_presence.total_seconds, 0) AS camera_seconds,
                  COALESCE(stream_presence.total_seconds, 0) AS stream_seconds
                FROM members
                LEFT JOIN voice_presence
                  ON voice_presence.guild_id = members.guild_id
                 AND voice_presence.user_id = members.user_id
                LEFT JOIN camera_presence
                  ON camera_presence.guild_id = members.guild_id
                 AND camera_presence.user_id = members.user_id
                LEFT JOIN stream_presence
                  ON stream_presence.guild_id = members.guild_id
                 AND stream_presence.user_id = members.user_id
                WHERE members.member_type = 'staff'
                  AND (
                    COALESCE(voice_presence.total_seconds, 0) > 0
                    OR COALESCE(camera_presence.total_seconds, 0) > 0
                    OR COALESCE(stream_presence.total_seconds, 0) > 0
                  )
                ORDER BY voice_active_seconds DESC, members.display_name ASC
                LIMIT 10
                """
            ),
            {"timezone": settings.timezone},
        ).mappings().all()

        users = connection.execute(
            text(
                f"""
                WITH
                {presence_ctes}
                SELECT
                  members.display_name,
                  members.user_id,
                  members.avatar_url,
                  COALESCE(voice_presence.total_seconds, 0) AS voice_active_seconds
                FROM members
                LEFT JOIN voice_presence
                  ON voice_presence.guild_id = members.guild_id
                 AND voice_presence.user_id = members.user_id
                WHERE members.member_type = 'user'
                  AND COALESCE(voice_presence.total_seconds, 0) > 0
                ORDER BY voice_active_seconds DESC, members.display_name ASC
                LIMIT 10
                """
            ),
            {"timezone": settings.timezone},
        ).mappings().all()

    return {
        "summary": dict(summary),
        "channels": [dict(row) for row in channels],
        "staff": [dict(row) for row in staff],
        "users": [dict(row) for row in users],
    }


def get_alerts() -> list[dict[str, Any]]:
    with engine.begin() as connection:
        rows = connection.execute(
            text(
                """
                SELECT *
                FROM alerts
                WHERE resolved_at IS NULL
                ORDER BY created_at DESC
                LIMIT 20
                """
            )
        ).mappings().all()
    return [dict(row) for row in rows]


def get_message_history_sync_status() -> dict[str, Any]:
    guild_id = settings.discord_guild_id
    default_status = {
        "status": "idle",
        "status_label": "Hazir",
        "requested_at": None,
        "started_at": None,
        "completed_at": None,
        "current_channel_name": None,
        "channels_total": 0,
        "channels_completed": 0,
        "scanned_messages": 0,
        "last_error": None,
    }

    if not guild_id:
        return default_status

    with engine.begin() as connection:
        row = connection.execute(
            text(
                """
                SELECT
                  status,
                  requested_at,
                  started_at,
                  completed_at,
                  current_channel_name,
                  channels_total,
                  channels_completed,
                  scanned_messages,
                  last_error
                FROM guild_sync_jobs
                WHERE guild_id = :guild_id
                  AND task_type = 'message_history'
                LIMIT 1
                """
            ),
            {"guild_id": guild_id},
        ).mappings().first()

    if not row:
        return default_status

    status_labels = {
        "requested": "Sırada",
        "running": "Çalışıyor",
        "completed": "Tamamlandı",
        "failed": "Hata",
    }
    payload = dict(row)
    payload["status_label"] = status_labels.get(payload["status"], "Hazır")
    return payload


def request_message_history_sync(requested_by: int | None = None) -> None:
    guild_id = settings.discord_guild_id
    if not guild_id:
        return

    with engine.begin() as connection:
        connection.execute(
            text(
                """
                UPDATE guild_message_sync_channels
                SET status = 'pending',
                    last_error = NULL
                WHERE guild_id = :guild_id
                  AND status = 'failed'
                """
            ),
            {"guild_id": guild_id},
        )
        connection.execute(
            text(
                """
                INSERT INTO guild_sync_jobs (
                  guild_id,
                  task_type,
                  status,
                  requested_by,
                  requested_at,
                  channels_total,
                  channels_completed,
                  scanned_messages
                )
                VALUES (
                  :guild_id,
                  'message_history',
                  'requested',
                  :requested_by,
                  NOW(),
                  0,
                  0,
                  0
                )
                ON CONFLICT (guild_id, task_type)
                DO UPDATE SET
                  status = CASE
                    WHEN guild_sync_jobs.status = 'running' THEN guild_sync_jobs.status
                    ELSE 'requested'
                  END,
                  requested_by = COALESCE(EXCLUDED.requested_by, guild_sync_jobs.requested_by),
                  requested_at = CASE
                    WHEN guild_sync_jobs.status = 'running' THEN guild_sync_jobs.requested_at
                    ELSE NOW()
                  END,
                  completed_at = CASE
                    WHEN guild_sync_jobs.status = 'running' THEN guild_sync_jobs.completed_at
                    ELSE NULL
                  END,
                  current_channel_id = CASE
                    WHEN guild_sync_jobs.status = 'running' THEN guild_sync_jobs.current_channel_id
                    ELSE NULL
                  END,
                  current_channel_name = CASE
                    WHEN guild_sync_jobs.status = 'running' THEN guild_sync_jobs.current_channel_name
                    ELSE NULL
                  END,
                  last_error = NULL
                """
            ),
            {"guild_id": guild_id, "requested_by": requested_by},
        )


def period_boundary(period: str) -> datetime:
    with engine.begin() as connection:
        expression = period_window_meta(period)["start_ts_expression"]
        safe_expr = expression.replace(":timezone", f"'{settings.timezone}'")
        row = connection.execute(
            text(f"SELECT {safe_expr} AS boundary")
        ).mappings().one()
    return row["boundary"]

def get_unproven_actions(period: str) -> list[dict[str, Any]]:
    boundary = period_boundary(period)
    with engine.begin() as connection:
        connection.execute(
            text(
                """
                UPDATE unproven_actions
                SET is_seen = TRUE
                WHERE created_at >= :boundary
                  AND is_seen = FALSE
                """
            ),
            {"boundary": boundary},
        )
        rows = connection.execute(
            text(
                """
                SELECT
                  ua.id,
                  ua.created_at,
                  ma.action_type,
                  actor.user_id AS actor_id,
                  actor.display_name AS actor_name,
                  actor.avatar_url AS actor_avatar,
                  target.user_id AS target_id,
                  target.display_name AS target_name,
                  target.avatar_url AS target_avatar
                FROM unproven_actions ua
                JOIN moderation_actions ma ON ma.id = ua.action_id
                LEFT JOIN members actor
                  ON actor.guild_id = ua.guild_id AND actor.user_id = ua.actor_id
                LEFT JOIN members target
                  ON target.guild_id = ua.guild_id AND target.user_id = ua.target_id
                WHERE ua.created_at >= :boundary
                ORDER BY ua.created_at DESC
                """
            ),
            {"boundary": boundary},
        ).mappings().all()

    return [dict(row) for row in rows]

def get_unproven_count() -> int:
    with engine.begin() as connection:
        row = connection.execute(
            text("SELECT COUNT(*) AS count FROM unproven_actions WHERE is_seen = FALSE")
        ).mappings().first()
    return int(row["count"]) if row else 0

def clear_unproven_actions():
    with engine.begin() as connection:
        connection.execute(text("DELETE FROM unproven_actions"))
