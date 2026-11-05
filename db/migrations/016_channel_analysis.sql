CREATE TABLE IF NOT EXISTS channel_analysis_message_events (
  message_id BIGINT PRIMARY KEY,
  guild_id BIGINT NOT NULL,
  channel_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS channel_analysis_events_lookup_idx
  ON channel_analysis_message_events (guild_id, channel_id, user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS channel_analysis_events_prune_idx
  ON channel_analysis_message_events (created_at);
