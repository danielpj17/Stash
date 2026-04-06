import type { SheetRow, TransferRow } from "@/services/sheetsApi";
import type { SupportedBroker } from "@/services/snaptradeApi";

/** Sheet / form labels -> account keys. Non-account inflow sources are intentionally omitted. */
export const TRANSFER_LABEL_TO_BALANCE_KEY: Record<string, string> = {
  "WF Checking": "Wells Fargo Checking",
  "WF Savings": "Wells Fargo Savings",
  "Venmo - Daniel": "Venmo - Daniel",
  "Venmo - Katie": "Venmo - Katie",
  /** Legacy sheet rows before split */
  Venmo: "Venmo - Daniel",
  Fidelity: "Fidelity",
  Robinhood: "Robinhood",
  My529: "My529",
  "Charles Schwab": "Charles Schwab",
  Ally: "Ally",
  "Capital One": "Capital One",
  "America First": "America First",
};

/**
 * Opening balances calibrated to your existing budget-page balance model.
 * These are combined with transfer deltas and all-time WF checking cashflow.
 */
export const BASE_ACCOUNT_BALANCES: Record<string, number> = {
  "Wells Fargo Checking": 427.1,
  "Wells Fargo Savings": 1061.13,
  "Venmo - Daniel": 28.24,
  "Venmo - Katie": 28.23,
  Fidelity: 10597.43,
  Robinhood: 711.39,
  My529: 0,
  "Charles Schwab": 0,
  Ally: 0,
  "Capital One": 0,
  "America First": 0,
};

const LIVE_BROKER_ACCOUNT_KEYS: SupportedBroker[] = [
  "Fidelity",
  "Robinhood",
  "Charles Schwab",
];

export type AccountAnchor = {
  accountName: string;
  confirmedBalance: number;
  asOfDate: string;
};

function toDateKey(value?: string): string {
  if (!value) return "";
  const raw = String(value).trim();
  if (!raw) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return "";
  const y = parsed.getUTCFullYear();
  const m = String(parsed.getUTCMonth() + 1).padStart(2, "0");
  const d = String(parsed.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function mapAccountNameToBalanceKey(raw: string): string {
  const name = raw.trim();
  if (!name) return name;
  const lower = name.toLowerCase();

  if (lower === "wf checking" || lower === "wells fargo" || lower === "wells fargo checking") {
    return "Wells Fargo Checking";
  }
  if (lower === "wf savings" || lower === "wells fargo savings") {
    return "Wells Fargo Savings";
  }
  if (lower === "venmo - daniel") return "Venmo - Daniel";
  if (lower === "venmo - katie") return "Venmo - Katie";
  if (lower === "venmo") return "Venmo - Daniel";
  return name;
}

function shouldApplyByAnchor(
  accountKey: string,
  transactionDate: string,
  anchorByAccount: Map<string, AccountAnchor>,
): boolean {
  const anchor = anchorByAccount.get(accountKey);
  if (!anchor) return true;
  const txDate = toDateKey(transactionDate);
  const anchorDate = toDateKey(anchor.asOfDate);
  if (!anchorDate) return true;
  if (!txDate) return false;
  // Only include transactions strictly after the anchor date.
  return txDate > anchorDate;
}

function buildAnchorMap(anchors: AccountAnchor[]): Map<string, AccountAnchor> {
  const map = new Map<string, AccountAnchor>();
  for (const anchor of anchors) {
    if (!Number.isFinite(anchor.confirmedBalance)) continue;
    const key = mapAccountNameToBalanceKey(anchor.accountName);
    map.set(key, {
      accountName: key,
      confirmedBalance: Number(anchor.confirmedBalance),
      asOfDate: toDateKey(anchor.asOfDate),
    });
  }
  return map;
}

function accountKeyForSheetRow(row: SheetRow): string {
  const fromSheet = mapAccountNameToBalanceKey(String(row.account ?? "").trim());
  if (fromSheet) return fromSheet;
  return "Wells Fargo Checking";
}

export async function getAccountAnchors(): Promise<AccountAnchor[]> {
  const res = await fetch("/api/reconciliation/anchors", { cache: "no-store" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `Failed to fetch account anchors: ${res.status}`);
  }
  const data = (await res.json()) as { anchors?: Array<Partial<AccountAnchor>> };
  const anchors = Array.isArray(data.anchors) ? data.anchors : [];
  return anchors
    .map((row) => ({
      accountName: String(row.accountName ?? ""),
      confirmedBalance: Number(row.confirmedBalance ?? 0),
      asOfDate: String(row.asOfDate ?? ""),
    }))
    .filter((row) => row.accountName.trim() !== "" && Number.isFinite(row.confirmedBalance));
}

export function computeAccountBalances(
  allRows: SheetRow[],
  allTransfers: TransferRow[],
  liveBrokerBalances: Partial<Record<SupportedBroker, number>>,
  accountAnchors: AccountAnchor[] = [],
): Record<string, number> {
  const anchorByAccount = buildAnchorMap(accountAnchors);
  const balances: Record<string, number> = { ...BASE_ACCOUNT_BALANCES };
  for (const [accountKey, anchor] of anchorByAccount.entries()) {
    balances[accountKey] = anchor.confirmedBalance;
  }

  for (const t of allTransfers) {
    const amt = Number(t.amount);
    if (!Number.isFinite(amt) || amt === 0) continue;
    const txDate = toDateKey(t.timestamp);
    const fromLabel = t.transferFrom.trim();
    const toLabel = t.transferTo.trim();
    const fromKey = mapAccountNameToBalanceKey(TRANSFER_LABEL_TO_BALANCE_KEY[fromLabel] ?? "");
    const toKey = mapAccountNameToBalanceKey(TRANSFER_LABEL_TO_BALANCE_KEY[toLabel] ?? "");

    if (
      fromKey &&
      balances[fromKey] !== undefined &&
      shouldApplyByAnchor(fromKey, txDate, anchorByAccount)
    ) {
      balances[fromKey] -= amt;
    }
    if (
      toLabel !== "Misc." &&
      toKey &&
      balances[toKey] !== undefined &&
      shouldApplyByAnchor(toKey, txDate, anchorByAccount)
    ) {
      balances[toKey] += amt;
    }
  }

  for (const row of allRows) {
    const amount = Number(row.amount || 0);
    if (!Number.isFinite(amount) || amount === 0) continue;
    const accountKey = accountKeyForSheetRow(row);
    if (balances[accountKey] === undefined) continue;
    if (!shouldApplyByAnchor(accountKey, toDateKey(row.timestamp), anchorByAccount)) continue;

    if (row.expenseType === "Income") {
      balances[accountKey] += amount;
    } else {
      balances[accountKey] -= amount;
    }
  }

  const merged = { ...balances };
  for (const key of LIVE_BROKER_ACCOUNT_KEYS) {
    const liveValue = liveBrokerBalances[key];
    if (typeof liveValue === "number" && Number.isFinite(liveValue)) {
      merged[key] = liveValue;
    }
  }
  return merged;
}
