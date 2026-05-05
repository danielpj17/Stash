-- Neon budget + reconciliation schema.
-- Paste the entire file into Neon SQL Editor and run.
-- Safe to re-run: every CREATE uses IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS budget_store (
  id integer primary key default 1,
  data jsonb not null default '{}'
);

INSERT INTO budget_store (id, data) VALUES (1, '{}')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS processed_transactions (
  hash TEXT PRIMARY KEY,
  account_name TEXT,
  processed_at TIMESTAMP DEFAULT now()
);

CREATE TABLE IF NOT EXISTS account_anchors (
  account_name TEXT PRIMARY KEY,
  confirmed_balance NUMERIC,
  as_of_date DATE
);

CREATE TABLE IF NOT EXISTS reconciliation_claim_links (
  bank_hash TEXT NOT NULL,
  account_name TEXT,
  sheet_name TEXT NOT NULL DEFAULT 'Expenses',
  sheet_row_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  created_at TIMESTAMP DEFAULT now(),
  PRIMARY KEY (bank_hash, sheet_name, sheet_row_id),
  UNIQUE (sheet_name, sheet_row_id)
);

CREATE TABLE IF NOT EXISTS reconciliation_transfer_claim_links (
  transfer_sheet_row_id TEXT NOT NULL,
  bank_hash TEXT NOT NULL,
  bank_account_name TEXT,
  bank_amount_cents INTEGER NOT NULL,
  expected_legs INTEGER NOT NULL DEFAULT 2 CHECK (expected_legs IN (1, 2)),
  created_at TIMESTAMP DEFAULT now(),
  PRIMARY KEY (transfer_sheet_row_id, bank_hash),
  UNIQUE (bank_hash)
);

CREATE TABLE IF NOT EXISTS reconciliation_statement_dismissals (
  hash TEXT NOT NULL,
  account_name TEXT NOT NULL,
  note TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT now(),
  PRIMARY KEY (hash, account_name)
);

-- Merchant memory: tracks recurring patterns to auto-claim after 2+ confirmations.
CREATE TABLE IF NOT EXISTS reconciliation_merchant_memory (
  fingerprint TEXT NOT NULL,
  bank_account_name TEXT NOT NULL,
  sheet_category TEXT,
  sheet_account TEXT,
  confirmed_count INTEGER NOT NULL DEFAULT 1,
  last_confirmed_at TIMESTAMP DEFAULT now(),
  PRIMARY KEY (fingerprint, bank_account_name)
);

-- Persistent audit log of every reconciliation action.
-- Used by the Activity tab for per-action and per-CSV-upload undo.
CREATE TABLE IF NOT EXISTS reconciliation_activity_log (
  id UUID PRIMARY KEY,
  occurred_at TIMESTAMP NOT NULL DEFAULT now(),
  action_type TEXT NOT NULL,
  actor TEXT NOT NULL,
  csv_upload_id UUID,
  bulk_action_id UUID,
  parent_action_id UUID,
  payload JSONB NOT NULL,
  reverted_at TIMESTAMP,
  reverted_by_action_id UUID
);
CREATE INDEX IF NOT EXISTS idx_activity_log_occurred
  ON reconciliation_activity_log(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_log_csv
  ON reconciliation_activity_log(csv_upload_id);
