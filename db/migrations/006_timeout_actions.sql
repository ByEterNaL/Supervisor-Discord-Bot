ALTER TABLE moderation_actions
DROP CONSTRAINT IF EXISTS moderation_actions_action_type_check;

ALTER TABLE moderation_actions
ADD CONSTRAINT moderation_actions_action_type_check
CHECK (action_type IN ('ban', 'kick', 'timeout'));

ALTER TABLE member_daily_metrics
ADD COLUMN IF NOT EXISTS moderation_timeout_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE member_weekly_metrics
ADD COLUMN IF NOT EXISTS moderation_timeout_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE member_monthly_metrics
ADD COLUMN IF NOT EXISTS moderation_timeout_count INTEGER NOT NULL DEFAULT 0;
