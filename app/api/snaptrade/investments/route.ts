import { NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type InvestmentsResponse = {
  brokerage: number;
  rothIra: number;
  fidelityTotal: number;
  fetchedAt: string | null;
};

function asFiniteNumber(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

async function ensureSnapshotsTable(sql: any): Promise<void> {
  await sql`
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
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_snaptrade_balance_snapshots_fetched_at
    ON snaptrade_balance_snapshots (fetched_at DESC)
  `;
}

export async function GET() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    return NextResponse.json({
      brokerage: 0,
      rothIra: 0,
      fidelityTotal: 0,
      fetchedAt: null,
    } satisfies InvestmentsResponse);
  }

  try {
    const sql = neon(connectionString);
    await ensureSnapshotsTable(sql);
    const rows = await sql`
      SELECT fetched_at, fidelity_total, fidelity_brokerage, fidelity_roth_ira
      FROM snaptrade_balance_snapshots
      ORDER BY fetched_at DESC
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) {
      return NextResponse.json({
        brokerage: 0,
        rothIra: 0,
        fidelityTotal: 0,
        fetchedAt: null,
      } satisfies InvestmentsResponse);
    }

    return NextResponse.json({
      brokerage: asFiniteNumber(row.fidelity_brokerage),
      rothIra: asFiniteNumber(row.fidelity_roth_ira),
      fidelityTotal: asFiniteNumber(row.fidelity_total),
      fetchedAt: String(row.fetched_at),
    } satisfies InvestmentsResponse);
  } catch (err) {
    console.error("SnapTrade investments GET error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load investments" },
      { status: 502 }
    );
  }
}
