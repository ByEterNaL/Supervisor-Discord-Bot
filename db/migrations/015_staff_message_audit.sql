CREATE TABLE IF NOT EXISTS staff_message_states (
  message_id BIGINT PRIMARY KEY,
  guild_id BIGINT NOT NULL,
  channel_id BIGINT NOT NULL,
  channel_name TEXT NOT NULL,
  author_id BIGINT NOT NULL,
  author_display_name TEXT NOT NULL,
  author_avatar_url TEXT,
  content TEXT NOT NULL DEFAULT '',
  attachment_urls JSONB NOT NULL DEFAULT '[]'::jsonb,
  message_created_at TIMESTAMPTZ NOT NULL,
  last_edited_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS staff_message_states_guild_author_idx
  ON staff_message_states (guild_id, author_id, message_created_at DESC);

CREATE INDEX IF NOT EXISTS staff_message_states_open_idx
  ON staff_message_states (guild_id, deleted_at)
  WHERE deleted_at IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'staff_message_states_set_updated_at'
  ) THEN
    CREATE TRIGGER staff_message_states_set_updated_at
    BEFORE UPDATE ON staff_message_states
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS staff_message_events (
  id BIGSERIAL PRIMARY KEY,
  guild_id BIGINT NOT NULL,
  message_id BIGINT NOT NULL,
  channel_id BIGINT NOT NULL,
  channel_name TEXT NOT NULL,
  author_id BIGINT NOT NULL,
  author_display_name TEXT NOT NULL,
  author_avatar_url TEXT,
  actor_id BIGINT,
  actor_display_name TEXT,
  event_type TEXT NOT NULL CHECK (event_type IN ('edit', 'delete')),
  before_content TEXT,
  after_content TEXT,
  before_attachment_urls JSONB NOT NULL DEFAULT '[]'::jsonb,
  after_attachment_urls JSONB NOT NULL DEFAULT '[]'::jsonb,
  message_created_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS staff_message_events_guild_created_idx
  ON staff_message_events (guild_id, created_at DESC);

CREATE INDEX IF NOT EXISTS staff_message_events_author_created_idx
  ON staff_message_events (guild_id, author_id, created_at DESC);
