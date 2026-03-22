import type { SheetRow, TransferRow } from "@/services/sheetsApi";
import type { SupportedBroker } from "@/services/snaptradeApi";

/** Sheet / form labels -> account keys. Non-account inflow sources are intentionally omitted. */
export const TRANSFER_LABEL_TO_BALANCE_KEY: Record<string, string> = {
  "WF Checking": "Wells Fargo Checking",
  "WF Savings": "Wells Fargo Savings",
  Venmo: "Venmo",
  Fidelity: "Fidelity",
  Robinhood: "Robinhood",
  My529: "My529",
  "Charles Schwab": "Charles Schwab",
  Ally: "Ally",
};

/**
 * Opening balances calibrated to your existing budget-page balance model.
 * These are combined with transfer deltas and all-time WF checking cashflow.
 */
export const BASE_ACCOUNT_BALANCES: Record<string, number> = {
  "Wells Fargo Checking": 427.1,
  "Wells Fargo Savings": 1061.13,
  Venmo: 56.47,
  Fidelity: 10597.43,
  Robinhood: 711.39,
  My529: 0,
  "Charles Schwab": 0,
  Ally: 0,
};

const LIVE_BROKER_ACCOUNT_KEYS: SupportedBroker[] = [
  "Fidelity",
  "Robinhood",
  "Charles Schwab",
];

export function computeAccountBalances(
  allRows: SheetRow[],
  allTransfers: TransferRow[],
  liveBrokerBalances: Partial<Record<SupportedBroker, number>>
): Record<string, number> {
  const balances: Record<string, number> = { ...BASE_ACCOUNT_BALANCES };

  for (const t of allTransfers) {
    const amt = Number(t.amount);
    if (!Number.isFinite(amt) || amt === 0) continue;
    const fromLabel = t.transferFrom.trim();
    const toLabel = t.transferTo.trim();
    const fromKey = TRANSFER_LABEL_TO_BALANCE_KEY[fromLabel];
    const toKey = TRANSFER_LABEL_TO_BALANCE_KEY[toLabel];

    if (fromKey !== undefined && balances[fromKey] !== undefined) {
      balances[fromKey] -= amt;
    }
    if (toLabel !== "Misc." && toKey !== undefined && balances[toKey] !== undefined) {
      balances[toKey] += amt;
    }
  }

  const allTimeIncomeTotal = allRows
    .filter((r) => r.expenseType === "Income")
    .reduce((sum, r) => sum + Number(r.amount || 0), 0);
  const allTimeExpenseTotal = allRows
    .filter((r) => r.expenseType !== "Income")
    .reduce((sum, r) => sum + Number(r.amount || 0), 0);
  const checkingDelta = allTimeIncomeTotal - allTimeExpenseTotal;
  balances["Wells Fargo Checking"] = (balances["Wells Fargo Checking"] ?? 0) + checkingDelta;

  const merged = { ...balances };
  for (const key of LIVE_BROKER_ACCOUNT_KEYS) {
    const liveValue = liveBrokerBalances[key];
    if (typeof liveValue === "number" && Number.isFinite(liveValue)) {
      merged[key] = liveValue;
    }
  }
  return merged;
}
