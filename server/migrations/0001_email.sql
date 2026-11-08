CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('verification', 'round')),
  organizer_hash TEXT NOT NULL,
  payload TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'sending', 'sent')),
  email_count INTEGER NOT NULL CHECK (email_count BETWEEN 1 AND 50),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER NOT NULL DEFAULT (unixepoch() + 82800),
  lease_until INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE recipients (
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  email_hash TEXT NOT NULL,
  PRIMARY KEY (job_id, email_hash)
);

CREATE TABLE blocked_recipients (
  email_hash TEXT PRIMARY KEY
);

CREATE TABLE quotas (
  bucket TEXT PRIMARY KEY,
  used INTEGER NOT NULL,
  maximum INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TRIGGER enforce_quota BEFORE UPDATE OF used ON quotas
WHEN NEW.used > NEW.maximum
BEGIN
  SELECT RAISE(ABORT, 'sending_limit');
END;

CREATE TRIGGER enforce_initial_quota BEFORE INSERT ON quotas
WHEN NEW.used > NEW.maximum
BEGIN
  SELECT RAISE(ABORT, 'sending_limit');
END;

CREATE TRIGGER reserve_job_quota AFTER INSERT ON jobs
BEGIN
  INSERT INTO quotas VALUES ('daily:' || date('now'), NEW.email_count, 100, unixepoch() + 172800)
    ON CONFLICT(bucket) DO UPDATE SET used = used + excluded.used;
  INSERT INTO quotas VALUES ('monthly:' || strftime('%Y-%m', 'now'), NEW.email_count, 3000, unixepoch() + 2764800)
    ON CONFLICT(bucket) DO UPDATE SET used = used + excluded.used;
  INSERT INTO quotas VALUES (NEW.kind || ':' || NEW.organizer_hash || ':' || date('now'), 1,
    CASE NEW.kind WHEN 'verification' THEN 3 ELSE 2 END, unixepoch() + 172800)
    ON CONFLICT(bucket) DO UPDATE SET used = used + 1;
END;

CREATE TRIGGER reserve_recipient_quota AFTER INSERT ON recipients
BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM blocked_recipients WHERE email_hash = NEW.email_hash)
    THEN RAISE(ABORT, 'recipient_blocked') END;
  INSERT INTO quotas VALUES ('recipient:' || NEW.email_hash || ':' || date('now'), 1, 3, unixepoch() + 172800)
    ON CONFLICT(bucket) DO UPDATE SET used = used + 1;
END;

CREATE INDEX jobs_expiry ON jobs(expires_at);
CREATE INDEX quotas_expiry ON quotas(expires_at);
