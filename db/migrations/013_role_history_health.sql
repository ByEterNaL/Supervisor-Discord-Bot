CREATE TABLE IF NOT EXISTS role_change_events (
  id BIGSERIAL PRIMARY KEY,
  guild_id BIGINT NOT NULL,
  role_id BIGINT NOT NULL,
  role_name TEXT NOT NULL,
  action_type TEXT NOT NULL CHECK (action_type IN ('create', 'update', 'delete')),
  actor_id BIGINT,
  actor_name TEXT,
  actor_avatar_url TEXT,
  reason TEXT,
  change_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  external_change_id TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS role_change_events_guild_created_idx
  ON role_change_events (guild_id, created_at DESC);

CREATE INDEX IF NOT EXISTS role_change_events_role_created_idx
  ON role_change_events (guild_id, role_id, created_at DESC);

CREATE TABLE IF NOT EXISTS service_heartbeats (
  service_name TEXT PRIMARY KEY,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'service_heartbeats_set_updated_at'
  ) THEN
    CREATE TRIGGER service_heartbeats_set_updated_at
    BEFORE UPDATE ON service_heartbeats
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();
  END IF;
END;
$$;
