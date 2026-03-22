const SNAPTRADE_REFRESH_API = "/api/snaptrade/refresh-balances";
const SNAPTRADE_HISTORY_API = "/api/snaptrade/history";
const SNAPTRADE_INVESTMENTS_API = "/api/snaptrade/investments";

export type SupportedBroker = "Fidelity" | "Robinhood" | "Charles Schwab";

export type RefreshSnaptradeBalancesResponse = {
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

export type SnaptradeHistoryResponse = {
  points: Array<{ date: string; value: number }>;
  source: "experimental" | "snapshots" | "none";
};

export type SnaptradeInvestmentsResponse = {
  brokerage: number;
  rothIra: number;
  fidelityTotal: number;
  fetchedAt: string | null;
};

function asFiniteNumber(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function normalizeRefreshPayload(
  data: Partial<RefreshSnaptradeBalancesResponse>
): RefreshSnaptradeBalancesResponse {
  return {
    balances: data.balances ?? {},
    fetchedAt: data.fetchedAt ?? new Date().toISOString(),
    accountCount: typeof data.accountCount === "number" ? data.accountCount : 0,
    matchedAccounts: typeof data.matchedAccounts === "number" ? data.matchedAccounts : 0,
    detailFailures: typeof data.detailFailures === "number" ? data.detailFailures : 0,
    investments: {
      brokerage: asFiniteNumber(data.investments?.brokerage),
      rothIra: asFiniteNumber(data.investments?.rothIra),
      fidelityTotal: asFiniteNumber(data.investments?.fidelityTotal),
    },
  };
}

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
  return normalizeRefreshPayload(data);
}

export async function getLatestSnaptradeBalances(): Promise<RefreshSnaptradeBalancesResponse> {
  const res = await fetch(SNAPTRADE_REFRESH_API, {
    method: "GET",
    cache: "no-store",
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `Failed to load latest SnapTrade balances: ${res.status}`);
  }
  const data = (await res.json()) as Partial<RefreshSnaptradeBalancesResponse>;
  return normalizeRefreshPayload(data);
}

export async function getSnaptradeHistory(): Promise<SnaptradeHistoryResponse> {
  const res = await fetch(SNAPTRADE_HISTORY_API, {
    method: "GET",
    cache: "no-store",
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `Failed to load SnapTrade history: ${res.status}`);
  }
  const data = (await res.json()) as Partial<SnaptradeHistoryResponse>;
  return {
    points: Array.isArray(data.points)
      ? data.points
          .map((point) => ({
            date: String(point.date ?? ""),
            value: asFiniteNumber(point.value),
          }))
          .filter((point) => Boolean(point.date))
      : [],
    source:
      data.source === "experimental" || data.source === "snapshots" || data.source === "none"
        ? data.source
        : "none",
  };
}

export async function getSnaptradeInvestments(): Promise<SnaptradeInvestmentsResponse> {
  const res = await fetch(SNAPTRADE_INVESTMENTS_API, {
    method: "GET",
    cache: "no-store",
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `Failed to load investments: ${res.status}`);
  }
  const data = (await res.json()) as Partial<SnaptradeInvestmentsResponse>;
  return {
    brokerage: asFiniteNumber(data.brokerage),
    rothIra: asFiniteNumber(data.rothIra),
    fidelityTotal: asFiniteNumber(data.fidelityTotal),
    fetchedAt: typeof data.fetchedAt === "string" ? data.fetchedAt : null,
  };
}
