-- CK smoke-test lead capture (Cloudflare D1). One table, all projects, routed by `project`.
CREATE TABLE IF NOT EXISTS smoke_leads (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project    TEXT,
  name       TEXT,
  business   TEXT,
  email      TEXT NOT NULL,
  state      TEXT,
  homes      TEXT,
  urgency    TEXT,
  plan       TEXT,
  ref        TEXT,
  ua         TEXT,
  country    TEXT,
  ts         TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS smoke_leads_project_idx ON smoke_leads (project, created_at DESC);
-- Verify after apply:  SELECT name FROM pragma_table_info('smoke_leads');  (must list `plan`)
