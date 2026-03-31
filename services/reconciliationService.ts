import { createHash } from "node:crypto";

export type BankProfile = {
  dateIndex: number | null;
  amountIndex: number | null;
  descriptionIndex: number | null;
  debitIndex?: number | null;
  creditIndex?: number | null;
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
    dateIndex: 0,
    amountIndex: null,
    descriptionIndex: 3,
    debitIndex: 5,
    creditIndex: 6,
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

type ResolvedBankProfile = {
  profile: BankProfile;
  startRowIndex: number;
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
  rowId?: string;
};

export type SheetTransferLike = {
  amount: number;
  timestamp?: string;
  date?: string;
  transferFrom?: string;
  transferTo?: string;
  description?: string;
  transferRowId?: string;
};

type TransferClaimStatus = {
  claimedCount: number;
  expectedLegs: number;
  isComplete: boolean;
  hasPositive: boolean;
  hasNegative: boolean;
};

export type MatchType =
  | "exact_match"
  | "processed"
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
  const hasSingleAmount = profile.amountIndex !== null;
  const hasSplitDebitCredit =
    profile.debitIndex != null && profile.creditIndex != null;
  return (
    profile.dateIndex !== null &&
    (hasSingleAmount || hasSplitDebitCredit) &&
    profile.descriptionIndex !== null
  );
}

function parseBankAmount(rawValue: string): number | null {
  const trimmed = String(rawValue).trim();
  if (!trimmed) return null;

  const isParenthesizedNegative = /^\(.*\)$/.test(trimmed);
  const normalized = trimmed.replace(/[,$\s()]/g, "");
  if (!normalized) return null;

  const numeric = Number(normalized);
  if (!Number.isFinite(numeric)) return null;
  return isParenthesizedNegative ? -Math.abs(numeric) : numeric;
}

function normalizeHeaderCell(value: string): string {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/\uFEFF/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function isVenmoProfile(accountName: string): boolean {
  return accountName.trim().toLowerCase() === "venmo";
}

function isCapitalOneProfile(accountName: string): boolean {
  return accountName.trim().toLowerCase() === "capital one";
}

function resolveVenmoProfile(rows: string[][], fallback: BankProfile): ResolvedBankProfile {
  if (!Array.isArray(rows) || !isProfileConfigured(fallback)) {
    return { profile: fallback, startRowIndex: 0 };
  }

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i] ?? [];
    const normalized = row.map((cell) => normalizeHeaderCell(cell));
    const dateIndex = normalized.findIndex(
      (cell) => cell === "datetime" || cell === "date time" || cell === "date",
    );
    const amountIndex = normalized.findIndex(
      (cell) => cell === "amount total" || cell === "total amount" || cell === "amount",
    );
    const descriptionIndex = normalized.findIndex(
      (cell) => cell === "note" || cell === "description" || cell === "details",
    );
    if (dateIndex >= 0 && amountIndex >= 0 && descriptionIndex >= 0) {
      return {
        profile: {
          dateIndex,
          amountIndex,
          descriptionIndex,
        },
        startRowIndex: i + 1,
      };
    }
  }

  return { profile: fallback, startRowIndex: 0 };
}

function resolveCapitalOneProfile(rows: string[][], fallback: BankProfile): ResolvedBankProfile {
  if (!Array.isArray(rows)) {
    return { profile: fallback, startRowIndex: 0 };
  }

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i] ?? [];
    const normalized = row.map((cell) => normalizeHeaderCell(cell));
    const dateIndex = normalized.findIndex(
      (cell) =>
        cell === "transaction date" ||
        cell === "transactiondate" ||
        cell === "date",
    );
    const descriptionIndex = normalized.findIndex((cell) => cell === "description");
    const debitIndex = normalized.findIndex((cell) => cell === "debit");
    const creditIndex = normalized.findIndex((cell) => cell === "credit");

    if (dateIndex >= 0 && descriptionIndex >= 0 && debitIndex >= 0 && creditIndex >= 0) {
      return {
        profile: {
          dateIndex,
          amountIndex: null,
          descriptionIndex,
          debitIndex,
          creditIndex,
        },
        startRowIndex: i + 1,
      };
    }
  }

  return { profile: fallback, startRowIndex: 0 };
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
const QUESTIONABLE_MAX_DAY_DISTANCE = 31;
const TRANSFER_CANDIDATE_MAX_DAY_DISTANCE = 31;

function isLikelyTransferDescription(value: string): boolean {
  const normalized = normalizeDescriptionForMatch(value);
  return /(?:\btransfer\b|\bvenmo\b|\bcashout\b|\bzelle\b|\bpaypal\b|\bcash\s*app\b|\bpayment\b|\bcardpmt\b|\bcrcardpmt\b|\bautopay\b|\bdeposit\b|\bwithdrawal\b)/
    .test(normalized);
}

