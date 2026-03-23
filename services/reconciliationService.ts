import { createHash } from "node:crypto";

export type BankProfile = {
  dateIndex: number | null;
  amountIndex: number | null;
  descriptionIndex: number | null;
};

export const BANK_PROFILES: Record<string, BankProfile> = {
  "Wells Fargo": {
    dateIndex: 0,
    amountIndex: 1,
    descriptionIndex: 4,
  },
  Venmo: {
    dateIndex: 1,
    amountIndex: 7,
    descriptionIndex: 4,
  },
  "Capital One": {
    dateIndex: null,
    amountIndex: null,
    descriptionIndex: null,
  },
  "America First": {
    dateIndex: null,
    amountIndex: null,
    descriptionIndex: null,
  },
  Discover: {
    dateIndex: null,
    amountIndex: null,
    descriptionIndex: null,
  },
};

export type BankTransaction = {
  accountName: string;
  date: string;
  amount: number;
  description: string;
  hash: string;
  raw?: string[];
};

export type SheetExpenseLike = {
  amount: number;
  timestamp?: string;
  date?: string;
  description?: string;
  expenseType?: string;
  account?: string;
};

export type MatchType =
  | "exact_match"
  | "questionable_match_fuzzy"
  | "transfer"
  | "unmatched";

export type MatchResult = {
  bankTransaction: BankTransaction;
  matchType: MatchType;
  reason: string;
  matchedSheetExpense?: SheetExpenseLike;
  matchedSheetIndex?: number;
  transferCounterparty?: BankTransaction;
  matchedByNeonHash?: boolean;
};

/**
 * Creates a stable transaction hash for deduplication across imports/sync runs.
 * Description and amount are normalized before hashing to reduce formatting noise.
 */
export function generateTransactionHash(
  date: string,
  amount: number,
  description: string,
): string {
  const normalizedDescription = description.trim().toLowerCase();
  const normalizedAmount = Number(amount).toFixed(2);
  const normalizedDate = String(date).trim();
  const payload = `${normalizedDate}|${normalizedAmount}|${normalizedDescription}`;

  return createHash("sha256").update(payload).digest("hex");
}

function cents(amount: number): number {
  return Math.round(Number(amount) * 100);
}

function amountKey(amount: number): number {
  return Math.abs(cents(amount));
}

