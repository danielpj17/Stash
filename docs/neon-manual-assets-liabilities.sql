CREATE TABLE IF NOT EXISTS manual_assets (
  id text PRIMARY KEY,
  name text NOT NULL,
  value numeric(14, 2) NOT NULL,
  category text NOT NULL,
  acquisition_date date,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS manual_liabilities (
  id text PRIMARY KEY,
  name text NOT NULL,
  value numeric(14, 2) NOT NULL,
  category text NOT NULL,
  acquisition_date date,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE manual_assets ADD COLUMN IF NOT EXISTS acquisition_date date;
ALTER TABLE manual_assets ADD COLUMN IF NOT EXISTS details jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE manual_liabilities ADD COLUMN IF NOT EXISTS acquisition_date date;
ALTER TABLE manual_liabilities ADD COLUMN IF NOT EXISTS details jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS snaptrade_balance_snapshots (
  id bigserial PRIMARY KEY,
  fetched_at timestamptz NOT NULL,
  balances jsonb NOT NULL,
  account_count integer NOT NULL,
  matched_accounts integer NOT NULL,
  detail_failures integer NOT NULL,
  fidelity_total numeric(14, 2) NOT NULL DEFAULT 0,
  fidelity_brokerage numeric(14, 2) NOT NULL DEFAULT 0,
  fidelity_roth_ira numeric(14, 2) NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_snaptrade_balance_snapshots_fetched_at
ON snaptrade_balance_snapshots (fetched_at DESC);
