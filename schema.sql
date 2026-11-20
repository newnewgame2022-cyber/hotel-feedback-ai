CREATE TABLE IF NOT EXISTS feedbacks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guest_name TEXT NOT NULL,
  room TEXT DEFAULT '',
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment TEXT NOT NULL,
  sentiment TEXT NOT NULL,
  score REAL NOT NULL,
  aspects TEXT DEFAULT '{}',
  urgency TEXT DEFAULT 'low',
  summary TEXT DEFAULT '',
  source TEXT DEFAULT 'rules',
  status TEXT DEFAULT 'new',
  reply TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_fb_created ON feedbacks(created_at);
CREATE TABLE IF NOT EXISTS feedback_access (
  feedback_id INTEGER PRIMARY KEY REFERENCES feedbacks(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE
);
