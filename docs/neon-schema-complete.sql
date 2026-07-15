-- =====================================================================
-- Stash — complete Neon Postgres schema
-- =====================================================================
-- Paste this ENTIRE file into the Neon SQL Editor and run it once.
-- Safe to re-run: every statement uses IF NOT EXISTS / ON CONFLICT, so
-- existing data is never dropped.
--
-- This consolidates what was previously split across:
--   docs/neon-budget-setup.sql
--   docs/neon-manual-assets-liabilities.sql
--   and several tables that were only auto-created inside API routes.
-- =====================================================================


-- ---------------------------------------------------------------------
-- Budget
-- ---------------------------------------------------------------------

-- Monthly budget allocations, stored as a single JSONB blob.
CREATE TABLE IF NOT EXISTS budget_store (
  id   integer primary key default 1,
  data jsonb not null default '{}'
);

INSERT INTO budget_store (id, data) VALUES (1, '{}')
ON CONFLICT (id) DO NOTHING;


-- ---------------------------------------------------------------------
-- Reconciliation — core state
-- ---------------------------------------------------------------------

-- Hashes of bank rows that have already been processed.
CREATE TABLE IF NOT EXISTS processed_transactions (
  hash         TEXT PRIMARY KEY,
  account_name TEXT,
  processed_at TIMESTAMP DEFAULT now()
);

-- Confirmed account balances used as reconciliation anchors.
CREATE TABLE IF NOT EXISTS account_anchors (
  account_name      TEXT PRIMARY KEY,
  confirmed_balance NUMERIC,
  as_of_date        DATE
);

-- Links a bank row to the Google Sheets transaction it claims.
CREATE TABLE IF NOT EXISTS reconciliation_claim_links (
  bank_hash    TEXT NOT NULL,
  account_name TEXT,
  sheet_name   TEXT NOT NULL DEFAULT 'Expenses',
  sheet_row_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  created_at   TIMESTAMP DEFAULT now(),
  PRIMARY KEY (bank_hash, sheet_name, sheet_row_id),
  UNIQUE (sheet_name, sheet_row_id)
);

-- Links a bank row to a transfer (which may have 1 or 2 legs).
CREATE TABLE IF NOT EXISTS reconciliation_transfer_claim_links (
  transfer_sheet_row_id TEXT NOT NULL,
  bank_hash             TEXT NOT NULL,
  bank_account_name     TEXT,
  bank_amount_cents     INTEGER NOT NULL,
  expected_legs         INTEGER NOT NULL DEFAULT 2 CHECK (expected_legs IN (1, 2)),
  created_at            TIMESTAMP DEFAULT now(),
  PRIMARY KEY (transfer_sheet_row_id, bank_hash),
  UNIQUE (bank_hash)
);

