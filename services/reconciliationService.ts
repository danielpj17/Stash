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

export type SheetTransferLike = {
  amount: number;
  timestamp?: string;
  date?: string;
  transferFrom?: string;
  transferTo?: string;
  description?: string;
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
  matchedSheetTransfer?: SheetTransferLike;
  matchedSheetTransferIndex?: number;
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

function formatDateKeyFromDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Wells Fargo often includes "PURCHASE AUTHORIZED ON MM/DD ..." in the description.
 * Use that embedded purchase date (when present) to reduce false fuzzy matches caused by posting-date lag.
 */
function deriveBankTransactionDate(
  accountName: string,
  postedDateRaw: string,
  rawDescription: string,
): string {
  const normalizedAccount = accountName.trim().toLowerCase();
  const isWells = normalizedAccount === "wells fargo";
  if (!isWells) return postedDateRaw;

  const match = rawDescription.match(/purchase\s+authorized\s+on\s+(\d{1,2})\/(\d{1,2})/i);
  if (!match) return postedDateRaw;

  const month = Number(match[1]);
  const day = Number(match[2]);
  if (!Number.isFinite(month) || !Number.isFinite(day)) return postedDateRaw;

  const posted = new Date(postedDateRaw);
  if (Number.isNaN(posted.getTime())) return postedDateRaw;

  const derived = new Date(Date.UTC(posted.getUTCFullYear(), month - 1, day));
  // If derived is implausibly in the future vs posted date, assume prior year boundary.
  if (derived.getTime() - posted.getTime() > 7 * 86_400_000) {
    derived.setUTCFullYear(derived.getUTCFullYear() - 1);
  }
  return formatDateKeyFromDate(derived);
}

function cleanBankDescription(rawDescription: string): string {
  const cleaned = rawDescription
    .replace(/^\s*purchase\s+authorized\s+on\s+\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\s*/i, "")
    .replace(/\s+ref\s*#?[a-z0-9-]+/gi, "")
    .replace(/\s+card\s+\d{2,6}\b/gi, "")
    .replace(/\s+atm\s+id\s+\d+\b/gi, "")
    .replace(/\s+x{3,}\d{2,}\b/gi, "")
    .replace(/\s+[a-z]\d{8,}\b/gi, "")
    .replace(/\s+\d{10,}\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || rawDescription.trim();
}

const DESCRIPTION_STOP_WORDS = new Set([
  "purchase",
  "authorized",
  "on",
  "payment",
  "online",
  "transfer",
  "from",
  "to",
  "ref",
  "card",
  "atm",
  "deposit",
  "web",
  "pmts",
  "inc",
  "llc",
  "co",
  "ut",
  "provo",
  "hurricane",
  "st",
  "saint",
]);

function normalizeDescriptionForMatch(value: string): string {
  return cleanBankDescription(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function descriptionTokenSet(value: string): Set<string> {
  const normalized = normalizeDescriptionForMatch(value);
  if (!normalized) return new Set<string>();
  const tokens = normalized
    .split(" ")
    .map((t) => t.trim())
    .filter(
      (t) =>
        t.length >= 3 &&
        !DESCRIPTION_STOP_WORDS.has(t) &&
        !/^\d+$/.test(t),
    );
  return new Set(tokens);
}

function descriptionSimilarity(a: string, b: string): number {
  const aTokens = descriptionTokenSet(a);
  const bTokens = descriptionTokenSet(b);
  if (aTokens.size === 0 || bTokens.size === 0) return 0;

  let overlap = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) overlap += 1;
  }

  const denom = Math.max(aTokens.size, bTokens.size);
  return denom > 0 ? overlap / denom : 0;
}

const MIN_FUZZY_DESCRIPTION_SIMILARITY = 0.2;
const AUTO_MATCH_MAX_DAY_DISTANCE = 3;
const QUESTIONABLE_MAX_DAY_DISTANCE = 14;

function isLikelyTransferDescription(value: string): boolean {
  const normalized = normalizeDescriptionForMatch(value);
  return /(?:\btransfer\b|\bvenmo\b|\bzelle\b|\bpaypal\b|\bcash\s*app\b|\bpayment\b|\bdeposit\b|\bwithdrawal\b)/i
    .test(normalized);
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
  const postedDate = String(row[dateIndex] ?? "").trim();
  const rawAmount = String(row[amountIndex] ?? "").replace(/[$,]/g, "").trim();
  const rawDescription = String(row[descriptionIndex] ?? "").trim();
  const description = cleanBankDescription(rawDescription);
  const date = deriveBankTransactionDate(String(accountName), postedDate, rawDescription);
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
 * 2) Questionable Match (Fuzzy): amount matches with description similarity and date is within +/- 14 days.
 * 3) Transfer: negative amount matched to same-day positive amount in another account.
 * 4) Unmatched.
 */
export async function findMatches(
  bankTransactions: BankTransaction[],
  sheetExpenses: SheetExpenseLike[],
  options?: {
    processedHashes?: Iterable<string>;
    sheetTransfers?: SheetTransferLike[];
  },
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

    const sheetTransfers = options?.sheetTransfers ?? [];
    const transferCandidates = sheetTransfers
      .map((sheetTransfer, index) => {
        if (amountKey(sheetTransfer.amount) !== amountKey(tx.amount)) return null;
        const transferDate = sheetTransfer.date ?? sheetTransfer.timestamp ?? "";
        const dayDistance = dateDistanceInDays(transferDate, tx.date);
        if (dayDistance === null || dayDistance > 2) return null;

        const transferText = [
          sheetTransfer.transferFrom ?? "",
          sheetTransfer.transferTo ?? "",
          sheetTransfer.description ?? "",
        ]
          .join(" ")
          .trim();
        const similarity = descriptionSimilarity(tx.description, transferText);
        const likelyTransfer =
          isLikelyTransferDescription(tx.description) ||
          similarity >= 0.2;
        if (!likelyTransfer) return null;

        return { index, row: sheetTransfer, dayDistance, similarity };
      })
      .filter(
        (
          candidate,
        ): candidate is {
          index: number;
          row: SheetTransferLike;
          dayDistance: number;
          similarity: number;
        } => candidate !== null,
      )
      .sort((a, b) => {
        if (a.dayDistance !== b.dayDistance) return a.dayDistance - b.dayDistance;
        return b.similarity - a.similarity;
      });

    const bestSheetTransfer = transferCandidates[0];
    if (bestSheetTransfer) {
      const uniqueTransferCandidate = transferCandidates.length === 1;
      if (uniqueTransferCandidate) {
        return {
          bankTransaction: tx,
          matchType: "transfer",
          reason:
            "Transfer Match: amount/date aligns with a transfer already logged in sheet.",
          matchedSheetTransfer: bestSheetTransfer.row,
          matchedSheetTransferIndex: bestSheetTransfer.index,
        };
      }
    }

    const fuzzyCandidates = sheetExpenses
      .map((sheetRow, index) => {
        if (amountKey(sheetRow.amount) !== amountKey(tx.amount)) return null;
        const sheetDate = sheetRow.date ?? sheetRow.timestamp ?? "";
        const dayDistance = dateDistanceInDays(sheetDate, tx.date);
        if (dayDistance === null || dayDistance > QUESTIONABLE_MAX_DAY_DISTANCE) return null;
        const similarity = descriptionSimilarity(
          tx.description,
          sheetRow.description ?? "",
        );
        if (similarity < MIN_FUZZY_DESCRIPTION_SIMILARITY) return null;
        return { index, row: sheetRow, dayDistance, similarity };
      })
      .filter(
        (
          candidate,
        ): candidate is {
          index: number;
          row: SheetExpenseLike;
          dayDistance: number;
          similarity: number;
        } => candidate !== null,
      )
      .sort((a, b) => {
        if (a.dayDistance !== b.dayDistance) return a.dayDistance - b.dayDistance;
        return b.similarity - a.similarity;
      });

    const bestFuzzy = fuzzyCandidates[0];
    if (bestFuzzy) {
      const uniqueCandidate = fuzzyCandidates.length === 1;
      const shouldPromoteToAutoMatch =
        uniqueCandidate &&
        bestFuzzy.dayDistance <= AUTO_MATCH_MAX_DAY_DISTANCE &&
        bestFuzzy.similarity >= MIN_FUZZY_DESCRIPTION_SIMILARITY;

      if (shouldPromoteToAutoMatch) {
        return {
          bankTransaction: tx,
          matchType: "exact_match",
          reason:
            "Auto Match: unique close-date amount match with strong description similarity.",
          matchedSheetExpense: bestFuzzy.row,
          matchedSheetIndex: bestFuzzy.index,
        };
      }

      return {
        bankTransaction: tx,
        matchType: "questionable_match_fuzzy",
        reason:
          "Questionable Match (Fuzzy): amount/description align and sheet date is within +/- 14 days.",
        matchedSheetExpense: bestFuzzy.row,
        matchedSheetIndex: bestFuzzy.index,
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
