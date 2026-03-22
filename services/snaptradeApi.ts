const SNAPTRADE_REFRESH_API = "/api/snaptrade/refresh-balances";

export type SupportedBroker = "Fidelity" | "Robinhood" | "Charles Schwab";

export type RefreshSnaptradeBalancesResponse = {
  balances: Partial<Record<SupportedBroker, number>>;
  fetchedAt: string;
  accountCount: number;
  matchedAccounts: number;
};

export async function refreshSnaptradeBalances(): Promise<RefreshSnaptradeBalancesResponse> {
  const res = await fetch(SNAPTRADE_REFRESH_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `Failed to refresh SnapTrade balances: ${res.status}`);
  }

  const data = (await res.json()) as Partial<RefreshSnaptradeBalancesResponse>;
  return {
    balances: data.balances ?? {},
    fetchedAt: data.fetchedAt ?? new Date().toISOString(),
    accountCount: typeof data.accountCount === "number" ? data.accountCount : 0,
    matchedAccounts: typeof data.matchedAccounts === "number" ? data.matchedAccounts : 0,
  };
}
