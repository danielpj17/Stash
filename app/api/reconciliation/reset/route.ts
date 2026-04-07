import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import { RECONCILIATION_RESET_CONFIRM } from "@/lib/reconciliationReset";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function ensureClaimsTable(sql: any) {
  await sql`
    CREATE TABLE IF NOT EXISTS reconciliation_claim_links (
      bank_hash TEXT NOT NULL,
      account_name TEXT,
      sheet_name TEXT NOT NULL DEFAULT 'Expenses',
      sheet_row_id TEXT NOT NULL,
      amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
      created_at TIMESTAMP DEFAULT now(),
      PRIMARY KEY (bank_hash, sheet_name, sheet_row_id),
      UNIQUE (sheet_name, sheet_row_id)
    )
  `;
}

async function ensureTransferClaimsTable(sql: any) {
  await sql`
    CREATE TABLE IF NOT EXISTS reconciliation_transfer_claim_links (
      transfer_sheet_row_id TEXT NOT NULL,
      bank_hash TEXT NOT NULL,
      bank_account_name TEXT,
      bank_amount_cents INTEGER NOT NULL,
      expected_legs INTEGER NOT NULL DEFAULT 2 CHECK (expected_legs IN (1, 2)),
      created_at TIMESTAMP DEFAULT now(),
      PRIMARY KEY (transfer_sheet_row_id, bank_hash),
      UNIQUE (bank_hash)
    )
  `;
}

async function ensureDismissalsTable(sql: any) {
  await sql`
    CREATE TABLE IF NOT EXISTS reconciliation_statement_dismissals (
      hash TEXT NOT NULL,
      account_name TEXT NOT NULL,
      note TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT now(),
      PRIMARY KEY (hash, account_name)
    )
  `;
}

async function ensureUploadedFilesTable(sql: any) {
  await sql`
    CREATE TABLE IF NOT EXISTS reconciliation_uploaded_files (
      account_name TEXT NOT NULL,
      file_name TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT now(),
      PRIMARY KEY (account_name, file_name)
    )
  `;
}

async function ensureProcessedTable(sql: any) {
  await sql`
    CREATE TABLE IF NOT EXISTS processed_transactions (
      hash TEXT PRIMARY KEY,
      account_name TEXT,
      processed_at TIMESTAMP DEFAULT now()
    )
  `;
}

async function ensureUserSheetDismissalsTable(sql: any) {
  await sql`
    CREATE TABLE IF NOT EXISTS reconciliation_user_sheet_dismissals (
      sheet_name TEXT NOT NULL,
      sheet_row_id TEXT NOT NULL,
      note TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT now(),
      PRIMARY KEY (sheet_name, sheet_row_id)
    )
  `;
}

async function ensureCsvRowsTable(sql: any) {
  await sql`
    CREATE TABLE IF NOT EXISTS reconciliation_csv_rows (
      account_name TEXT NOT NULL,
      dedupe_key   TEXT NOT NULL,
      cells        JSONB NOT NULL,
      created_at   TIMESTAMP DEFAULT now(),
      PRIMARY KEY (account_name, dedupe_key)
    )
  `;
}

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

export async function POST(request: NextRequest) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    return NextResponse.json({ error: "DATABASE_URL not configured" }, { status: 503 });
  }

  let body: { confirm?: unknown };
  try {
    body = (await request.json()) as { confirm?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (body.confirm !== RECONCILIATION_RESET_CONFIRM) {
    return NextResponse.json(
      { error: `Send confirm: "${RECONCILIATION_RESET_CONFIRM}" to proceed.` },
      { status: 400 },
    );
  }

  try {
    const sql = neon(connectionString);
    await ensureClaimsTable(sql);
    await ensureTransferClaimsTable(sql);
    await ensureDismissalsTable(sql);
    await ensureUploadedFilesTable(sql);
    await ensureProcessedTable(sql);
    await ensureUserSheetDismissalsTable(sql);
    await ensureCsvRowsTable(sql);
    await ensureMatchCacheTable(sql);

    await sql`DELETE FROM reconciliation_claim_links`;
    await sql`DELETE FROM reconciliation_transfer_claim_links`;
    await sql`DELETE FROM reconciliation_statement_dismissals`;
    await sql`DELETE FROM reconciliation_uploaded_files`;
    await sql`DELETE FROM processed_transactions`;
    await sql`DELETE FROM reconciliation_user_sheet_dismissals`;
    await sql`DELETE FROM reconciliation_csv_rows`;
    await sql`DELETE FROM reconciliation_match_cache`;

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("Reconciliation reset error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to reset reconciliation data" },
      { status: 502 },
    );
  }
}