export function mapBankRowToTransaction(
  accountName: keyof typeof BANK_PROFILES | string,
  row: string[],
  profileOverride?: BankProfile,
): BankTransaction | null {
  const profile = profileOverride ?? BANK_PROFILES[accountName];
  if (!profile || !isProfileConfigured(profile)) return null;

  const dateIndex = profile.dateIndex as number;
  const descriptionIndex = profile.descriptionIndex as number;
  const postedDate = String(row[dateIndex] ?? "").trim();
  const rawDescription = String(row[descriptionIndex] ?? "").trim();
  const description = cleanBankDescription(rawDescription);
  const derivedDate = deriveBankTransactionDate(String(accountName), postedDate, rawDescription);
  const date = normalizeDateOnly(derivedDate);
  let amount: number | null = null;
  if (profile.amountIndex !== null) {
    const rawAmount = String(row[profile.amountIndex] ?? "");
    amount = parseBankAmount(rawAmount);
  } else if (profile.debitIndex != null && profile.creditIndex != null) {
    const debitIdx = profile.debitIndex;
    const creditIdx = profile.creditIndex;
    const debitAmount = parseBankAmount(String(row[debitIdx] ?? ""));
    const creditAmount = parseBankAmount(String(row[creditIdx] ?? ""));
    if (debitAmount !== null && Math.abs(debitAmount) > 0) {
      amount = Math.abs(debitAmount);
    } else if (creditAmount !== null && Math.abs(creditAmount) > 0) {
      amount = -Math.abs(creditAmount);
    } else {
      amount = null;
    }
  }
  if (!date || !description || amount === null) return null;

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
  const fallbackProfile = BANK_PROFILES[accountName];
  if (!fallbackProfile || !isProfileConfigured(fallbackProfile)) return [];

  const resolved = isVenmoProfile(String(accountName))
    ? resolveVenmoProfile(rows, fallbackProfile)
    : isCapitalOneProfile(String(accountName))
      ? resolveCapitalOneProfile(rows, fallbackProfile)
      : { profile: fallbackProfile, startRowIndex: 0 };

  return rows
    .slice(resolved.startRowIndex)
    .map((row) => mapBankRowToTransaction(accountName, row, resolved.profile))
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
 * 1) Exact Match: amount+date equals a sheet row.
 * 2) Processed: hash exists in Neon but no current sheet row is linked.
 * 3) Questionable Match (Fuzzy): amount matches with description similarity and date is within +/- 31 days.
 * 4) Transfer: amount/date aligns with transfer rows or opposing bank transaction.
 * 5) Unmatched.
 */
export async function findMatches(
  bankTransactions: BankTransaction[],
  sheetExpenses: SheetExpenseLike[],
  options?: {
    processedHashes?: Iterable<string>;
    sheetTransfers?: SheetTransferLike[];
    transferClaimStatusByRowId?: Record<string, TransferClaimStatus>;
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

    if (exactSheet) {
      return {
        bankTransaction: tx,
        matchType: "exact_match",
        reason: "Exact Match: identical amount and date already exists in sheet.",
        matchedByNeonHash: exactByHash,
        matchedSheetExpense: exactSheet,
        matchedSheetIndex: exactSheetIndexValue >= 0 ? exactSheetIndexValue : undefined,
      };
    }
    if (exactByHash) {
      return {
        bankTransaction: tx,
        matchType: "processed",
        reason:
          "Already processed: transaction hash exists in Neon, but no linked sheet entry is currently found.",
        matchedByNeonHash: true,
      };
    }

    const sheetTransfers = options?.sheetTransfers ?? [];
    const transferClaimStatusByRowId = options?.transferClaimStatusByRowId ?? {};
    const transferCandidates = sheetTransfers
      .map((sheetTransfer, index) => {
        if (amountKey(sheetTransfer.amount) !== amountKey(tx.amount)) return null;
        const transferRowId = String(sheetTransfer.transferRowId ?? "").trim();
        const claimStatus = transferRowId ? transferClaimStatusByRowId[transferRowId] : undefined;
        if (claimStatus?.isComplete) return null;

        const txSign = cents(tx.amount) >= 0 ? 1 : -1;
        if (claimStatus && claimStatus.expectedLegs === 2) {
          const hasSameSignClaim = txSign > 0 ? claimStatus.hasPositive : claimStatus.hasNegative;
          if (hasSameSignClaim) return null;
        }

        const transferDate = sheetTransfer.date ?? sheetTransfer.timestamp ?? "";
        const dayDistance = dateDistanceInDays(transferDate, tx.date);
        if (dayDistance === null || dayDistance > TRANSFER_CANDIDATE_MAX_DAY_DISTANCE) return null;

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
          isLikelyTransferDescription(transferText) ||
          similarity >= 0.12;
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

      return {
        bankTransaction: tx,
        matchType: "questionable_match_fuzzy",
        reason:
          "Questionable Transfer Match: multiple transfer-sheet candidates share the same amount/date window.",
        matchedSheetTransfer: bestSheetTransfer.row,
        matchedSheetTransferIndex: bestSheetTransfer.index,
      };
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
          "Questionable Match (Fuzzy): amount/description align and sheet date is within +/- 31 days.",
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
