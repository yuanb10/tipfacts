-- TipFacts Postgres schema (Sprint 1).
-- Apply with: npm run migrate   (requires DATABASE_URL)
-- Safe to run repeatedly: every statement is IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS venues (
  id         TEXT PRIMARY KEY,          -- slug: slugify(name) || '--' || slugify(city) [+ '--' || slugify(disambiguator)]
  name       TEXT NOT NULL,
  city       TEXT NOT NULL,
  area       TEXT NOT NULL DEFAULT '',
  is_seed    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Venue-coverage columns (safe to re-run: IF NOT EXISTS).
ALTER TABLE venues ADD COLUMN IF NOT EXISTS address  TEXT NOT NULL DEFAULT '';
ALTER TABLE venues ADD COLUMN IF NOT EXISTS lat      DOUBLE PRECISION;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS lng      DOUBLE PRECISION;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT '';
ALTER TABLE venues ADD COLUMN IF NOT EXISTS source   TEXT NOT NULL DEFAULT 'manual';

CREATE TABLE IF NOT EXISTS reports (
  id                 TEXT PRIMARY KEY,
  venue_id           TEXT NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  venue_name         TEXT NOT NULL,     -- as entered by the reporter
  city               TEXT NOT NULL,
  area               TEXT NOT NULL DEFAULT '',
  service_type       TEXT NOT NULL,     -- counter | table | takeout | nonfood
  screen_presentation TEXT NOT NULL DEFAULT '',
  presets            TEXT NOT NULL DEFAULT '',
  tip_base           TEXT NOT NULL DEFAULT '',  -- pre-tax | post-tax | not-sure | ''
  fees               JSONB NOT NULL DEFAULT '[]',
  guilt              TEXT NOT NULL DEFAULT 'skip',  -- yes | no | skip (subjective, never scored)
  easy_opt_out       TEXT NOT NULL DEFAULT 'skip',  -- yes | no | skip (screen fact)
  experience_note    TEXT NOT NULL DEFAULT '',       -- subjective, never scored
  notes              TEXT NOT NULL DEFAULT '',
  evidence_ids       JSONB NOT NULL DEFAULT '[]',
  moderation_status  TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  moderation_note    TEXT NOT NULL DEFAULT '',
  decided_at         TIMESTAMPTZ,
  reporter_hash      TEXT NOT NULL DEFAULT '',  -- sha256(ip); raw IPs never stored
  is_seed            BOOLEAN NOT NULL DEFAULT FALSE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reports_venue  ON reports(venue_id);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(moderation_status);
CREATE INDEX IF NOT EXISTS idx_reports_created ON reports(created_at DESC);

-- One photo. original_path is NEVER web-served; only redacted_path is public,
-- and only after the uploader confirms the redaction.
CREATE TABLE IF NOT EXISTS evidence (
  id               TEXT PRIMARY KEY,
  report_id        TEXT REFERENCES reports(id) ON DELETE SET NULL,
  type             TEXT NOT NULL,       -- receipt | screen
  original_path    TEXT NOT NULL,       -- e.g. data/uploads-private/<id>.png
  redacted_path    TEXT,                -- e.g. /uploads/<id>-redacted.png
  redaction_status TEXT NOT NULL DEFAULT 'pending', -- pending | confirmed | failed | manual
  user_confirmed   BOOLEAN NOT NULL DEFAULT FALSE,
  parsed           JSONB,               -- ReceiptParsed: merchant/subtotal/tax/tip/..., ocrEngine
  is_seed          BOOLEAN NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_evidence_report ON evidence(report_id);

-- Durable rate limiting: one row per hit; checkRateLimit prunes old rows.
CREATE TABLE IF NOT EXISTS rate_limit_hits (
  key TEXT NOT NULL,
  ts  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rl_key_ts ON rate_limit_hits(key, ts);

-- Moderation audit trail: every approve/reject is logged.
CREATE TABLE IF NOT EXISTS moderation_actions (
  id         TEXT PRIMARY KEY,
  report_id  TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  action     TEXT NOT NULL,             -- approved | rejected
  note       TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mod_report ON moderation_actions(report_id);
