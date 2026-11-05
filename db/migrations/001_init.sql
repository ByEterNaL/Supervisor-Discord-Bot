CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS config_entries (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS members (
  guild_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  username TEXT NOT NULL,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  member_type TEXT NOT NULL CHECK (member_type IN ('staff', 'user')),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (guild_id, user_id)
);

CREATE TRIGGER members_set_updated_at
BEFORE UPDATE ON members
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS staff_roles (
  guild_id BIGINT NOT NULL,
  role_id BIGINT NOT NULL,
  role_name TEXT NOT NULL,
  role_kind TEXT NOT NULL CHECK (role_kind IN ('staff', 'upper', 'supervisor', 'ban', 'kick')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (guild_id, role_id)
);

CREATE TABLE IF NOT EXISTS ticket_sessions (
  id BIGSERIAL PRIMARY KEY,
  guild_id BIGINT NOT NULL,
  channel_id BIGINT UNIQUE,
  owner_id BIGINT NOT NULL,
  category_key TEXT NOT NULL DEFAULT 'general',
  join_request BOOLEAN NOT NULL DEFAULT FALSE,
  youtube_username TEXT,
  github_username TEXT,
  status TEXT NOT NULL CHECK (status IN ('open', 'archived', 'deleted')),
  claimed_by BIGINT,
  claimed_at TIMESTAMPTZ,
  first_response_at TIMESTAMPTZ,
  last_called_at TIMESTAMPTZ,
  archive_requested_by BIGINT,
  archived_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER ticket_sessions_set_updated_at
BEFORE UPDATE ON ticket_sessions
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS ticket_claims (
  id BIGSERIAL PRIMARY KEY,
  ticket_id BIGINT NOT NULL REFERENCES ticket_sessions(id) ON DELETE CASCADE,
  claimer_id BIGINT NOT NULL,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ticket_messages (
  id BIGSERIAL PRIMARY KEY,
  ticket_id BIGINT NOT NULL REFERENCES ticket_sessions(id) ON DELETE CASCADE,
  guild_id BIGINT NOT NULL,
  channel_id BIGINT NOT NULL,
  message_id BIGINT NOT NULL,
  author_id BIGINT,
  author_type TEXT NOT NULL CHECK (author_type IN ('staff', 'user', 'system')),
  content_length INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ticket_messages_ticket_idx ON ticket_messages(ticket_id, created_at DESC);

CREATE TABLE IF NOT EXISTS moderation_actions (
  id BIGSERIAL PRIMARY KEY,
  guild_id BIGINT NOT NULL,
  action_type TEXT NOT NULL CHECK (action_type IN ('ban', 'kick')),
  target_id BIGINT NOT NULL,
  actor_id BIGINT NOT NULL,
  reason TEXT,
  source TEXT NOT NULL CHECK (source IN ('bot', 'audit-log')),
  external_action_id TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS moderation_actions_idx ON moderation_actions(guild_id, created_at DESC);

CREATE TABLE IF NOT EXISTS alerts (
  id BIGSERIAL PRIMARY KEY,
  guild_id BIGINT NOT NULL,
  alert_type TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  member_id BIGINT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS alerts_open_idx ON alerts(guild_id, resolved_at) WHERE resolved_at IS NULL;

CREATE TABLE IF NOT EXISTS live_presence_sessions (
  guild_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  session_type TEXT NOT NULL CHECK (session_type IN ('voice', 'camera', 'stream')),
  channel_id BIGINT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (guild_id, user_id, session_type)
);

CREATE TABLE IF NOT EXISTS voice_active_segments (
  id BIGSERIAL,
  guild_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  channel_id BIGINT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ NOT NULL,
  duration_seconds INTEGER NOT NULL,
  PRIMARY KEY (id, started_at)
) PARTITION BY RANGE (started_at);

CREATE TABLE IF NOT EXISTS camera_segments (
  id BIGSERIAL,
  guild_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  channel_id BIGINT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ NOT NULL,
  duration_seconds INTEGER NOT NULL,
  PRIMARY KEY (id, started_at)
) PARTITION BY RANGE (started_at);

CREATE TABLE IF NOT EXISTS stream_segments (
  id BIGSERIAL,
  guild_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  channel_id BIGINT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ NOT NULL,
  duration_seconds INTEGER NOT NULL,
  PRIMARY KEY (id, started_at)
) PARTITION BY RANGE (started_at);

CREATE TABLE IF NOT EXISTS member_daily_metrics (
  guild_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  member_type TEXT NOT NULL CHECK (member_type IN ('staff', 'user')),
  bucket_date DATE NOT NULL,
  voice_active_seconds INTEGER NOT NULL DEFAULT 0,
  camera_seconds INTEGER NOT NULL DEFAULT 0,
  stream_seconds INTEGER NOT NULL DEFAULT 0,
  ticket_opened_count INTEGER NOT NULL DEFAULT 0,
  ticket_claim_count INTEGER NOT NULL DEFAULT 0,
  ticket_message_count INTEGER NOT NULL DEFAULT 0,
  moderation_ban_count INTEGER NOT NULL DEFAULT 0,
  moderation_kick_count INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (guild_id, user_id, bucket_date)
);

CREATE TABLE IF NOT EXISTS member_weekly_metrics (
  guild_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  member_type TEXT NOT NULL CHECK (member_type IN ('staff', 'user')),
  week_start DATE NOT NULL,
  voice_active_seconds INTEGER NOT NULL DEFAULT 0,
  camera_seconds INTEGER NOT NULL DEFAULT 0,
  stream_seconds INTEGER NOT NULL DEFAULT 0,
  ticket_opened_count INTEGER NOT NULL DEFAULT 0,
  ticket_claim_count INTEGER NOT NULL DEFAULT 0,
  ticket_message_count INTEGER NOT NULL DEFAULT 0,
  moderation_ban_count INTEGER NOT NULL DEFAULT 0,
  moderation_kick_count INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (guild_id, user_id, week_start)
);

CREATE TABLE IF NOT EXISTS member_monthly_metrics (
  guild_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  member_type TEXT NOT NULL CHECK (member_type IN ('staff', 'user')),
  month_start DATE NOT NULL,
  voice_active_seconds INTEGER NOT NULL DEFAULT 0,
  camera_seconds INTEGER NOT NULL DEFAULT 0,
  stream_seconds INTEGER NOT NULL DEFAULT 0,
  ticket_opened_count INTEGER NOT NULL DEFAULT 0,
  ticket_claim_count INTEGER NOT NULL DEFAULT 0,
  ticket_message_count INTEGER NOT NULL DEFAULT 0,
  moderation_ban_count INTEGER NOT NULL DEFAULT 0,
  moderation_kick_count INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (guild_id, user_id, month_start)
);

