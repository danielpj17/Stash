import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type MemoryRow = {
  fingerprint: string;
  bank_account_name: string;
  sheet_category: string | null;
  sheet_account: string | null;
  confirmed_count: number;
  last_confirmed_at: string;
};

async function ensureMemoryTable(sql: any) {
  await sql`
    CREATE TABLE IF NOT EXISTS reconciliation_merchant_memory (
      fingerprint TEXT NOT NULL,
      bank_account_name TEXT NOT NULL,
      sheet_category TEXT,
      sheet_account TEXT,
      confirmed_count INTEGER NOT NULL DEFAULT 1,
      last_confirmed_at TIMESTAMP DEFAULT now(),
      PRIMARY KEY (fingerprint, bank_account_name)
    )
  `;
}

export async function GET() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    return NextResponse.json({ entries: [] });
  }

  try {
    const sql = neon(connectionString);
    await ensureMemoryTable(sql);
    const rows = (await sql`
      SELECT fingerprint, bank_account_name, sheet_category, sheet_account, confirmed_count, last_confirmed_at
      FROM reconciliation_merchant_memory
      ORDER BY confirmed_count DESC, last_confirmed_at DESC
    `) as MemoryRow[];

    return NextResponse.json({
      entries: rows.map((row) => ({
        fingerprint: row.fingerprint,
        bankAccountName: row.bank_account_name,
        sheetCategory: row.sheet_category,
        sheetAccount: row.sheet_account,
        confirmedCount: Number(row.confirmed_count ?? 0),
        lastConfirmedAt: row.last_confirmed_at,
      })),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to fetch merchant memory" },
      { status: 502 },
    );
  }
}

export async function POST(request: NextRequest) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    return NextResponse.json({ error: "DATABASE_URL not configured" }, { status: 503 });
  }

  let body: {
    fingerprint?: unknown;
    bankAccountName?: unknown;
    sheetCategory?: unknown;
    sheetAccount?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const fingerprint = typeof body.fingerprint === "string" ? body.fingerprint.trim() : "";
  const bankAccountName =
    typeof body.bankAccountName === "string" ? body.bankAccountName.trim() : "";
  const sheetCategory =
    typeof body.sheetCategory === "string" && body.sheetCategory.trim()
      ? body.sheetCategory.trim()
      : null;
  const sheetAccount =
    typeof body.sheetAccount === "string" && body.sheetAccount.trim()
      ? body.sheetAccount.trim()
      : null;

  if (!fingerprint) {
    return NextResponse.json({ error: "fingerprint is required" }, { status: 400 });
  }
  if (!bankAccountName) {
    return NextResponse.json({ error: "bankAccountName is required" }, { status: 400 });
  }

  try {
    const sql = neon(connectionString);
    await ensureMemoryTable(sql);

    const rows = (await sql`
      INSERT INTO reconciliation_merchant_memory (
        fingerprint, bank_account_name, sheet_category, sheet_account, confirmed_count
      )
      VALUES (${fingerprint}, ${bankAccountName}, ${sheetCategory}, ${sheetAccount}, 1)
      ON CONFLICT (fingerprint, bank_account_name) DO UPDATE SET
        confirmed_count = reconciliation_merchant_memory.confirmed_count + 1,
        last_confirmed_at = now(),
        sheet_category = COALESCE(EXCLUDED.sheet_category, reconciliation_merchant_memory.sheet_category),
        sheet_account = COALESCE(EXCLUDED.sheet_account, reconciliation_merchant_memory.sheet_account)
      RETURNING fingerprint, bank_account_name, confirmed_count
    `) as Array<{ fingerprint: string; bank_account_name: string; confirmed_count: number }>;

    const row = rows[0];
    return NextResponse.json({
      success: true,
      fingerprint,
      bankAccountName,
      confirmedCount: Number(row?.confirmed_count ?? 1),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to upsert merchant memory" },
      { status: 502 },
    );
  }
}

export async function DELETE(request: NextRequest) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    return NextResponse.json({ error: "DATABASE_URL not configured" }, { status: 503 });
  }

  let body: { fingerprint?: unknown; bankAccountName?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const fingerprint = typeof body.fingerprint === "string" ? body.fingerprint.trim() : "";
  const bankAccountName =
    typeof body.bankAccountName === "string" ? body.bankAccountName.trim() : "";

  if (!fingerprint || !bankAccountName) {
    return NextResponse.json(
      { error: "fingerprint and bankAccountName are required" },
      { status: 400 },
    );
  }

  try {
    const sql = neon(connectionString);
    await ensureMemoryTable(sql);
    const rows = (await sql`
      DELETE FROM reconciliation_merchant_memory
      WHERE fingerprint = ${fingerprint} AND bank_account_name = ${bankAccountName}
      RETURNING fingerprint
    `) as Array<{ fingerprint: string }>;

    return NextResponse.json({ success: true, deleted: rows.length });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to delete merchant memory" },
      { status: 502 },
    );
  }
}
