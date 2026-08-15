
UPDATE boards
SET board_name = COALESCE(board_name, source || ' ' || board_date),
    created_at = COALESCE(created_at, CURRENT_TIMESTAMP),
    updated_at = COALESCE(updated_at, CURRENT_TIMESTAMP);

CREATE TABLE IF NOT EXISTS web_audit_events (
  web_audit_event_id INTEGER PRIMARY KEY,
  event_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id INTEGER,
  event_details TEXT,
  actor_email TEXT,
  actor_subject TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_web_audit_events_created_at
  ON web_audit_events(created_at);

CREATE INDEX IF NOT EXISTS idx_web_audit_events_actor_email
  ON web_audit_events(actor_email);

CREATE INDEX IF NOT EXISTS idx_boards_status_date
  ON boards(status, board_date);
