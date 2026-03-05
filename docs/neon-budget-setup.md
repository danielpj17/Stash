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
```

4. Restart your dev server.
