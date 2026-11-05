CREATE TABLE IF NOT EXISTS moderation_proof_messages (
  id BIGSERIAL PRIMARY KEY,
  guild_id BIGINT NOT NULL,
  channel_id BIGINT NOT NULL,
  message_id BIGINT NOT NULL UNIQUE,
  author_id BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS moderation_proof_messages_author_idx ON moderation_proof_messages(author_id, created_at DESC);

CREATE TABLE IF NOT EXISTS unproven_actions (
  id BIGSERIAL PRIMARY KEY,
  action_id BIGINT NOT NULL REFERENCES moderation_actions(id) ON DELETE CASCADE UNIQUE,
  guild_id BIGINT NOT NULL,
  actor_id BIGINT NOT NULL,
  target_id BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS unproven_actions_guild_idx ON unproven_actions(guild_id, created_at DESC);
