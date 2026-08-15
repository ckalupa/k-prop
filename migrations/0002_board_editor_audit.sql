-- The actor identity columns live on web_audit_events, which is created in 0003.
-- Do not index audit_events.actor_email here because audit_events has no such column.
CREATE INDEX IF NOT EXISTS idx_boards_status_date
  ON boards(status, board_date);
