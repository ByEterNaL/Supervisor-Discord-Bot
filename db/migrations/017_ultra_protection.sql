CREATE TABLE IF NOT EXISTS guard_events (
  id BIGSERIAL PRIMARY KEY,
  guild_id BIGINT NOT NULL,
  feature_key TEXT NOT NULL,
  event_type TEXT NOT NULL,
  actor_id BIGINT,
  actor_name TEXT,
  actor_avatar_url TEXT,
  target_id TEXT,
  target_name TEXT,
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  action_taken TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  external_guard_id TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS guard_events_guild_created_idx
  ON guard_events (guild_id, created_at DESC);

CREATE INDEX IF NOT EXISTS guard_events_actor_created_idx
  ON guard_events (guild_id, actor_id, created_at DESC);

CREATE TABLE IF NOT EXISTS server_backups (
  id BIGSERIAL PRIMARY KEY,
  guild_id BIGINT NOT NULL,
  backup_type TEXT NOT NULL,
  created_by BIGINT,
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS server_backups_guild_created_idx
  ON server_backups (guild_id, created_at DESC);
