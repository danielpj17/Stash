/**
 * Service to fetch and submit data via the app's API route (which proxies to Google Apps Script).
 * This avoids CORS / "Failed to fetch" when calling the Web App from the browser.
 *
 * Sheet columns: Timestamp, Expense Type, Amount, Description, Month
 * Timestamp is set by the script on submit.
 */

const SHEETS_API = "/api/sheets";

export type SheetRow = {
  timestamp?: string;
  expenseType: string;
  amount: number;
  description: string;
  month: string;
};

/** Normalize row keys from sheet (may be "Expense Type") to camelCase */
function normalizeRow(raw: Record<string, unknown>): SheetRow {
  return {
    timestamp: (raw.Timestamp ?? raw.timestamp) as string | undefined,
    expenseType: (raw["Expense Type"] ?? raw.expenseType) as string,
    amount: Number(raw.Amount ?? raw.amount ?? 0),
    description: (raw.Description ?? raw.description) as string,
    month: (raw.Month ?? raw.month) as string,
  };
}

function monthNameFromNumber(month: number): string {
  return [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
  ][month - 1] ?? "";
}

function rowMatchesMonth(row: SheetRow, selectedMonth?: string): boolean {
  if (!selectedMonth || selectedMonth === "full") return true;
  const monthNum = Number(selectedMonth);
  if (!Number.isFinite(monthNum) || monthNum < 1 || monthNum > 12) return true;

  // Prefer explicit Month column if present.
  const rawMonth = String(row.month ?? "").trim().toLowerCase();
  if (rawMonth) {
    const monthName = monthNameFromNumber(monthNum);
    const normalizedNumeric = String(parseInt(rawMonth, 10));
    if (
      rawMonth === String(monthNum) ||
      rawMonth === monthName ||
      rawMonth === `${monthName} 2026` ||
      normalizedNumeric === String(monthNum)
    ) {
      return true;
    }
  }

  // Fallback: infer from timestamp if month column is missing/inconsistent.
  if (row.timestamp) {
    const d = new Date(row.timestamp);
    if (!Number.isNaN(d.getTime()) && d.getMonth() + 1 === monthNum) {
      return true;
    }
  }

  return false;
}

/**
 * Fetch all rows via the API route (proxies to Web App). Optional month filter.
 */
export async function getExpenses(month?: string): Promise<SheetRow[]> {
  const url = month
    ? `${SHEETS_API}?month=${encodeURIComponent(month)}`
    : SHEETS_API;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `Failed to fetch expenses: ${res.status}`);
  }
  const data = await res.json();
  const rows: Record<string, unknown>[] = Array.isArray(data)
    ? (data as Record<string, unknown>[])
    : ((data.rows ?? data.data ?? []) as Record<string, unknown>[]);
  const normalized: SheetRow[] = rows.map((r) => normalizeRow(r));
  return normalized.filter((row: SheetRow) => rowMatchesMonth(row, month));
}

/**
 * Submit a new expense/income via the API route. Timestamp is added by the script.
 * Month is not sent; the sheet formula derives it from the timestamp.
 */
export async function submitExpense(payload: {
  expenseType: string;
  amount: number;
  description: string;
}): Promise<void> {
  const res = await fetch(SHEETS_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `Failed to submit: ${res.status}`);
  }
}
