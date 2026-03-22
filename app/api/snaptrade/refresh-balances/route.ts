import { NextResponse } from "next/server";
import { Snaptrade } from "snaptrade-typescript-sdk";
import { neon } from "@neondatabase/serverless";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SupportedBroker = "Fidelity" | "Robinhood" | "Charles Schwab";

type RefreshBalancesResponse = {
  balances: Partial<Record<SupportedBroker, number>>;
  fetchedAt: string;
  accountCount: number;
  matchedAccounts: number;
  detailFailures: number;
  investments: {
    brokerage: number;
    rothIra: number;
    fidelityTotal: number;
  };
};

function mapInstitutionToBroker(institutionName: string): SupportedBroker | null {
  const value = institutionName.trim().toLowerCase();
  if (!value) return null;
  if (value.includes("fidelity")) return "Fidelity";
  if (value.includes("robinhood")) return "Robinhood";
  if (value.includes("charles schwab") || value.includes("schwab")) return "Charles Schwab";
  return null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function asFiniteNumber(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function classifyFidelityAccountBucket(accountName: string, rawType: string): "rothIra" | "brokerage" {
  const value = `${accountName} ${rawType}`.trim().toLowerCase();
  if (value.includes("roth") && value.includes("ira")) return "rothIra";
  return "brokerage";
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

async function loadLatestSnapshot(sql: any): Promise<RefreshBalancesResponse | null> {
  const rows = await sql`
    SELECT
      fetched_at,
      balances,
      account_count,
      matched_accounts,
      detail_failures,
      fidelity_total,
      fidelity_brokerage,
      fidelity_roth_ira
    FROM snaptrade_balance_snapshots
    ORDER BY fetched_at DESC
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  const balances = (row.balances ?? {}) as Partial<Record<SupportedBroker, number>>;
  const balanceFidelity = asFiniteNumber((balances as Record<string, unknown>).Fidelity);
  const storedFidelityTotal = asFiniteNumber(row.fidelity_total);
  const fidelityTotal = storedFidelityTotal > 0 ? storedFidelityTotal : balanceFidelity;
  const storedBrokerage = asFiniteNumber(row.fidelity_brokerage);
  const storedRoth = asFiniteNumber(row.fidelity_roth_ira);
  const brokerage = storedBrokerage + storedRoth > 0 ? storedBrokerage : fidelityTotal;
  const rothIra = storedBrokerage + storedRoth > 0 ? storedRoth : 0;
  return {
    balances,
    fetchedAt: String(row.fetched_at),
    accountCount: asFiniteNumber(row.account_count),
    matchedAccounts: asFiniteNumber(row.matched_accounts),
    detailFailures: asFiniteNumber(row.detail_failures),
    investments: {
      brokerage,
      rothIra,
      fidelityTotal,
    },
  };
}

async function saveSnapshot(
  sql: any,
  payload: RefreshBalancesResponse
): Promise<void> {
  await sql`
    INSERT INTO snaptrade_balance_snapshots (
      fetched_at,
      balances,
      account_count,
      matched_accounts,
      detail_failures,
      fidelity_total,
      fidelity_brokerage,
      fidelity_roth_ira
    )
    VALUES (
      ${payload.fetchedAt}::timestamptz,
      ${payload.balances},
      ${payload.accountCount},
      ${payload.matchedAccounts},
      ${payload.detailFailures},
      ${payload.investments.fidelityTotal},
      ${payload.investments.brokerage},
      ${payload.investments.rothIra}
    )
  `;
}

export async function GET() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    return NextResponse.json({
      balances: {},
      fetchedAt: new Date(0).toISOString(),
      accountCount: 0,
      matchedAccounts: 0,
      detailFailures: 0,
      investments: {
        brokerage: 0,
        rothIra: 0,
        fidelityTotal: 0,
      },
    } satisfies RefreshBalancesResponse);
  }

  try {
    const sql = neon(connectionString);
    await ensureSnapshotsTable(sql);
    const latest = await loadLatestSnapshot(sql);
    if (latest) return NextResponse.json(latest);
    return NextResponse.json({
      balances: {},
      fetchedAt: new Date(0).toISOString(),
      accountCount: 0,
      matchedAccounts: 0,
      detailFailures: 0,
      investments: {
        brokerage: 0,
        rothIra: 0,
        fidelityTotal: 0,
      },
    } satisfies RefreshBalancesResponse);
  } catch (err) {
    console.error("SnapTrade latest snapshot GET error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load last balances" },
      { status: 502 }
    );
  }
}

export async function POST() {
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

  if (missing.length > 0) {
    return NextResponse.json(
      { error: `Missing SnapTrade environment variable(s): ${missing.join(", ")}` },
      { status: 503 }
    );
  }

  try {
    const safeClientId = clientId as string;
    const safeConsumerKey = consumerKey as string;
    const safeUserId = userId as string;
    const safeUserSecret = userSecret as string;

    const snaptrade = new Snaptrade({
      clientId: safeClientId,
      consumerKey: safeConsumerKey,
    });

    const accountListResponse = await snaptrade.accountInformation.listUserAccounts({
      userId: safeUserId,
      userSecret: safeUserSecret,
    });

    const openAccounts = accountListResponse.data.filter(
      (account) => account.status !== "closed" && account.status !== "archived"
    );

    const accountDetails = await Promise.all(
      openAccounts.map(async (account) => {
        try {
          const details = await snaptrade.accountInformation.getUserAccountDetails({
            userId: safeUserId,
            userSecret: safeUserSecret,
            accountId: account.id,
          });
          return { account: details.data, isDetailSuccess: true };
        } catch (err) {
          console.error(`SnapTrade account detail error for ${account.id}:`, err);
          return { account: null, isDetailSuccess: false };
        }
      })
    );

    const balances: Partial<Record<SupportedBroker, number>> = {};
    let matchedAccounts = 0;
    let detailFailures = 0;
    let fidelityBrokerage = 0;
    let fidelityRothIra = 0;

    for (const detail of accountDetails) {
      if (!detail.isDetailSuccess || !detail.account) {
        detailFailures += 1;
        continue;
      }
      const account = detail.account;
      const key = mapInstitutionToBroker(account.institution_name ?? "");
      if (!key) continue;
      const amount = account.balance?.total?.amount;
      if (!isFiniteNumber(amount)) continue;
      balances[key] = (balances[key] ?? 0) + amount;
      matchedAccounts += 1;

      if (key === "Fidelity") {
        const bucket = classifyFidelityAccountBucket(account.name ?? "", account.raw_type ?? "");
        if (bucket === "rothIra") fidelityRothIra += amount;
        else fidelityBrokerage += amount;
      }
    }

    const payload: RefreshBalancesResponse = {
      balances,
      fetchedAt: new Date().toISOString(),
      accountCount: openAccounts.length,
      matchedAccounts,
      detailFailures,
      investments: {
        brokerage: fidelityBrokerage,
        rothIra: fidelityRothIra,
        fidelityTotal: fidelityBrokerage + fidelityRothIra,
      },
    };

    const connectionString = process.env.DATABASE_URL;
    if (connectionString) {
      try {
        const sql = neon(connectionString);
        await ensureSnapshotsTable(sql);
        if (payload.matchedAccounts > 0) {
          await saveSnapshot(sql, payload);
        } else {
          const latest = await loadLatestSnapshot(sql);
          if (latest) {
            return NextResponse.json(latest);
          }
        }
      } catch (err) {
        console.error("SnapTrade snapshot persistence error:", err);
      }
    }

    return NextResponse.json(payload);
  } catch (err) {
    const message =
      err instanceof Error && err.message
        ? err.message
        : "Failed to refresh balances from SnapTrade.";
    console.error("SnapTrade refresh balances error:", err);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
