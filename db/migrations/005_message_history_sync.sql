CREATE TABLE IF NOT EXISTS guild_message_daily_stats (
  guild_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  bucket_date DATE NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (guild_id, user_id, bucket_date)
);

CREATE INDEX IF NOT EXISTS guild_message_daily_stats_bucket_idx
  ON guild_message_daily_stats (guild_id, bucket_date, user_id);

CREATE TRIGGER guild_message_daily_stats_set_updated_at
BEFORE UPDATE ON guild_message_daily_stats
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS guild_sync_jobs (
  guild_id BIGINT NOT NULL,
  task_type TEXT NOT NULL CHECK (task_type IN ('message_history')),
  status TEXT NOT NULL CHECK (status IN ('requested', 'running', 'completed', 'failed')),
  requested_by BIGINT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  cutoff_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  current_channel_id BIGINT,
  current_channel_name TEXT,
  channels_total INTEGER NOT NULL DEFAULT 0,
  channels_completed INTEGER NOT NULL DEFAULT 0,
  scanned_messages BIGINT NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (guild_id, task_type)
);

CREATE TRIGGER guild_sync_jobs_set_updated_at
BEFORE UPDATE ON guild_sync_jobs
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS guild_message_sync_channels (
  guild_id BIGINT NOT NULL,
  channel_id BIGINT NOT NULL,
  channel_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'skipped', 'failed')),
  next_before_message_id BIGINT,
  scanned_messages BIGINT NOT NULL DEFAULT 0,
  last_message_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (guild_id, channel_id)
);

CREATE INDEX IF NOT EXISTS guild_message_sync_channels_status_idx
  ON guild_message_sync_channels (guild_id, status, updated_at);

CREATE TRIGGER guild_message_sync_channels_set_updated_at
BEFORE UPDATE ON guild_message_sync_channels
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();
