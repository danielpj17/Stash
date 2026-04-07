import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function OPTIONS() {
  return new Response(null, { status: 204 });
}

type MatchCacheRow = {
  account_name: string;
  bank_hash: string;
  match_data: unknown;
};

async function ensureMatchCacheTable(sql: any) {
  await sql`
    CREATE TABLE IF NOT EXISTS reconciliation_match_cache (
      account_name TEXT NOT NULL,
      bank_hash    TEXT NOT NULL,
      match_data   JSONB NOT NULL,
      updated_at   TIMESTAMP DEFAULT now(),
      PRIMARY KEY (account_name, bank_hash)
    )
  `;
}

export async function GET() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    return NextResponse.json({ matchesByAccount: {} as Record<string, unknown[]> });
  }

  try {
    const sql = neon(connectionString);
    await ensureMatchCacheTable(sql);
    const rows = (await sql`
      SELECT account_name, bank_hash, match_data
      FROM reconciliation_match_cache
      ORDER BY updated_at ASC
    `) as MatchCacheRow[];

    const matchesByAccount: Record<string, unknown[]> = {};
    for (const row of rows) {
      const account = String(row.account_name ?? "").trim();
      if (!account) continue;
      if (!matchesByAccount[account]) matchesByAccount[account] = [];
      const matchData = row.match_data as Record<string, any>;
      if (matchData?.bankTransaction && typeof matchData.bankTransaction === "object") {
        matchData.bankTransaction.accountName = account;
      }
      matchesByAccount[account].push(matchData);
    }

    return NextResponse.json({ matchesByAccount });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to fetch match cache" },
      { status: 502 },
    );
  }
}

export async function POST(request: NextRequest) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    return NextResponse.json({ error: "DATABASE_URL not configured" }, { status: 503 });
  }

  let body: { accountName?: unknown; matches?: unknown; replace?: unknown };
  try {
    body = (await request.json()) as { accountName?: unknown; matches?: unknown; replace?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const accountName = typeof body.accountName === "string" ? body.accountName.trim() : "";
  if (!accountName) {
    return NextResponse.json({ error: "accountName is required" }, { status: 400 });
  }
  if (!Array.isArray(body.matches)) {
    return NextResponse.json({ error: "matches must be an array" }, { status: 400 });
  }

  const replaceMode = body.replace === true;

  type MatchLike = { bankTransaction?: { hash?: string } };
  const validMatches: Array<{ hash: string; data: string }> = [];
  for (const match of body.matches) {
    const m = match as MatchLike;
    const hash = typeof m?.bankTransaction?.hash === "string" ? m.bankTransaction.hash.trim() : "";
    if (!hash) continue;
    validMatches.push({ hash, data: JSON.stringify(match) });
  }

  if (validMatches.length === 0 && !replaceMode) {
    return NextResponse.json({ success: true, count: 0 });
  }

  try {
    const sql = neon(connectionString);
    await ensureMatchCacheTable(sql);

    if (replaceMode) {
      await sql`DELETE FROM reconciliation_match_cache WHERE account_name = ${accountName}`;
    }

    // One INSERT per row inside a single transaction. Bulk unnest(..., jsonb[])
    // is unreliable with Neon's HTTP driver / large JSON payloads; per-row params avoid that.
    if (validMatches.length > 0) {
      await sql.transaction(
        validMatches.map((m) =>
          sql`
            INSERT INTO reconciliation_match_cache (account_name, bank_hash, match_data)
            VALUES (${accountName}, ${m.hash}, ${m.data}::jsonb)
            ON CONFLICT (account_name, bank_hash)
            DO UPDATE SET match_data = EXCLUDED.match_data, updated_at = now()
          `,
        ),
      );
    }

    return NextResponse.json({ success: true, count: validMatches.length });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to save match cache" },
      { status: 502 },
    );
  }
}