-- Bank statement rows the user has dismissed (won't be matched).
CREATE TABLE IF NOT EXISTS reconciliation_statement_dismissals (
  hash         TEXT NOT NULL,
  account_name TEXT NOT NULL,
  note         TEXT NOT NULL,
  created_at   TIMESTAMP DEFAULT now(),
  PRIMARY KEY (hash, account_name)
);

-- Google Sheets rows the user has dismissed from the unmatched list.
CREATE TABLE IF NOT EXISTS reconciliation_user_sheet_dismissals (
  sheet_name   TEXT NOT NULL,
  sheet_row_id TEXT NOT NULL,
  note         TEXT NOT NULL,
  created_at   TIMESTAMP DEFAULT now(),
  PRIMARY KEY (sheet_name, sheet_row_id)
);


-- ---------------------------------------------------------------------
-- Reconciliation — caches & uploads
-- ---------------------------------------------------------------------

-- Persisted raw CSV rows, keyed by a per-account dedupe key.
CREATE TABLE IF NOT EXISTS reconciliation_csv_rows (
  account_name TEXT NOT NULL,
  dedupe_key   TEXT NOT NULL,
  cells        JSONB NOT NULL,
  created_at   TIMESTAMP DEFAULT now(),
  PRIMARY KEY (account_name, dedupe_key)
);

-- Cached match results per bank row, to avoid recomputing on every load.
CREATE TABLE IF NOT EXISTS reconciliation_match_cache (
  account_name TEXT NOT NULL,
  bank_hash    TEXT NOT NULL,
  match_data   JSONB NOT NULL,
  updated_at   TIMESTAMP DEFAULT now(),
  PRIMARY KEY (account_name, bank_hash)
);

-- Record of uploaded CSV files (bank_hashes lists the rows from each file).
CREATE TABLE IF NOT EXISTS reconciliation_uploaded_files (
  account_name TEXT NOT NULL,
  file_name    TEXT NOT NULL,
  created_at   TIMESTAMP DEFAULT now(),
  bank_hashes  JSONB,
  PRIMARY KEY (account_name, file_name)
);
ALTER TABLE reconciliation_uploaded_files ADD COLUMN IF NOT EXISTS bank_hashes JSONB;


-- ---------------------------------------------------------------------
-- Reconciliation — learning & audit
-- ---------------------------------------------------------------------

-- Merchant memory: tracks recurring patterns to auto-claim after 2+ confirmations.
CREATE TABLE IF NOT EXISTS reconciliation_merchant_memory (
  fingerprint       TEXT NOT NULL,
  bank_account_name TEXT NOT NULL,
  sheet_category    TEXT,
  sheet_account     TEXT,
  confirmed_count   INTEGER NOT NULL DEFAULT 1,
  last_confirmed_at TIMESTAMP DEFAULT now(),
  PRIMARY KEY (fingerprint, bank_account_name)
);

-- Persistent audit log of every reconciliation action.
-- Used by the Activity tab for per-action and per-CSV-upload undo.
CREATE TABLE IF NOT EXISTS reconciliation_activity_log (
  id                    UUID PRIMARY KEY,
  occurred_at           TIMESTAMP NOT NULL DEFAULT now(),
  action_type           TEXT NOT NULL,
  actor                 TEXT NOT NULL,
  csv_upload_id         UUID,
  bulk_action_id        UUID,
  parent_action_id      UUID,
  payload               JSONB NOT NULL,
  reverted_at           TIMESTAMP,
  reverted_by_action_id UUID
);
CREATE INDEX IF NOT EXISTS idx_activity_log_occurred
  ON reconciliation_activity_log(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_log_csv
  ON reconciliation_activity_log(csv_upload_id);


-- ---------------------------------------------------------------------
-- Net worth — manual assets / liabilities
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS manual_assets (
  id               text PRIMARY KEY,
  name             text NOT NULL,
  value            numeric(14, 2) NOT NULL,
  category         text NOT NULL,
  acquisition_date date,
  details          jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS manual_liabilities (
  id               text PRIMARY KEY,
  name             text NOT NULL,
  value            numeric(14, 2) NOT NULL,
  category         text NOT NULL,
  acquisition_date date,
  details          jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Backfill columns on tables that predate this schema.
ALTER TABLE manual_assets      ADD COLUMN IF NOT EXISTS acquisition_date date;
ALTER TABLE manual_assets      ADD COLUMN IF NOT EXISTS details jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE manual_liabilities ADD COLUMN IF NOT EXISTS acquisition_date date;
ALTER TABLE manual_liabilities ADD COLUMN IF NOT EXISTS details jsonb NOT NULL DEFAULT '{}'::jsonb;


-- ---------------------------------------------------------------------
-- Net worth — SnapTrade balance snapshots
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS snaptrade_balance_snapshots (
  id                 bigserial PRIMARY KEY,
  fetched_at         timestamptz NOT NULL,
  balances           jsonb NOT NULL,
  account_count      integer NOT NULL,
  matched_accounts   integer NOT NULL,
  detail_failures    integer NOT NULL,
  fidelity_total     numeric(14, 2) NOT NULL DEFAULT 0,
  fidelity_brokerage numeric(14, 2) NOT NULL DEFAULT 0,
  fidelity_roth_ira  numeric(14, 2) NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_snaptrade_balance_snapshots_fetched_at
  ON snaptrade_balance_snapshots (fetched_at DESC);
