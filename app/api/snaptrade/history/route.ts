import { NextResponse } from "next/server";
import { Snaptrade } from "snaptrade-typescript-sdk";
import { neon } from "@neondatabase/serverless";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type HistoryPoint = {
  date: string;
  value: number;
};

type SnaptradeHistoryResponse = {
  points: HistoryPoint[];
  source: "experimental" | "snapshots" | "none";
};

function asFiniteNumber(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function getMissingEnvVars(env: Record<string, string | undefined>): string[] {
  return Object.entries(env)
    .filter(([, value]) => !value || value.trim().length === 0)
    .map(([key]) => key);
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

async function loadSnapshotHistory(sql: any): Promise<HistoryPoint[]> {
  const rows = await sql`
    SELECT fetched_at, fidelity_total
    FROM snaptrade_balance_snapshots
    ORDER BY fetched_at ASC
    LIMIT 365
  `;
  return rows
    .map((row: any) => ({
      date: String(row.fetched_at),
      value: asFiniteNumber(row.fidelity_total),
    }))
    .filter((point: HistoryPoint) => point.value > 0);
}

async function loadExperimentalFidelityHistory(): Promise<HistoryPoint[]> {
  const clientId = process.env.SNAPTRADE_CLIENT_ID;
  const consumerKey = process.env.SNAPTRADE_CONSUMER_KEY;
  const userId = process.env.SNAPTRADE_USER_ID;
  const userSecret = process.env.SNAPTRADE_USER_SECRET;
  const missing = getMissingEnvVars({
    SNAPTRADE_CLIENT_ID: clientId,
    SNAPTRADE_CONSUMER_KEY: consumerKey,
    SNAPTRADE_USER_ID: userId,
    SNAPTRADE_USER_SECRET: userSecret,
  });
  if (missing.length > 0) return [];

  const snaptrade = new Snaptrade({
    clientId: clientId as string,
    consumerKey: consumerKey as string,
  });

  const accountListResponse = await snaptrade.accountInformation.listUserAccounts({
    userId: userId as string,
    userSecret: userSecret as string,
  });

  const fidelityAccounts = accountListResponse.data.filter((account) => {
    if (account.status === "closed" || account.status === "archived") return false;
    return String(account.institution_name ?? "").toLowerCase().includes("fidelity");
  });
  if (fidelityAccounts.length === 0) return [];

  const byDate: Record<string, number> = {};
  for (const account of fidelityAccounts) {
    try {
      const response = await snaptrade.experimentalEndpoints.getAccountBalanceHistory({
        userId: userId as string,
        userSecret: userSecret as string,
        accountId: account.id,
      });
      const history = response.data.history ?? [];
      for (const row of history) {
        if (!row.date) continue;
        const value = asFiniteNumber(row.total_value);
        if (value <= 0) continue;
        byDate[row.date] = (byDate[row.date] ?? 0) + value;
      }
    } catch (err) {
      console.error(`SnapTrade fidelity history error for account ${account.id}:`, err);
    }
  }

  return Object.entries(byDate)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, value]) => ({ date, value }));
}

export async function GET() {
  const connectionString = process.env.DATABASE_URL;
  try {
    const experimentalPoints = await loadExperimentalFidelityHistory();
    if (experimentalPoints.length > 0) {
      return NextResponse.json({
        points: experimentalPoints,
        source: "experimental",
      } satisfies SnaptradeHistoryResponse);
    }
  } catch (err) {
    console.error("SnapTrade experimental history error:", err);
  }

  if (!connectionString) {
    return NextResponse.json({
      points: [],
      source: "none",
    } satisfies SnaptradeHistoryResponse);
  }

  try {
    const sql = neon(connectionString);
    await ensureSnapshotsTable(sql);
    const snapshotPoints = await loadSnapshotHistory(sql);
    return NextResponse.json({
      points: snapshotPoints,
      source: snapshotPoints.length > 0 ? "snapshots" : "none",
    } satisfies SnaptradeHistoryResponse);
  } catch (err) {
    console.error("SnapTrade history GET error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load history" },
      { status: 502 }
    );
  }
}