function normalizeDateOnly(value: string): string {
  const raw = String(value).trim();
  if (!raw) return "";

  // Keep YYYY-MM-DD stable when provided directly.
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return raw;
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return "";
  const year = parsed.getUTCFullYear();
  const month = String(parsed.getUTCMonth() + 1).padStart(2, "0");
  const day = String(parsed.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dateDistanceInDays(a: string, b: string): number | null {
  const aKey = normalizeDateOnly(a);
  const bKey = normalizeDateOnly(b);
  if (!aKey || !bKey) return null;

  const aTime = Date.parse(`${aKey}T00:00:00Z`);
  const bTime = Date.parse(`${bKey}T00:00:00Z`);
  if (Number.isNaN(aTime) || Number.isNaN(bTime)) return null;

  return Math.abs(Math.round((aTime - bTime) / 86_400_000));
}

function toIndexedMap(rows: SheetExpenseLike[]): Map<string, SheetExpenseLike[]> {
  const indexed = new Map<string, SheetExpenseLike[]>();
  for (const row of rows) {
    const key = `${amountKey(row.amount)}|${normalizeDateOnly(
      row.date ?? row.timestamp ?? "",
    )}`;
    if (!indexed.has(key)) indexed.set(key, []);
    indexed.get(key)?.push(row);
  }
  return indexed;
}

function isProfileConfigured(profile: BankProfile): boolean {
  return (
    profile.dateIndex !== null &&
    profile.amountIndex !== null &&
    profile.descriptionIndex !== null
  );
}

export function mapBankRowToTransaction(
  accountName: keyof typeof BANK_PROFILES | string,
  row: string[],
): BankTransaction | null {
  const profile = BANK_PROFILES[accountName];
  if (!profile || !isProfileConfigured(profile)) return null;

  const dateIndex = profile.dateIndex as number;
  const amountIndex = profile.amountIndex as number;
  const descriptionIndex = profile.descriptionIndex as number;
  const date = String(row[dateIndex] ?? "").trim();
  const rawAmount = String(row[amountIndex] ?? "").replace(/[$,]/g, "").trim();
  const description = String(row[descriptionIndex] ?? "").trim();
  const amount = Number(rawAmount);
  if (!date || !description || !Number.isFinite(amount)) return null;

  return {
    accountName: String(accountName),
    date,
    amount,
    description,
    hash: generateTransactionHash(date, amount, description),
    raw: row,
  };
}

export function mapBankRowsToTransactions(
  accountName: keyof typeof BANK_PROFILES | string,
  rows: string[][],
): BankTransaction[] {
  return rows
    .map((row) => mapBankRowToTransaction(accountName, row))
    .filter((tx): tx is BankTransaction => tx !== null);
}

async function getProcessedTransactionHashes(): Promise<Set<string>> {
  if (typeof window !== "undefined") return new Set<string>();
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return new Set<string>();

  try {
    const { neon } = await import("@neondatabase/serverless");
    const sql = neon(connectionString);
    const rows = (await sql`
      SELECT hash
      FROM processed_transactions
    `) as { hash: string }[];
    return new Set(rows.map((r) => r.hash));
  } catch {
    // Gracefully skip Neon hash matching when table/env is not ready.
    return new Set<string>();
  }
}

/**
 * Match bank transactions against processed hashes, existing sheet rows, and transfer pairs.
 *
 * Priority:
 * 1) Exact Match: hash exists in Neon OR amount+date equals a sheet row.
 * 2) Questionable Match (Fuzzy): amount matches and date is within +/- 5 days.
 * 3) Transfer: negative amount matched to same-day positive amount in another account.
 * 4) Unmatched.
 */
export async function findMatches(
  bankTransactions: BankTransaction[],
  sheetExpenses: SheetExpenseLike[],
  options?: { processedHashes?: Iterable<string> },
): Promise<MatchResult[]> {
  const processedHashes = options?.processedHashes
    ? new Set(options.processedHashes)
    : await getProcessedTransactionHashes();
  const exactSheetIndex = toIndexedMap(sheetExpenses);

  return bankTransactions.map((tx) => {
    const txDate = normalizeDateOnly(tx.date);
    const exactKey = `${amountKey(tx.amount)}|${txDate}`;
    const exactSheet = exactSheetIndex.get(exactKey)?.[0];
    const exactSheetIndexValue = exactSheet
      ? sheetExpenses.findIndex((row) => row === exactSheet)
      : -1;
    const exactByHash = processedHashes.has(tx.hash);

    if (exactByHash || exactSheet) {
      return {
        bankTransaction: tx,
        matchType: "exact_match",
        reason: exactByHash
          ? "Exact Match: transaction hash already exists in Neon."
          : "Exact Match: identical amount and date already exists in sheet.",
        matchedByNeonHash: exactByHash,
        matchedSheetExpense: exactSheet,
        matchedSheetIndex: exactSheetIndexValue >= 0 ? exactSheetIndexValue : undefined,
      };
    }

    const fuzzySheetIndex = sheetExpenses.findIndex((sheetRow) => {
      if (amountKey(sheetRow.amount) !== amountKey(tx.amount)) return false;
      const sheetDate = sheetRow.date ?? sheetRow.timestamp ?? "";
      const dayDistance = dateDistanceInDays(sheetDate, tx.date);
      return dayDistance !== null && dayDistance <= 5;
    });
    const fuzzySheet = fuzzySheetIndex >= 0 ? sheetExpenses[fuzzySheetIndex] : undefined;

    if (fuzzySheet) {
      return {
        bankTransaction: tx,
        matchType: "questionable_match_fuzzy",
        reason:
          "Questionable Match (Fuzzy): amount matches and sheet date is within +/- 5 days.",
        matchedSheetExpense: fuzzySheet,
        matchedSheetIndex: fuzzySheetIndex,
      };
    }

    if (tx.amount < 0) {
      const transferCounterparty = bankTransactions.find((candidate) => {
        if (candidate.accountName === tx.accountName) return false;
        if (normalizeDateOnly(candidate.date) !== txDate) return false;
        return cents(candidate.amount) === Math.abs(cents(tx.amount));
      });

      if (transferCounterparty) {
        return {
          bankTransaction: tx,
          matchType: "transfer",
          reason:
            "Transfer detected: negative amount matches positive amount in a different account on the same day.",
          transferCounterparty,
        };
      }
    }

    return {
      bankTransaction: tx,
      matchType: "unmatched",
      reason: "No exact, fuzzy, or transfer match found.",
    };
  });
}
