CREATE TABLE IF NOT EXISTS manual_assets (
  id text PRIMARY KEY,
  name text NOT NULL,
  value numeric(14, 2) NOT NULL,
  category text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS manual_liabilities (
  id text PRIMARY KEY,
  name text NOT NULL,
  value numeric(14, 2) NOT NULL,
  category text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
