CREATE TABLE IF NOT EXISTS moderation_cases (
  id BIGSERIAL PRIMARY KEY,
  guild_id BIGINT NOT NULL,
  case_type TEXT NOT NULL CHECK (
    case_type IN (
      'ban',
      'unban',
      'kick',
      'timeout',
      'untimeout',
      'softban',
      'warn',
      'unwarn',
      'jail',
      'unjail',
      'purge',
      'lock',
      'unlock',
      'slowmode'
    )
  ),
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'active', 'completed', 'removed', 'cancelled', 'failed', 'expired')
  ),
  target_type TEXT NOT NULL CHECK (target_type IN ('member', 'channel')),
  target_id BIGINT NOT NULL,
  actor_id BIGINT NOT NULL,
  reason TEXT,
  dm_requested BOOLEAN NOT NULL DEFAULT TRUE,
  dm_status TEXT CHECK (dm_status IN ('sent', 'failed', 'skipped')),
  proof_url TEXT,
  points INTEGER NOT NULL DEFAULT 0,
  duration_seconds INTEGER,
  expires_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

DROP TRIGGER IF EXISTS moderation_cases_set_updated_at ON moderation_cases;
CREATE TRIGGER moderation_cases_set_updated_at
BEFORE UPDATE ON moderation_cases
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS moderation_cases_guild_created_idx
  ON moderation_cases(guild_id, created_at DESC);
CREATE INDEX IF NOT EXISTS moderation_cases_target_idx
  ON moderation_cases(guild_id, target_id, created_at DESC);
CREATE INDEX IF NOT EXISTS moderation_cases_actor_idx
  ON moderation_cases(guild_id, actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS moderation_cases_active_idx
  ON moderation_cases(guild_id, case_type, target_id, status)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS moderation_case_events (
  id BIGSERIAL PRIMARY KEY,
  case_id BIGINT NOT NULL REFERENCES moderation_cases(id) ON DELETE CASCADE,
  guild_id BIGINT NOT NULL,
  event_type TEXT NOT NULL,
  actor_id BIGINT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS moderation_case_events_case_idx
  ON moderation_case_events(case_id, created_at ASC);
CREATE INDEX IF NOT EXISTS moderation_case_events_guild_idx
  ON moderation_case_events(guild_id, created_at DESC);

ALTER TABLE moderation_actions
  ADD COLUMN IF NOT EXISTS case_id BIGINT REFERENCES moderation_cases(id) ON DELETE SET NULL;

ALTER TABLE moderation_actions
  ADD COLUMN IF NOT EXISTS payload JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE moderation_actions
  ADD COLUMN IF NOT EXISTS target_type TEXT NOT NULL DEFAULT 'member';

ALTER TABLE moderation_actions
DROP CONSTRAINT IF EXISTS moderation_actions_action_type_check;

ALTER TABLE moderation_actions
ADD CONSTRAINT moderation_actions_action_type_check
CHECK (
  action_type IN (
    'ban',
    'unban',
    'kick',
    'timeout',
    'untimeout',
    'softban',
    'warn',
    'unwarn',
    'jail',
    'unjail',
    'purge',
    'lock',
    'unlock',
    'slowmode'
  )
);

ALTER TABLE moderation_actions
DROP CONSTRAINT IF EXISTS moderation_actions_source_check;

ALTER TABLE moderation_actions
ADD CONSTRAINT moderation_actions_source_check
CHECK (source IN ('bot', 'audit-log', 'worker'));

ALTER TABLE moderation_actions
DROP CONSTRAINT IF EXISTS moderation_actions_target_type_check;

ALTER TABLE moderation_actions
ADD CONSTRAINT moderation_actions_target_type_check
CHECK (target_type IN ('member', 'channel'));

ALTER TABLE staff_roles
DROP CONSTRAINT IF EXISTS staff_roles_role_kind_check;

ALTER TABLE staff_roles
ADD CONSTRAINT staff_roles_role_kind_check
CHECK (
  role_kind IN (
    'staff',
    'upper',
    'supervisor',
    'ban',
    'kick',
    'unban',
    'timeout',
    'warn',
    'jail',
    'message_moderation',
    'channel_moderation',
    'history'
  )
);
