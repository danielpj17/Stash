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
```

4. Run the manual assets/liabilities setup script from `docs/neon-manual-assets-liabilities.sql` in the same SQL editor.
5. Restart your dev server.
