# Neon budget storage setup

Budget data is stored in Neon Postgres so it syncs across devices. Run this SQL once in the Neon SQL editor after creating your project and database.

1. In [Neon](https://neon.tech), create a project and copy the **connection string**. Use the **pooled** (Transaction mode) connection string for Next.js/serverless.
2. Add it to `.env.local`: `DATABASE_URL=postgresql://...` (no quotes around the value).
3. In Neon Dashboard → SQL Editor, run:

```sql
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
```

4. Run the manual assets/liabilities setup script from `docs/neon-manual-assets-liabilities.sql` in the same SQL editor.
5. Restart your dev server.
