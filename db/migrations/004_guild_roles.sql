CREATE TABLE IF NOT EXISTS guild_roles (
  guild_id BIGINT NOT NULL,
  role_id BIGINT NOT NULL,
  role_name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  color_hex TEXT,
  managed BOOLEAN NOT NULL DEFAULT FALSE,
  mentionable BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (guild_id, role_id)
);

CREATE INDEX IF NOT EXISTS guild_roles_lookup_idx
  ON guild_roles (guild_id, position DESC, role_name ASC);
