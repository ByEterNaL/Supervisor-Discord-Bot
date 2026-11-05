ALTER TABLE role_change_events
  DROP CONSTRAINT IF EXISTS role_change_events_action_type_check;

ALTER TABLE role_change_events
  ADD CONSTRAINT role_change_events_action_type_check
  CHECK (action_type IN ('create', 'update', 'delete', 'assign', 'unassign'));
