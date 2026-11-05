CREATE TABLE IF NOT EXISTS rank_profiles (
  guild_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  member_type TEXT NOT NULL CHECK (member_type IN ('staff', 'user')),
  voice_xp BIGINT NOT NULL DEFAULT 0,
  text_xp BIGINT NOT NULL DEFAULT 0,
  voice_level INTEGER NOT NULL DEFAULT 0,
  text_level INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (guild_id, user_id)
);

CREATE INDEX IF NOT EXISTS rank_profiles_voice_idx
  ON rank_profiles (guild_id, voice_xp DESC, user_id);

CREATE INDEX IF NOT EXISTS rank_profiles_text_idx
  ON rank_profiles (guild_id, text_xp DESC, user_id);

CREATE TRIGGER rank_profiles_set_updated_at
BEFORE UPDATE ON rank_profiles
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS rank_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  member_type TEXT NOT NULL CHECK (member_type IN ('staff', 'user')),
  xp_type TEXT NOT NULL CHECK (xp_type IN ('voice', 'text')),
  event_type TEXT NOT NULL CHECK (event_type IN ('xp_gain', 'level_up', 'backfill')),
  xp_delta INTEGER NOT NULL DEFAULT 0,
  total_xp BIGINT NOT NULL DEFAULT 0,
  level_after INTEGER NOT NULL DEFAULT 0,
  source_type TEXT NOT NULL,
  source_ref TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  role_sync_processed_at TIMESTAMPTZ,
  announcement_processed_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS rank_events_source_ref_idx
  ON rank_events (guild_id, xp_type, source_type, source_ref)
  WHERE source_ref IS NOT NULL;

CREATE INDEX IF NOT EXISTS rank_events_user_idx
  ON rank_events (guild_id, user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS rank_events_pending_role_sync_idx
  ON rank_events (guild_id, created_at ASC)
  WHERE event_type = 'level_up' AND role_sync_processed_at IS NULL;

CREATE INDEX IF NOT EXISTS rank_events_pending_announcement_idx
  ON rank_events (guild_id, created_at ASC)
  WHERE event_type = 'level_up' AND announcement_processed_at IS NULL;

CREATE TABLE IF NOT EXISTS rank_text_state (
  guild_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  last_eligible_at TIMESTAMPTZ,
  recent_contents JSONB NOT NULL DEFAULT '[]'::jsonb,
  hour_window_started_at TIMESTAMPTZ,
  hour_message_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (guild_id, user_id)
);

CREATE TRIGGER rank_text_state_set_updated_at
BEFORE UPDATE ON rank_text_state
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS rank_voice_state (
  guild_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  last_processed_at TIMESTAMPTZ,
  carry_seconds INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (guild_id, user_id)
);

CREATE TRIGGER rank_voice_state_set_updated_at
BEFORE UPDATE ON rank_voice_state
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS rank_backfill_jobs (
  guild_id BIGINT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  job_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  voice_cutoff_at TIMESTAMPTZ,
  text_cutoff_date DATE,
  voice_last_user_id BIGINT,
  text_last_user_id BIGINT,
  processed_voice_rows BIGINT NOT NULL DEFAULT 0,
  processed_text_rows BIGINT NOT NULL DEFAULT 0,
  last_error TEXT,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER rank_backfill_jobs_set_updated_at
BEFORE UPDATE ON rank_backfill_jobs
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS rank_reward_sync_jobs (
  guild_id BIGINT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER rank_reward_sync_jobs_set_updated_at
BEFORE UPDATE ON rank_reward_sync_jobs
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();
