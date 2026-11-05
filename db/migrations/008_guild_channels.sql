CREATE TABLE IF NOT EXISTS guild_channels (
  guild_id BIGINT NOT NULL,
  channel_id BIGINT NOT NULL,
  channel_name TEXT NOT NULL,
  channel_kind TEXT NOT NULL,
  discord_channel_type INTEGER NOT NULL,
  parent_id BIGINT,
  position INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (guild_id, channel_id)
);

CREATE INDEX IF NOT EXISTS guild_channels_lookup_idx
ON guild_channels (guild_id, channel_kind, position DESC, channel_name ASC);
