ALTER TABLE live_presence_sessions
ADD COLUMN IF NOT EXISTS last_confirmed_at TIMESTAMPTZ;

UPDATE live_presence_sessions
SET last_confirmed_at = COALESCE(last_confirmed_at, started_at)
WHERE last_confirmed_at IS NULL;

ALTER TABLE live_presence_sessions
ALTER COLUMN last_confirmed_at SET NOT NULL;

ALTER TABLE live_presence_sessions
ALTER COLUMN last_confirmed_at SET DEFAULT NOW();
