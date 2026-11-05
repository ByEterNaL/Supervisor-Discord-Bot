ALTER TABLE moderation_proof_messages ADD COLUMN IF NOT EXISTS action_id BIGINT UNIQUE REFERENCES moderation_actions(id) ON DELETE SET NULL;
