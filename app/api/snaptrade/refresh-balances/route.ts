import { NextResponse } from "next/server";
import { Snaptrade } from "snaptrade-typescript-sdk";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SupportedBroker = "Fidelity" | "Robinhood" | "Charles Schwab";

type RefreshBalancesResponse = {
  balances: Partial<Record<SupportedBroker, number>>;
  fetchedAt: string;
  accountCount: number;
  matchedAccounts: number;
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

function getMissingEnvVars(env: Record<string, string | undefined>): string[] {
  return Object.entries(env)
    .filter(([, value]) => !value || value.trim().length === 0)
    .map(([key]) => key);
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
          return details.data;
        } catch (err) {
          // Keep the refresh resilient if one connected account fails.
          console.error(`SnapTrade account detail error for ${account.id}:`, err);
          return account;
        }
      })
    );

    const balances: Partial<Record<SupportedBroker, number>> = {};
    let matchedAccounts = 0;

    for (const account of accountDetails) {
      const key = mapInstitutionToBroker(account.institution_name ?? "");
      if (!key) continue;
      const amount = account.balance?.total?.amount;
      if (!isFiniteNumber(amount)) continue;
      balances[key] = (balances[key] ?? 0) + amount;
      matchedAccounts += 1;
    }

    const payload: RefreshBalancesResponse = {
      balances,
      fetchedAt: new Date().toISOString(),
      accountCount: openAccounts.length,
      matchedAccounts,
    };

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
