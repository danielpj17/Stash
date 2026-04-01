"use client";

import { useMemo, useState, useCallback, useEffect, useRef } from "react";
import { useDropzone } from "react-dropzone";
import Papa from "papaparse";
import { Ban, Check, Filter, Link2Off, Loader2, PlusCircle, Search, Upload, X } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";
import {
  getExpenses,
  getTransfers,
  submitExpense,
  type SheetRow,
  type TransferRow,
} from "@/services/sheetsApi";
import { EXPENSE_TYPE_OPTIONS } from "@/lib/constants";
import { getLatestSnaptradeBalances } from "@/services/snaptradeApi";
import type { BankTransaction, MatchResult } from "@/services/reconciliationService";
import {
  computeAccountBalances,
  getAccountAnchors,
  mapAccountNameToBalanceKey,
} from "@/services/accountBalancesService";
import { RECONCILIATION_RESET_CONFIRM } from "@/lib/reconciliationReset";

type AccountOption =
  | "WF Checking"
  | "WF Savings"
  | "Fidelity"
  | "Venmo - Daniel"
  | "Venmo - Katie"
  | "Capital One"
  | "Discover"
  | "Schwab"
  | "America First"
  | "Ally";

type MatchResponse = {
  bankTransactions: BankTransaction[];
  matches: MatchResult[];
};

type QuickAddState = {
  open: boolean;
  rowId: string | null;
  expenseType: string;
  amount: string;
  description: string;
  submitting: boolean;
  error: string;
};

type SplitDraftLine = {
  key: string;
  sheetName: "Expenses" | "Transfers";
  rowId: string;
  amount: number;
  expenseType: string;
  description: string;
  timestamp?: string;
  date?: string;
  account?: string;
  transferFrom?: string;
  transferTo?: string;
};

type SplitModalState = {
  open: boolean;
  rowId: string | null;
  selectedKeys: string[];
  candidates: SplitDraftLine[];
  /** Used when claiming a Transfers sheet row (1 vs 2 bank legs). */
  transferExpectedLegs: 1 | 2;
  submitting: boolean;
  error: string;
};

type TransferClaimModalState = {
  open: boolean;
  rowId: string | null;
  expectedLegs: 1 | 2;
  submitting: boolean;
  error: string;
};

type TransferClaimStatusByRowId = Record<
  string,
  { claimedCount: number; expectedLegs: number; isComplete: boolean }
>;

type ReconcileViewMode = "home" | "accountDetail";

type UserInputtedEntry = {
  id: string;
  source: "Expenses" | "Transfers";
  dateValue: string;
  title: string;
  subtitle: string;
  amount: number;
  isCompleted: boolean;
  /** Sheet "account" column for expense rows; used by home account filter. */
  expenseAccount?: string;
  transferFrom?: string;
  transferTo?: string;
};

type AnchorModalState = {
  open: boolean;
  date: string;
  balance: string;
  loading: boolean;
  saving: boolean;
  error: string;
};

type DismissModalState = {
  open: boolean;
  match: MatchResult | null;
  note: string;
  submitting: boolean;
  error: string;
};

type UserDismissModalState = {
  open: boolean;
  entry: UserInputtedEntry | null;
  note: string;
  submitting: boolean;
  error: string;
};

type ResetReconcileModalState = {
  open: boolean;
  confirmText: string;
  submitting: boolean;
  error: string;
};

type UserStatementClaimModalState = {
  open: boolean;
  entry: UserInputtedEntry | null;
  selectedBankRowId: string | null;
  searchQuery: string;
  accountFilter: AccountOption | typeof ALL_ACCOUNTS_OPTION;
  transferExpectedLegs: 1 | 2;
  submitting: boolean;
  error: string;
};

const ACCOUNT_OPTIONS: AccountOption[] = [
  "WF Checking",
  "WF Savings",
  "Fidelity",
  "Venmo - Daniel",
  "Venmo - Katie",
  "Capital One",
  "Discover",
  "Schwab",
  "America First",
  "Ally",
];
const ALL_ACCOUNTS_OPTION = "All";
const CSV_PARSER_READY_ACCOUNTS = new Set<AccountOption>([
  "WF Checking",
  "WF Savings",
  "Venmo - Daniel",
  "Venmo - Katie",
]);
const RECONCILE_STORAGE_KEY = "reconcile-page-state-v3";

function claimKey(sheetName: string, rowId: string): string {
  return `${sheetName}:${rowId}`;
}

/** For dismiss/claim APIs: real sheet row only (not `Expenses:missing:0`). */
function parseSheetDismissKeyFromEntryId(
  entryId: string,
): { sheetName: "Expenses" | "Transfers"; sheetRowId: string } | null {
  const firstColon = entryId.indexOf(":");
  if (firstColon === -1) return null;
  const sheetPrefix = entryId.slice(0, firstColon);
  if (sheetPrefix !== "Expenses" && sheetPrefix !== "Transfers") return null;
  const rest = entryId.slice(firstColon + 1);
  if (rest.startsWith("missing:")) return null;
  return { sheetName: sheetPrefix, sheetRowId: rest };
}

function idForTx(tx: BankTransaction): string {
  return `${tx.accountName}|${tx.hash}`;
}

/** Legacy bucket: CSV used BANK_PROFILES key "Wells Fargo"; UI accounts are WF Checking / WF Savings only. */
const LEGACY_WF_PROFILE_BUCKET = "Wells Fargo";

function mergeWellsFargoBucketIntoChecking(
  prev: Record<string, MatchResult[]>,
): Record<string, MatchResult[]> {
  const legacy = prev[LEGACY_WF_PROFILE_BUCKET];
  if (legacy === undefined) return prev;
  if (!legacy.length) {
    const next = { ...prev };
    delete next[LEGACY_WF_PROFILE_BUCKET];
    return next;
  }

  const checkingKey: AccountOption = "WF Checking";
  const retagged = legacy.map((m) => ({
    ...m,
    bankTransaction: {
      ...m.bankTransaction,
      accountName: checkingKey,
    },
  }));

  const existing = prev[checkingKey] ?? [];
  const byHash = new Map<string, MatchResult>();
  for (const row of existing) {
    byHash.set(row.bankTransaction.hash, row);
  }
  for (const row of retagged) {
    if (!byHash.has(row.bankTransaction.hash)) {
      byHash.set(row.bankTransaction.hash, row);
    }
  }

  const next: Record<string, MatchResult[]> = { ...prev };
  delete next[LEGACY_WF_PROFILE_BUCKET];
  next[checkingKey] = Array.from(byHash.values());
  return next;
}

function csvRowDedupeKey(row: string[]): string {
  return row.map((c) => String(c).trim()).join("\t");
}

/** Merge multiple CSV uploads per account; same row shape deduped, newest upload wins per key. */
function mergeCsvRowArrays(existing: string[][] | undefined, incoming: string[][]): string[][] {
  const byKey = new Map<string, string[]>();
  for (const row of existing ?? []) {
    const key = csvRowDedupeKey(row);
    if (key) byKey.set(key, row);
  }
  for (const row of incoming) {
    const key = csvRowDedupeKey(row);
    if (key) byKey.set(key, row);
  }
  return Array.from(byKey.values());
}

function fmtMoney(amount: number): string {
  return amount.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fmtDate(raw?: string): string {
  if (!raw) return "—";
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  return d.toLocaleDateString("en-US");
}

function sortByNewestDate<T>(rows: T[], getDate: (row: T) => string | undefined): T[] {
  return [...rows].sort((a, b) => {
    const aTime = Date.parse(getDate(a) ?? "");
    const bTime = Date.parse(getDate(b) ?? "");
    const safeATime = Number.isFinite(aTime) ? aTime : 0;
    const safeBTime = Number.isFinite(bTime) ? bTime : 0;
    return safeBTime - safeATime;
  });
}

function isStatementManualReview(match: MatchResult): boolean {
  return (
    match.matchType === "unmatched" ||
    match.matchType === "questionable_match_fuzzy" ||
    match.matchType === "transfer"
  );
}

function hasLinkedUserInputtedEntry(match: MatchResult): boolean {
  return Boolean(match.matchedSheetExpense || match.matchedSheetTransfer);
}

function accountHasConfiguredParser(account: string): boolean {
  return CSV_PARSER_READY_ACCOUNTS.has(account as AccountOption);
}

function normalizeDateOnly(raw?: string): string {
  if (!raw) return "";
  const trimmed = String(raw).trim();
  if (!trimmed) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return "";
  const y = parsed.getUTCFullYear();
  const m = String(parsed.getUTCMonth() + 1).padStart(2, "0");
  const d = String(parsed.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function normalizeText(raw?: string): string {
  return String(raw ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function buildExpenseSignature(amount: number, dateRaw?: string, description?: string): string {
  return `${toCents(Math.abs(Number(amount) || 0))}|${normalizeDateOnly(dateRaw)}|${normalizeText(description)}`;
}

function buildTransferSignature(
  amount: number,
  dateRaw?: string,
  transferFrom?: string,
  transferTo?: string,
): string {
  return `${toCents(Math.abs(Number(amount) || 0))}|${normalizeDateOnly(dateRaw)}|${normalizeText(
    transferFrom,
  )}|${normalizeText(transferTo)}`;
}

/** Same date field order as `findMatches` / matched sheet payloads: timestamp, then date. */
function sheetExpenseDateRaw(row: Pick<SheetRow, "timestamp" | "date">): string {
  return String(row.timestamp ?? row.date ?? "").trim();
}

function buildSheetExpenseSignatureFromRow(row: {
  amount?: number;
  timestamp?: string;
  date?: string;
  description?: string;
}): string {
  const dr = sheetExpenseDateRaw(row);
  return buildExpenseSignature(Number(row.amount ?? 0), dr || undefined, row.description);
}

function sheetTransferDateRaw(row: Pick<TransferRow, "timestamp" | "date">): string {
  return String(row.timestamp ?? row.date ?? "").trim();
}

function toCents(value: number): number {
  return Math.round(value * 100);
}

function parseExpenseRowIdFromEntryId(id: string): string | null {
  if (!id.startsWith("Expenses:")) return null;
  const rest = id.slice("Expenses:".length);
  if (rest.startsWith("missing:")) return null;
  return rest || null;
}

function parseTransferRowIdFromEntryId(id: string): string | null {
  if (!id.startsWith("Transfers:")) return null;
  const rest = id.slice("Transfers:".length);
  if (rest.startsWith("missing:")) return null;
  return rest || null;
}

function dateDistanceInDaysSafe(a: string, b: string): number {
  const na = normalizeDateOnly(a);
  const nb = normalizeDateOnly(b);
  if (!na || !nb) return 9999;
  const da = Date.parse(na);
  const db = Date.parse(nb);
  if (!Number.isFinite(da) || !Number.isFinite(db)) return 9999;
  return Math.abs(Math.round((db - da) / (86400 * 1000)));
}

function findBestStatementMatchForUserEntry(
  entry: UserInputtedEntry,
  reviewMatches: MatchResult[],
): MatchResult | null {
  const absAmt = Math.abs(entry.amount);
  const centsUser = toCents(absAmt);

  if (entry.source === "Expenses") {
    const rowId = parseExpenseRowIdFromEntryId(entry.id);
    if (rowId) {
      const direct = reviewMatches.find(
        (m) => String(m.matchedSheetExpense?.rowId ?? "").trim() === rowId,
      );
      if (direct) return direct;
    }
    const candidates = reviewMatches.filter(
      (m) => toCents(Math.abs(m.bankTransaction.amount)) === centsUser,
    );
    if (candidates.length === 0) return null;
    return [...candidates].sort(
      (a, b) =>
        dateDistanceInDaysSafe(a.bankTransaction.date, entry.dateValue) -
        dateDistanceInDaysSafe(b.bankTransaction.date, entry.dateValue),
    )[0];
  }

  if (entry.source === "Transfers") {
    const rowId = parseTransferRowIdFromEntryId(entry.id);
    if (rowId) {
      const direct = reviewMatches.find(
        (m) => String(m.matchedSheetTransfer?.transferRowId ?? "").trim() === rowId,
      );
      if (direct) return direct;
    }
    const candidates = reviewMatches.filter(
      (m) => toCents(Math.abs(m.bankTransaction.amount)) === centsUser,
    );
    if (candidates.length === 0) return null;
    return [...candidates].sort(
      (a, b) =>
        dateDistanceInDaysSafe(a.bankTransaction.date, entry.dateValue) -
        dateDistanceInDaysSafe(b.bankTransaction.date, entry.dateValue),
    )[0];
  }

  return null;
}

function parseCsvFile(file: File): Promise<string[][]> {
  return new Promise((resolve, reject) => {
    Papa.parse<string[]>(file, {
      skipEmptyLines: true,
      complete(results) {
        if (results.errors.length > 0) {
          reject(new Error(results.errors[0]?.message || "Failed to parse CSV."));
          return;
        }
        const rows = (results.data ?? []).filter(
          (row): row is string[] => Array.isArray(row) && row.some((cell) => String(cell).trim() !== ""),
        );
        resolve(rows);
      },
      error(error) {
        reject(error);
      },
    });
  });
}

export default function ReconcilePage() {
  const [selectedAccount, setSelectedAccount] = useState<AccountOption>("WF Checking");
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [matchesByAccount, setMatchesByAccount] = useState<Record<string, MatchResult[]>>({});
  const [activeTab, setActiveTab] = useState<string>(ACCOUNT_OPTIONS[0]);
  const [viewMode, setViewMode] = useState<ReconcileViewMode>("home");
  const [dismissalNotesById, setDismissalNotesById] = useState<Record<string, string>>({});
  const [userDismissedRowKeys, setUserDismissedRowKeys] = useState<Set<string>>(new Set());
  const [userDismissalNotesByEntryId, setUserDismissalNotesByEntryId] = useState<Record<string, string>>(
    {},
  );
  const [processedHashes, setProcessedHashes] = useState<Set<string>>(new Set());
  const [disconnectedIds, setDisconnectedIds] = useState<Set<string>>(new Set());
  const [actionError, setActionError] = useState("");
  const [processingId, setProcessingId] = useState<string | null>(null);
  const [sheetExpenses, setSheetExpenses] = useState<SheetRow[]>([]);
  const [sheetTransfers, setSheetTransfers] = useState<TransferRow[]>([]);
  const [uploadedFilesByAccount, setUploadedFilesByAccount] = useState<Record<string, string[]>>({});
  const [claimedRowKeys, setClaimedRowKeys] = useState<Set<string>>(new Set());
  const [transferClaimStatusByRowId, setTransferClaimStatusByRowId] =
    useState<TransferClaimStatusByRowId>({});
  /** Merged raw CSV rows per account — used to re-run /match for every account after a transfer leg claim. */
  const statementCsvRowsByAccountRef = useRef<Record<string, string[][]>>({});
  const [quickAdd, setQuickAdd] = useState<QuickAddState>({
    open: false,
    rowId: null,
    expenseType: "Misc.",
    amount: "",
    description: "",
    submitting: false,
    error: "",
  });
  const [splitModal, setSplitModal] = useState<SplitModalState>({
    open: false,
    rowId: null,
    selectedKeys: [],
    candidates: [],
    transferExpectedLegs: 2,
    submitting: false,
    error: "",
  });
  const [splitSearchQuery, setSplitSearchQuery] = useState("");
  const [homeSearchQuery, setHomeSearchQuery] = useState("");
  const [homeAccountFilter, setHomeAccountFilter] = useState<AccountOption | typeof ALL_ACCOUNTS_OPTION>(
    ALL_ACCOUNTS_OPTION,
  );
  const [userStatementClaimModal, setUserStatementClaimModal] = useState<UserStatementClaimModalState>({
    open: false,
    entry: null,
    selectedBankRowId: null,
    searchQuery: "",
    accountFilter: ALL_ACCOUNTS_OPTION,
    transferExpectedLegs: 2,
    submitting: false,
    error: "",
  });
  const [transferClaimModal, setTransferClaimModal] = useState<TransferClaimModalState>({
    open: false,
    rowId: null,
    expectedLegs: 2,
    submitting: false,
    error: "",
  });
  const [anchorModal, setAnchorModal] = useState<AnchorModalState>({
    open: false,
    date: new Date().toISOString().slice(0, 10),
    balance: "",
    loading: false,
    saving: false,
    error: "",
  });
  const [dismissModal, setDismissModal] = useState<DismissModalState>({
    open: false,
    match: null,
    note: "",
    submitting: false,
    error: "",
  });
  const [userDismissModal, setUserDismissModal] = useState<UserDismissModalState>({
    open: false,
    entry: null,
    note: "",
    submitting: false,
    error: "",
  });
  const [resetReconcileModal, setResetReconcileModal] = useState<ResetReconcileModalState>({
    open: false,
    confirmText: "",
    submitting: false,
    error: "",
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(RECONCILE_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as {
        selectedAccount?: string;
        activeTab?: string;
        matchesByAccount?: Record<string, MatchResult[]>;
      };

      if (
        parsed.selectedAccount &&
        ACCOUNT_OPTIONS.includes(parsed.selectedAccount as AccountOption)
      ) {
        setSelectedAccount(parsed.selectedAccount as AccountOption);
      }
      if (typeof parsed.activeTab === "string" && parsed.activeTab.trim()) {
        setActiveTab(parsed.activeTab);
      }
      if (
        parsed.matchesByAccount &&
        typeof parsed.matchesByAccount === "object" &&
        !Array.isArray(parsed.matchesByAccount)
      ) {
        setMatchesByAccount(mergeWellsFargoBucketIntoChecking(parsed.matchesByAccount));
      }
    } catch {
      // Ignore corrupted local storage and continue with empty in-memory state.
    }
  }, []);

  useEffect(() => {
    setMatchesByAccount((prev) => mergeWellsFargoBucketIntoChecking(prev));
  }, [matchesByAccount[LEGACY_WF_PROFILE_BUCKET]?.length]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const payload = {
      selectedAccount,
      activeTab,
      matchesByAccount,
    };
    try {
      window.localStorage.setItem(RECONCILE_STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // Ignore storage quota/security errors; page still works in-memory.
    }
  }, [activeTab, matchesByAccount, selectedAccount]);

  useEffect(() => {
    let cancelled = false;

    async function loadProcessedAndDismissals() {
      try {
        const [processedRes, dismissalsRes, userDismissalsRes] = await Promise.all([
          fetch("/api/reconciliation/processed", { cache: "no-store" }),
          fetch("/api/reconciliation/dismissals", { cache: "no-store" }),
          fetch("/api/reconciliation/user-dismissals", { cache: "no-store" }),
        ]);
        if (cancelled) return;
        if (processedRes.ok) {
          const data = (await processedRes.json()) as { hashes?: string[] };
          setProcessedHashes(new Set((data.hashes ?? []).map((hash) => String(hash))));
        }
        if (dismissalsRes.ok) {
          const data = (await dismissalsRes.json()) as {
            dismissals?: Array<{ hash: string; accountName: string; note: string }>;
          };
          const map: Record<string, string> = {};
          for (const d of data.dismissals ?? []) {
            map[`${d.accountName}|${d.hash}`] = d.note;
          }
          setDismissalNotesById(map);
        }
        if (userDismissalsRes.ok) {
          const data = (await userDismissalsRes.json()) as {
            dismissedKeys?: string[];
            dismissals?: Array<{ sheetName: string; sheetRowId: string; note: string }>;
          };
          const keys = new Set<string>((data.dismissedKeys ?? []).map((k) => String(k)));
          setUserDismissedRowKeys(keys);
          const noteMap: Record<string, string> = {};
          for (const d of data.dismissals ?? []) {
            noteMap[claimKey(d.sheetName, d.sheetRowId)] = d.note;
          }
          setUserDismissalNotesByEntryId(noteMap);
        }
      } catch {
        // Keep in-memory defaults if fetch fails.
      }
    }

    void loadProcessedAndDismissals();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadUploadedFilesFromNeon() {
      try {
        const res = await fetch("/api/reconciliation/uploaded-files", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { filesByAccount?: Record<string, string[]> };
        if (cancelled) return;
        setUploadedFilesByAccount(data.filesByAccount ?? {});
      } catch {
        // Non-critical UI history can stay empty if unavailable.
      }
    }

    async function migrateLegacyLocalUploadedFiles() {
      if (typeof window === "undefined") return;
      const migrationKey = "reconcile-uploaded-files-migrated-v1";
      if (window.localStorage.getItem(migrationKey) === "1") return;
      try {
        const raw = window.localStorage.getItem(RECONCILE_STORAGE_KEY);
        if (!raw) {
          window.localStorage.setItem(migrationKey, "1");
          return;
        }
        const parsed = JSON.parse(raw) as { uploadedFilesByAccount?: Record<string, unknown> };
        const legacy = parsed.uploadedFilesByAccount;
        if (!legacy || typeof legacy !== "object" || Array.isArray(legacy)) {
          window.localStorage.setItem(migrationKey, "1");
          return;
        }

        const writes: Promise<Response>[] = [];
        for (const [accountName, files] of Object.entries(legacy)) {
          if (!Array.isArray(files)) continue;
          for (const file of files) {
            const fileName = String(file).trim();
            if (!fileName) continue;
            writes.push(
              fetch("/api/reconciliation/uploaded-files", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ accountName, fileName }),
              }),
            );
          }
        }
        if (writes.length > 0) {
          await Promise.all(writes);
          await loadUploadedFilesFromNeon();
        }
        window.localStorage.setItem(migrationKey, "1");
      } catch {
        // Retry migration next load if parsing/network fails.
      }
    }

    void loadUploadedFilesFromNeon();
    void migrateLegacyLocalUploadedFiles();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadUserInputtedState() {
      try {
        const [rows, transfers, claimsRes, transferClaimsRes] = await Promise.all([
          getExpenses(),
          getTransfers(),
          fetch("/api/reconciliation/claims", { cache: "no-store" }),
          fetch("/api/reconciliation/transfer-claims", { cache: "no-store" }),
        ]);
        if (!claimsRes.ok || !transferClaimsRes.ok) return;

        const claimsData = (await claimsRes.json()) as { claimedRowIds?: string[] };
        const claimedRows = new Set((claimsData.claimedRowIds ?? []).map((id) => String(id)));
        const transferClaimsData = (await transferClaimsRes.json()) as {
          statusByRowId?: TransferClaimStatusByRowId;
        };
        if (cancelled) return;
        setSheetExpenses(rows);
        setSheetTransfers(transfers);
        setClaimedRowKeys(claimedRows);
        setTransferClaimStatusByRowId(transferClaimsData.statusByRowId ?? {});
      } catch {
        // Home view still works with partial/no user-inputted reconciliation data.
      }
    }

    void loadUserInputtedState();
    return () => {
      cancelled = true;
    };
  }, []);

  const allMatches = useMemo(() => Object.values(matchesByAccount).flat(), [matchesByAccount]);

  const tabAccounts = useMemo(() => {
    const uploaded = Object.keys(matchesByAccount).filter((a) => a !== LEGACY_WF_PROFILE_BUCKET);
    const merged = [...ACCOUNT_OPTIONS];
    for (const account of uploaded) {
      if (!merged.includes(account as AccountOption)) merged.push(account as AccountOption);
    }
    return merged;
  }, [matchesByAccount]);

  useEffect(() => {
    if (activeTab === LEGACY_WF_PROFILE_BUCKET) {
      setActiveTab("WF Checking");
    }
  }, [activeTab]);

  const statementRowsByAccount = useMemo(() => {
    const byAccount: Record<string, MatchResult[]> = {};
    tabAccounts.forEach((account) => {
      byAccount[account] = sortByNewestDate(
        (matchesByAccount[account] ?? []).filter(
          (row) => row.bankTransaction.accountName === account,
        ),
        (row) => row.bankTransaction.date,
      );
    });
    return byAccount;
  }, [matchesByAccount, tabAccounts]);

  const statementReviewRowsByAccount = useMemo(() => {
    const byAccount: Record<string, MatchResult[]> = {};
    tabAccounts.forEach((account) => {
      byAccount[account] = statementRowsByAccount[account].filter((match) => {
        const id = idForTx(match.bankTransaction);
        if (processedHashes.has(match.bankTransaction.hash)) return false;
        return isStatementManualReview(match) || disconnectedIds.has(id);
      });
    });
    return byAccount;
  }, [processedHashes, disconnectedIds, statementRowsByAccount, tabAccounts]);

  const statementCompletedRowsByAccount = useMemo(() => {
    const byAccount: Record<string, MatchResult[]> = {};
    tabAccounts.forEach((account) => {
      byAccount[account] = statementRowsByAccount[account].filter((match) => {
        const id = idForTx(match.bankTransaction);
        if (disconnectedIds.has(id)) return false;
        if (!processedHashes.has(match.bankTransaction.hash)) return false;
        const dismissed = Boolean(dismissalNotesById[id]);
        const completedWithoutExactSheet =
          match.matchType !== "exact_match" || !hasLinkedUserInputtedEntry(match);
        return completedWithoutExactSheet || dismissed;
      });
    });
    return byAccount;
  }, [dismissalNotesById, processedHashes, disconnectedIds, statementRowsByAccount, tabAccounts]);

  const statementAutoMatchedRowsByAccount = useMemo(() => {
    const byAccount: Record<string, MatchResult[]> = {};
    tabAccounts.forEach((account) => {
      byAccount[account] = statementRowsByAccount[account].filter((match) => {
        const id = idForTx(match.bankTransaction);
        if (disconnectedIds.has(id)) return false;
        if (dismissalNotesById[id]) return false;
        return match.matchType === "exact_match" && hasLinkedUserInputtedEntry(match);
      });
    });
    return byAccount;
  }, [dismissalNotesById, disconnectedIds, statementRowsByAccount, tabAccounts]);

  const autoCompletedExpenseSignatures = useMemo(() => {
    const signatures = new Set<string>();
    for (const match of allMatches) {
      const isCompleted =
        match.matchType === "exact_match" || processedHashes.has(match.bankTransaction.hash);
      if (!isCompleted || !match.matchedSheetExpense) continue;
      signatures.add(buildSheetExpenseSignatureFromRow(match.matchedSheetExpense));
    }
    return signatures;
  }, [allMatches, processedHashes]);

  const expenseRowIdsLinkedByExactMatch = useMemo(() => {
    const ids = new Set<string>();
    for (const match of allMatches) {
      if (match.matchType !== "exact_match" || !match.matchedSheetExpense) continue;
      const id = String(match.matchedSheetExpense.rowId ?? "").trim();
      if (id) ids.add(id);
    }
    return ids;
  }, [allMatches]);

  const autoCompletedTransferSignatures = useMemo(() => {
    const signatures = new Set<string>();
    for (const match of allMatches) {
      if (!match.matchedSheetTransfer) continue;
      const rowId = String(match.matchedSheetTransfer.transferRowId ?? "").trim();
      if (rowId) {
        const status = transferClaimStatusByRowId[rowId];
        if (!status?.isComplete) continue;
      } else {
        const isCompleted =
          match.matchType === "exact_match" || processedHashes.has(match.bankTransaction.hash);
        if (!isCompleted) continue;
      }
      signatures.add(
        buildTransferSignature(
          Number(match.matchedSheetTransfer.amount ?? 0),
          match.matchedSheetTransfer.timestamp ?? match.matchedSheetTransfer.date,
          match.matchedSheetTransfer.transferFrom,
          match.matchedSheetTransfer.transferTo,
        ),
      );
    }
    return signatures;
  }, [allMatches, processedHashes, transferClaimStatusByRowId]);

  const userInputtedEntries = useMemo(() => {
    const expenseEntries: UserInputtedEntry[] = sheetExpenses.map((row, index) => {
      const rowId = (row.rowId ?? "").trim();
      const key = rowId ? claimKey("Expenses", rowId) : `Expenses:missing:${index}`;
      const claimed = rowId ? claimedRowKeys.has(claimKey("Expenses", rowId)) : false;
      const dateValue = sheetExpenseDateRaw(row);
      const tiedByExactMatch = Boolean(rowId && expenseRowIdsLinkedByExactMatch.has(rowId));
      const autoCompleted = autoCompletedExpenseSignatures.has(buildSheetExpenseSignatureFromRow(row));
      const userDismissed = userDismissedRowKeys.has(key);
      return {
        id: key,
        source: "Expenses",
        dateValue,
        title: row.description || row.expenseType || "Expense row",
        subtitle: `${row.account ?? "No account"} • ${fmtDate(dateValue)}`,
        amount: Number(row.amount ?? 0),
        isCompleted: claimed || tiedByExactMatch || autoCompleted || userDismissed,
        expenseAccount: row.account?.trim() || undefined,
      };
    });

    const transferEntries: UserInputtedEntry[] = sheetTransfers.map((row, index) => {
      const rowId = (row.transferRowId ?? "").trim();
      const status = rowId ? transferClaimStatusByRowId[rowId] : undefined;
      const claimed = rowId ? claimedRowKeys.has(claimKey("Transfers", rowId)) : false;
      const dateValue = sheetTransferDateRaw(row);
      const title = `${row.transferFrom || "—"} → ${row.transferTo || "—"}`;
      const autoCompleted = autoCompletedTransferSignatures.has(
        buildTransferSignature(
          Number(row.amount ?? 0),
          dateValue || undefined,
          row.transferFrom,
          row.transferTo,
        ),
      );
      const tid = rowId ? `Transfers:${rowId}` : `Transfers:missing:${index}`;
      const userDismissed = userDismissedRowKeys.has(tid);
      return {
        id: tid,
        source: "Transfers",
        dateValue,
        title,
        subtitle: `Transfer • ${fmtDate(dateValue)}`,
        amount: Number(row.amount ?? 0),
        isCompleted: claimed || Boolean(status?.isComplete) || autoCompleted || userDismissed,
        transferFrom: row.transferFrom,
        transferTo: row.transferTo,
      };
    });

    return sortByNewestDate([...expenseEntries, ...transferEntries], (entry) => entry.dateValue);
  }, [
    autoCompletedExpenseSignatures,
    autoCompletedTransferSignatures,
    claimedRowKeys,
    expenseRowIdsLinkedByExactMatch,
    sheetExpenses,
    sheetTransfers,
    transferClaimStatusByRowId,
    userDismissedRowKeys,
  ]);

  /** Unprocessed bank lines across accounts — includes exact_match etc., not only manual-review rows. */
  const allUnprocessedStatementMatchesForClaim = useMemo(() => {
    const list: MatchResult[] = [];
    for (const account of tabAccounts) {
      for (const m of statementRowsByAccount[account] ?? []) {
        if (processedHashes.has(m.bankTransaction.hash)) continue;
        list.push(m);
      }
    }
    return sortByNewestDate(list, (match) => match.bankTransaction.date);
  }, [processedHashes, statementRowsByAccount, tabAccounts]);

  const userInputtedReviewRows = useMemo(
    () => userInputtedEntries.filter((e) => !e.isCompleted),
    [userInputtedEntries],
  );

  const homeRowsWithSuggestedBank = useMemo(
    () =>
      userInputtedReviewRows.map((entry) => ({
        entry,
        suggestedBank: findBestStatementMatchForUserEntry(entry, allUnprocessedStatementMatchesForClaim),
      })),
    [allUnprocessedStatementMatchesForClaim, userInputtedReviewRows],
  );

  const homeFilteredIncompleteRows = useMemo(() => {
    let rows = homeRowsWithSuggestedBank;
    const q = normalizeText(homeSearchQuery);
    if (q) {
      rows = rows.filter(({ entry, suggestedBank }) => {
        const tx = suggestedBank?.bankTransaction;
        const hay = [
          entry.title,
          entry.subtitle,
          entry.source,
          entry.expenseAccount,
          entry.transferFrom,
          entry.transferTo,
          tx?.description,
          tx?.accountName,
          tx?.date,
        ]
          .map((v) => normalizeText(v))
          .join(" ");
        return hay.includes(q);
      });
    }
    if (homeAccountFilter !== ALL_ACCOUNTS_OPTION) {
      rows = rows.filter(({ entry, suggestedBank }) => {
        if (suggestedBank?.bankTransaction.accountName === homeAccountFilter) return true;
        if (entry.source === "Expenses" && entry.expenseAccount === homeAccountFilter) return true;
        if (entry.source === "Transfers") {
          return (
            entry.transferFrom === homeAccountFilter || entry.transferTo === homeAccountFilter
          );
        }
        return false;
      });
    }
    return rows;
  }, [homeAccountFilter, homeRowsWithSuggestedBank, homeSearchQuery]);

  const allHomeMatchedMatches = useMemo(() => {
    const list: MatchResult[] = [];
    for (const account of tabAccounts) {
      list.push(...(statementAutoMatchedRowsByAccount[account] ?? []));
      list.push(...(statementCompletedRowsByAccount[account] ?? []));
    }
    return sortByNewestDate(list, (m) => m.bankTransaction.date);
  }, [statementAutoMatchedRowsByAccount, statementCompletedRowsByAccount, tabAccounts]);

  /** Real sheet ↔ bank pairs only (excludes “approve checkmark” / dismiss with no expense or transfer row). */
  const allHomeUserLinkedMatchedMatches = useMemo(
    () => allHomeMatchedMatches.filter((m) => hasLinkedUserInputtedEntry(m)),
    [allHomeMatchedMatches],
  );

  const allHomeStatementClosedOnlyMatches = useMemo(
    () => allHomeMatchedMatches.filter((m) => !hasLinkedUserInputtedEntry(m)),
    [allHomeMatchedMatches],
  );

  const homeFilteredMatchedRows = useMemo(() => {
    let rows = allHomeUserLinkedMatchedMatches;
    const q = normalizeText(homeSearchQuery);
    if (q) {
      rows = rows.filter((match) => {
        const tx = match.bankTransaction;
        const exp = match.matchedSheetExpense;
        const tr = match.matchedSheetTransfer;
        const hay = [
          tx.description,
          tx.accountName,
          tx.date,
          exp?.description,
          exp?.expenseType,
          exp?.account,
          tr?.transferFrom,
          tr?.transferTo,
        ]
          .map((v) => normalizeText(v))
          .join(" ");
        return hay.includes(q);
      });
    }
    if (homeAccountFilter !== ALL_ACCOUNTS_OPTION) {
      rows = rows.filter((match) => {
        if (match.bankTransaction.accountName === homeAccountFilter) return true;
        if (match.matchedSheetExpense?.account === homeAccountFilter) return true;
        if (match.matchedSheetTransfer) {
          return (
            match.matchedSheetTransfer.transferFrom === homeAccountFilter ||
            match.matchedSheetTransfer.transferTo === homeAccountFilter
          );
        }
        return false;
      });
    }
    return rows;
  }, [allHomeUserLinkedMatchedMatches, homeAccountFilter, homeSearchQuery]);

  const homeFilteredStatementClosedRows = useMemo(() => {
    let rows = allHomeStatementClosedOnlyMatches;
    const q = normalizeText(homeSearchQuery);
    if (q) {
      rows = rows.filter((match) => {
        const tx = match.bankTransaction;
        const tid = idForTx(tx);
        const note = dismissalNotesById[tid];
        const hay = [
          tx.description,
          tx.accountName,
          tx.date,
          note,
          match.matchType,
          match.reason,
        ]
          .map((v) => normalizeText(v))
          .join(" ");
        return hay.includes(q);
      });
    }
    if (homeAccountFilter !== ALL_ACCOUNTS_OPTION) {
      rows = rows.filter((match) => match.bankTransaction.accountName === homeAccountFilter);
    }
    return rows;
  }, [
    allHomeStatementClosedOnlyMatches,
    dismissalNotesById,
    homeAccountFilter,
    homeSearchQuery,
  ]);

  const homeFilteredUserDismissedRows = useMemo(() => {
    let rows = userInputtedEntries.filter((e) => userDismissedRowKeys.has(e.id));
    const q = normalizeText(homeSearchQuery);
    if (q) {
      rows = rows.filter((entry) => {
        const hay = [
          entry.title,
          entry.subtitle,
          entry.source,
          entry.expenseAccount,
          entry.transferFrom,
          entry.transferTo,
          userDismissalNotesByEntryId[entry.id],
        ]
          .map((v) => normalizeText(v))
          .join(" ");
        return hay.includes(q);
      });
    }
    if (homeAccountFilter !== ALL_ACCOUNTS_OPTION) {
      rows = rows.filter((entry) => {
        if (entry.source === "Expenses" && entry.expenseAccount === homeAccountFilter) return true;
        if (entry.source === "Transfers") {
          return (
            entry.transferFrom === homeAccountFilter || entry.transferTo === homeAccountFilter
          );
        }
        return false;
      });
    }
    return sortByNewestDate(rows, (entry) => entry.dateValue);
  }, [
    homeAccountFilter,
    homeSearchQuery,
    userDismissalNotesByEntryId,
    userDismissedRowKeys,
    userInputtedEntries,
  ]);

  const userClaimFilteredStatementLines = useMemo(() => {
    if (!userStatementClaimModal.open || !userStatementClaimModal.entry) return [];
    const entry = userStatementClaimModal.entry;
    const userCents = toCents(Math.abs(entry.amount));
    let list = allUnprocessedStatementMatchesForClaim.filter(
      (m) => toCents(Math.abs(m.bankTransaction.amount)) === userCents,
    );
    if (userStatementClaimModal.accountFilter !== ALL_ACCOUNTS_OPTION) {
      list = list.filter(
        (m) => m.bankTransaction.accountName === userStatementClaimModal.accountFilter,
      );
    }
    const q = normalizeText(userStatementClaimModal.searchQuery);
    if (q) {
      list = list.filter((m) => {
        const tx = m.bankTransaction;
        return [tx.description, tx.accountName, tx.date, String(tx.amount)]
          .map((v) => normalizeText(v))
          .join(" ")
          .includes(q);
      });
    }
    return list;
  }, [allUnprocessedStatementMatchesForClaim, userStatementClaimModal]);

  const openQuickAdd = useCallback((match: MatchResult) => {
    const tx = match.bankTransaction;
    setQuickAdd({
      open: true,
      rowId: idForTx(tx),
      expenseType: tx.amount < 0 ? "Misc." : "Income",
      amount: String(Math.abs(tx.amount).toFixed(2)),
      description: tx.description,
      submitting: false,
      error: "",
    });
  }, []);

  const closeQuickAdd = useCallback(() => {
    setQuickAdd((prev) => ({ ...prev, open: false, rowId: null, error: "", submitting: false }));
  }, []);

  const openSplitModal = useCallback(async (match: MatchResult) => {
    const tx = match.bankTransaction;
    setActionError("");
    try {
      const [freshSheetRows, freshTransfers, claimsRes] = await Promise.all([
        getExpenses(),
        getTransfers(),
        fetch("/api/reconciliation/claims", { cache: "no-store" }),
      ]);
      if (!claimsRes.ok) {
        const err = await claimsRes.json().catch(() => ({ error: claimsRes.statusText }));
        throw new Error(err.error || "Failed to load claimed sheet rows.");
      }
      const claimsData = (await claimsRes.json()) as { claimedRowIds?: string[] };
      const claimedRows = new Set((claimsData.claimedRowIds ?? []).map((id) => String(id)));

      setSheetExpenses(freshSheetRows);
      setSheetTransfers(freshTransfers);
      setClaimedRowKeys(claimedRows);

      const expenseCandidates: SplitDraftLine[] = freshSheetRows
        .filter((row) => {
          const rowId = (row.rowId ?? "").trim();
          if (!rowId) return false;
          return !claimedRows.has(claimKey("Expenses", rowId));
        })
        .map((row) => {
          const rowId = (row.rowId ?? "").trim();
          return {
            key: claimKey("Expenses", rowId),
            sheetName: "Expenses" as const,
            rowId,
            amount: Math.abs(Number(row.amount)),
            expenseType: row.expenseType,
            description: row.description,
            timestamp: row.timestamp,
            date: row.date,
            account: row.account,
          };
        });

      const transferCandidates: SplitDraftLine[] = freshTransfers
        .filter((row) => {
          const rowId = (row.transferRowId ?? "").trim();
          if (!rowId) return false;
          return !claimedRows.has(claimKey("Transfers", rowId));
        })
        .map((row) => {
          const rowId = (row.transferRowId ?? "").trim();
          const from = row.transferFrom?.trim() || "—";
          const to = row.transferTo?.trim() || row.description?.trim() || "—";
          return {
            key: claimKey("Transfers", rowId),
            sheetName: "Transfers" as const,
            rowId,
            amount: Math.abs(Number(row.amount)),
            expenseType: "Transfer",
            description: `${from} → ${to}`,
            timestamp: row.timestamp,
            date: row.date,
            account: undefined,
            transferFrom: row.transferFrom,
            transferTo: row.transferTo,
          };
        });

      const availableCandidates = sortByNewestDate(
        [...expenseCandidates, ...transferCandidates],
        (r) => r.timestamp,
      );

      setSplitModal({
        open: true,
        rowId: idForTx(tx),
        selectedKeys: [],
        candidates: availableCandidates,
        transferExpectedLegs: 2,
        submitting: false,
        error: "",
      });
      setSplitSearchQuery("");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to open claim modal.");
    }
  }, []);

  const closeSplitModal = useCallback(() => {
    setSplitModal({
      open: false,
      rowId: null,
      selectedKeys: [],
      candidates: [],
      transferExpectedLegs: 2,
      submitting: false,
      error: "",
    });
    setSplitSearchQuery("");
  }, []);

  const openUserStatementClaimModal = useCallback((entry: UserInputtedEntry) => {
    setUserStatementClaimModal({
      open: true,
      entry,
      selectedBankRowId: null,
      searchQuery: "",
      accountFilter: ALL_ACCOUNTS_OPTION,
      transferExpectedLegs: 2,
      submitting: false,
      error: "",
    });
  }, []);

  const closeUserStatementClaimModal = useCallback(() => {
    setUserStatementClaimModal({
      open: false,
      entry: null,
      selectedBankRowId: null,
      searchQuery: "",
      accountFilter: ALL_ACCOUNTS_OPTION,
      transferExpectedLegs: 2,
      submitting: false,
      error: "",
    });
  }, []);

  const openTransferClaimModal = useCallback((match: MatchResult) => {
    const tx = match.bankTransaction;
    const rowId = String(match.matchedSheetTransfer?.transferRowId ?? "").trim();
    const status = rowId ? transferClaimStatusByRowId[rowId] : undefined;
    const expectedLegs = status?.expectedLegs === 1 ? 1 : 2;
    setTransferClaimModal({
      open: true,
      rowId: idForTx(tx),
      expectedLegs,
      submitting: false,
      error: "",
    });
  }, [transferClaimStatusByRowId]);

  const closeTransferClaimModal = useCallback(() => {
    setTransferClaimModal({
      open: false,
      rowId: null,
      expectedLegs: 2,
      submitting: false,
      error: "",
    });
  }, []);

  const openAnchorModal = useCallback(async () => {
    setAnchorModal({
      open: true,
      date: new Date().toISOString().slice(0, 10),
      balance: "",
      loading: true,
      saving: false,
      error: "",
    });
    try {
      const [rows, transfers, latestBroker, anchors] = await Promise.all([
        getExpenses(),
        getTransfers(),
        getLatestSnaptradeBalances(),
        getAccountAnchors(),
      ]);
      const balances = computeAccountBalances(rows, transfers, latestBroker.balances ?? {}, anchors);
      const key = mapAccountNameToBalanceKey(selectedAccount);
      const balance = balances[key];
      if (!Number.isFinite(balance)) {
        throw new Error(`Could not determine current balance for ${selectedAccount}.`);
      }
      setAnchorModal((prev) => ({
        ...prev,
        loading: false,
        balance: Number(balance).toFixed(2),
      }));
    } catch (err) {
      setAnchorModal((prev) => ({
        ...prev,
        loading: false,
        error: err instanceof Error ? err.message : "Failed to load current balance.",
      }));
    }
  }, [selectedAccount]);

  const closeAnchorModal = useCallback(() => {
    setAnchorModal((prev) => ({
      ...prev,
      open: false,
      loading: false,
      saving: false,
      error: "",
    }));
  }, []);

  const handleSaveAnchor = useCallback(async () => {
    const confirmedBalance = Number(anchorModal.balance);
    if (!Number.isFinite(confirmedBalance)) {
      setAnchorModal((prev) => ({ ...prev, error: "Enter a valid balance." }));
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(anchorModal.date)) {
      setAnchorModal((prev) => ({ ...prev, error: "Select a valid statement date." }));
      return;
    }

    setAnchorModal((prev) => ({ ...prev, saving: true, error: "" }));
    try {
      const res = await fetch("/api/reconciliation/anchors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountName: selectedAccount,
          confirmedBalance,
          asOfDate: anchorModal.date,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || `Failed to save statement balance (${res.status})`);
      }
      closeAnchorModal();
    } catch (err) {
      setAnchorModal((prev) => ({
        ...prev,
        saving: false,
        error: err instanceof Error ? err.message : "Failed to save statement ending balance.",
      }));
    }
  }, [anchorModal.balance, anchorModal.date, closeAnchorModal, selectedAccount]);

  const persistProcessedHash = useCallback(async (tx: BankTransaction) => {
    const res = await fetch("/api/reconciliation/processed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hash: tx.hash, accountName: tx.accountName }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `Failed to save hash (${res.status})`);
    }
  }, []);

  const handleUserStatementClaimSubmit = useCallback(async () => {
    const { entry, selectedBankRowId, transferExpectedLegs } = userStatementClaimModal;
    if (!entry || !selectedBankRowId) {
      setUserStatementClaimModal((prev) => ({ ...prev, error: "Select a statement line." }));
      return;
    }
    const selected = allMatches.find((m) => idForTx(m.bankTransaction) === selectedBankRowId);
    if (!selected) {
      setUserStatementClaimModal((prev) => ({
        ...prev,
        error: "Statement line no longer available.",
      }));
      return;
    }

    let sheetName: "Expenses" | "Transfers";
    let rowId: string;
    if (entry.source === "Expenses") {
      const id = parseExpenseRowIdFromEntryId(entry.id);
      if (!id) {
        setUserStatementClaimModal((prev) => ({
          ...prev,
          error: "Expense row is missing a Row ID.",
        }));
        return;
      }
      sheetName = "Expenses";
      rowId = id;
    } else {
      const id = parseTransferRowIdFromEntryId(entry.id);
      if (!id) {
        setUserStatementClaimModal((prev) => ({
          ...prev,
          error: "Transfer row is missing a Transfer Row ID.",
        }));
        return;
      }
      sheetName = "Transfers";
      rowId = id;
    }

    const targetCents = toCents(Math.abs(selected.bankTransaction.amount));
    const linkCents = toCents(Math.abs(entry.amount));
    if (targetCents !== linkCents) {
      setUserStatementClaimModal((prev) => ({
        ...prev,
        error: "Selected statement amount must match the user-inputted amount.",
      }));
      return;
    }

    setUserStatementClaimModal((prev) => ({ ...prev, submitting: true, error: "" }));
    try {
      const res = await fetch("/api/reconciliation/claims", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bankTransaction: {
            hash: selected.bankTransaction.hash,
            accountName: selected.bankTransaction.accountName,
            amount: selected.bankTransaction.amount,
            date: selected.bankTransaction.date,
            description: selected.bankTransaction.description,
          },
          links: [
            {
              sheetName,
              sheetRowId: rowId,
              amount: Math.abs(entry.amount),
            },
          ],
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || `Failed to claim (${res.status})`);
      }

      if (sheetName === "Transfers") {
        const tRes = await fetch("/api/reconciliation/transfer-claims", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            transferRowId: rowId,
            expectedLegs: transferExpectedLegs,
            bankTransaction: {
              hash: selected.bankTransaction.hash,
              accountName: selected.bankTransaction.accountName,
              amount: selected.bankTransaction.amount,
            },
          }),
        });
        if (!tRes.ok) {
          const err = await tRes.json().catch(() => ({ error: tRes.statusText }));
          throw new Error(
            err.error ||
              `Saved sheet link but transfer leg tracking failed (${tRes.status}). Try again.`,
          );
        }
        const tClaimsGet = await fetch("/api/reconciliation/transfer-claims", { cache: "no-store" });
        if (tClaimsGet.ok) {
          const transferClaimsData = (await tClaimsGet.json()) as {
            statusByRowId?: TransferClaimStatusByRowId;
          };
          setTransferClaimStatusByRowId(transferClaimsData.statusByRowId ?? {});
        }
      }

      await persistProcessedHash(selected.bankTransaction);
      setProcessedHashes((prev) => new Set(prev).add(selected.bankTransaction.hash));
      setClaimedRowKeys((prev) => {
        const next = new Set(prev);
        next.add(claimKey(sheetName, rowId));
        return next;
      });

      const bankRowId = idForTx(selected.bankTransaction);
      setMatchesByAccount((prev) => {
        const next: Record<string, MatchResult[]> = {};
        for (const [account, rows] of Object.entries(prev)) {
          next[account] = rows.map((row) => {
            if (idForTx(row.bankTransaction) !== bankRowId) return row;
            if (sheetName === "Transfers") {
              const tr = sheetTransfers.find((t) => (t.transferRowId ?? "").trim() === rowId);
              if (!tr) return row;
              const amountSignedForTransfer =
                selected.bankTransaction.amount < 0
                  ? -Math.abs(Number(tr.amount ?? 0))
                  : Math.abs(Number(tr.amount ?? 0));
              return {
                ...row,
                matchType: "exact_match",
                reason: "Claimed transfer sheet row and marked processed.",
                matchedSheetTransfer: {
                  amount: amountSignedForTransfer,
                  transferRowId: rowId,
                  transferFrom: tr.transferFrom,
                  transferTo: tr.transferTo,
                  timestamp: tr.timestamp,
                  date: tr.date,
                },
                matchedSheetTransferIndex: undefined,
                matchedSheetExpense: undefined,
                matchedSheetIndex: undefined,
              };
            }
            const exp = sheetExpenses.find((e) => (e.rowId ?? "").trim() === rowId);
            if (!exp) return row;
            return {
              ...row,
              matchType: "exact_match",
              reason: "Claimed existing sheet row and marked processed.",
              matchedSheetExpense: {
                amount: Math.abs(Number(exp.amount)),
                timestamp: exp.timestamp ?? selected.bankTransaction.date,
                description: exp.description ?? "",
                expenseType: exp.expenseType ?? "—",
                account: exp.account ?? selected.bankTransaction.accountName,
                rowId: exp.rowId,
                date: exp.date,
              },
              matchedSheetIndex: undefined,
              matchedSheetTransfer: undefined,
              matchedSheetTransferIndex: undefined,
            };
          });
        }
        return next;
      });
      setDisconnectedIds((prev) => {
        const next = new Set(prev);
        next.delete(bankRowId);
        return next;
      });
      closeUserStatementClaimModal();
    } catch (err) {
      setUserStatementClaimModal((prev) => ({
        ...prev,
        submitting: false,
        error: err instanceof Error ? err.message : "Failed to claim statement line.",
      }));
    }
  }, [
    allMatches,
    closeUserStatementClaimModal,
    persistProcessedHash,
    sheetExpenses,
    sheetTransfers,
    userStatementClaimModal,
  ]);

  const rematchAllStoredAccounts = useCallback(async () => {
    const accounts = Object.keys(statementCsvRowsByAccountRef.current);
    if (accounts.length === 0) return;

    const [
      sheetRows,
      sheetTransfers,
      processedHashesRes,
      dismissalsRes,
      userDismissalsRes,
      claimsRes,
      transferClaimsRes,
    ] = await Promise.all([
      getExpenses(),
      getTransfers(),
      fetch("/api/reconciliation/processed", { cache: "no-store" }),
      fetch("/api/reconciliation/dismissals", { cache: "no-store" }),
      fetch("/api/reconciliation/user-dismissals", { cache: "no-store" }),
      fetch("/api/reconciliation/claims", { cache: "no-store" }),
      fetch("/api/reconciliation/transfer-claims", { cache: "no-store" }),
    ]);

    if (!processedHashesRes.ok) {
      const err = await processedHashesRes.json().catch(() => ({ error: processedHashesRes.statusText }));
      throw new Error(err.error || "Failed to load processed hashes.");
    }
    if (!dismissalsRes.ok) {
      const err = await dismissalsRes.json().catch(() => ({ error: dismissalsRes.statusText }));
      throw new Error(err.error || "Failed to load dismissals.");
    }
    if (!userDismissalsRes.ok) {
      const err = await userDismissalsRes.json().catch(() => ({ error: userDismissalsRes.statusText }));
      throw new Error(err.error || "Failed to load user dismissals.");
    }
    if (!claimsRes.ok) {
      const err = await claimsRes.json().catch(() => ({ error: claimsRes.statusText }));
      throw new Error(err.error || "Failed to load claimed sheet rows.");
    }
    if (!transferClaimsRes.ok) {
      const err = await transferClaimsRes.json().catch(() => ({ error: transferClaimsRes.statusText }));
      throw new Error(err.error || "Failed to load transfer claims.");
    }

    const processedHashesData = (await processedHashesRes.json()) as { hashes?: string[] };
    let processedList = [...(processedHashesData.hashes ?? [])];
    const dismissalsData = (await dismissalsRes.json()) as {
      dismissals?: Array<{ hash: string; accountName: string; note: string }>;
    };
    const dismissalMap: Record<string, string> = {};
    for (const d of dismissalsData.dismissals ?? []) {
      dismissalMap[`${d.accountName}|${d.hash}`] = d.note;
    }
    setDismissalNotesById(dismissalMap);
    const userDismissalsData = (await userDismissalsRes.json()) as {
      dismissedKeys?: string[];
      dismissals?: Array<{ sheetName: string; sheetRowId: string; note: string }>;
    };
    setUserDismissedRowKeys(
      new Set<string>((userDismissalsData.dismissedKeys ?? []).map((k) => String(k))),
    );
    const userNoteMap: Record<string, string> = {};
    for (const d of userDismissalsData.dismissals ?? []) {
      userNoteMap[claimKey(d.sheetName, d.sheetRowId)] = d.note;
    }
    setUserDismissalNotesByEntryId(userNoteMap);
    const claimsData = (await claimsRes.json()) as { claimedRowIds?: string[] };
    const claimedRows = new Set((claimsData.claimedRowIds ?? []).map((id) => String(id)));
    const transferClaimsData = (await transferClaimsRes.json()) as {
      statusByRowId?: TransferClaimStatusByRowId;
    };
    setSheetExpenses(sheetRows);
    setSheetTransfers(sheetTransfers);
    setClaimedRowKeys(claimedRows);
    setTransferClaimStatusByRowId(transferClaimsData.statusByRowId ?? {});

    const nextMatches: Record<string, MatchResult[]> = {};
    const autoApprovalErrors: string[] = [];

    for (const accountName of accounts) {
      const rows = statementCsvRowsByAccountRef.current[accountName];
      if (!rows?.length) continue;

      const res = await fetch("/api/reconciliation/match", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountName,
          rows,
          sheetExpenses: sheetRows,
          sheetTransfers,
          processedHashes: processedList,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || `Failed to match ${accountName} (${res.status})`);
      }
      const data = (await res.json()) as MatchResponse;
      nextMatches[accountName] = data.matches;

      const autoApprovable = data.matches.filter(
        (match) => match.matchType === "exact_match" && hasLinkedUserInputtedEntry(match),
      );
      const newAutoHashes: string[] = [];
      await Promise.all(
        autoApprovable.map(async (match) => {
          try {
            await persistProcessedHash(match.bankTransaction);
            newAutoHashes.push(match.bankTransaction.hash);
          } catch (err) {
            autoApprovalErrors.push(
              err instanceof Error
                ? err.message
                : `Failed to auto-approve ${match.bankTransaction.description || "transaction"}.`,
            );
          }
        }),
      );
      if (newAutoHashes.length > 0) {
        const merged = new Set(processedList);
        newAutoHashes.forEach((h) => merged.add(h));
        processedList = Array.from(merged);
      }
    }

    setProcessedHashes(new Set(processedList.map((h) => String(h))));
    setMatchesByAccount((prev) => mergeWellsFargoBucketIntoChecking({ ...prev, ...nextMatches }));
    if (autoApprovalErrors.length > 0) {
      setActionError(autoApprovalErrors[0]);
    }
  }, [persistProcessedHash]);

  const handleApprove = useCallback(
    async (match: MatchResult) => {
      const tx = match.bankTransaction;
      const id = idForTx(tx);
      const transferRowId = String(match.matchedSheetTransfer?.transferRowId ?? "").trim();
      if (
        match.matchedSheetTransfer &&
        transferRowId &&
        (match.matchType === "transfer" || match.matchType === "questionable_match_fuzzy")
      ) {
        openTransferClaimModal(match);
        return;
      }

      const expenseRowId = String(match.matchedSheetExpense?.rowId ?? "").trim();
      const bankAbs = Math.abs(tx.amount);
      const bankCents = toCents(bankAbs);

      if (match.matchedSheetExpense && expenseRowId) {
        const expCents = toCents(Math.abs(Number(match.matchedSheetExpense.amount ?? 0)));
        if (expCents !== bankCents) {
          setActionError("Sheet amount does not match this bank line; use Claim to pick a different row.");
          return;
        }
        setActionError("");
        setProcessingId(id);
        try {
          const res = await fetch("/api/reconciliation/claims", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              bankTransaction: {
                hash: tx.hash,
                accountName: tx.accountName,
                amount: tx.amount,
                date: tx.date,
                description: tx.description,
              },
              links: [
                {
                  sheetName: "Expenses",
                  sheetRowId: expenseRowId,
                  amount: bankAbs,
                },
              ],
            }),
          });
          if (!res.ok) {
            const err = await res.json().catch(() => ({ error: res.statusText }));
            throw new Error(err.error || `Failed to save sheet link (${res.status})`);
          }
          setProcessedHashes((prev) => new Set(prev).add(tx.hash));
          setClaimedRowKeys((prev) => {
            const next = new Set(prev);
            next.add(claimKey("Expenses", expenseRowId));
            return next;
          });
          setMatchesByAccount((prev) => {
            const next: Record<string, MatchResult[]> = {};
            for (const [account, rows] of Object.entries(prev)) {
              next[account] = rows.map((row) => {
                if (idForTx(row.bankTransaction) !== id) return row;
                const exp = sheetExpenses.find((e) => (e.rowId ?? "").trim() === expenseRowId);
                if (!exp) return row;
                return {
                  ...row,
                  matchType: "exact_match",
                  reason: "Linked sheet row and marked processed.",
                  matchedSheetExpense: {
                    amount: Math.abs(Number(exp.amount)),
                    timestamp: exp.timestamp ?? tx.date,
                    description: exp.description ?? "",
                    expenseType: exp.expenseType ?? "—",
                    account: exp.account ?? tx.accountName,
                    rowId: exp.rowId,
                    date: exp.date,
                  },
                  matchedSheetIndex: undefined,
                  matchedSheetTransfer: undefined,
                  matchedSheetTransferIndex: undefined,
                };
              });
            }
            return next;
          });
          setDisconnectedIds((prev) => {
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
        } catch (err) {
          setActionError(err instanceof Error ? err.message : "Failed to approve and link.");
        } finally {
          setProcessingId(null);
        }
        return;
      }

      if (match.matchedSheetTransfer && transferRowId && match.matchType === "exact_match") {
        setActionError("");
        setProcessingId(id);
        try {
          const res = await fetch("/api/reconciliation/claims", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              bankTransaction: {
                hash: tx.hash,
                accountName: tx.accountName,
                amount: tx.amount,
                date: tx.date,
                description: tx.description,
              },
              links: [
                {
                  sheetName: "Transfers",
                  sheetRowId: transferRowId,
                  amount: bankAbs,
                },
              ],
            }),
          });
          if (!res.ok) {
            const err = await res.json().catch(() => ({ error: res.statusText }));
            throw new Error(err.error || `Failed to save transfer link (${res.status})`);
          }
          const tRes = await fetch("/api/reconciliation/transfer-claims", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              transferRowId,
              expectedLegs: 2,
              bankTransaction: {
                hash: tx.hash,
                accountName: tx.accountName,
                amount: tx.amount,
              },
            }),
          });
          if (!tRes.ok) {
            const err = await tRes.json().catch(() => ({ error: res.statusText }));
            throw new Error(err.error || `Saved link but transfer tracking failed (${tRes.status}).`);
          }
          const tClaimsGet = await fetch("/api/reconciliation/transfer-claims", { cache: "no-store" });
          if (tClaimsGet.ok) {
            const transferClaimsData = (await tClaimsGet.json()) as {
              statusByRowId?: TransferClaimStatusByRowId;
            };
            setTransferClaimStatusByRowId(transferClaimsData.statusByRowId ?? {});
          }
          setProcessedHashes((prev) => new Set(prev).add(tx.hash));
          setClaimedRowKeys((prev) => {
            const next = new Set(prev);
            next.add(claimKey("Transfers", transferRowId));
            return next;
          });
          setMatchesByAccount((prev) => {
            const next: Record<string, MatchResult[]> = {};
            for (const [account, rows] of Object.entries(prev)) {
              next[account] = rows.map((row) => {
                if (idForTx(row.bankTransaction) !== id) return row;
                const tr = sheetTransfers.find((t) => (t.transferRowId ?? "").trim() === transferRowId);
                if (!tr) return row;
                const amountSignedForTransfer =
                  tx.amount < 0 ? -Math.abs(Number(tr.amount ?? 0)) : Math.abs(Number(tr.amount ?? 0));
                return {
                  ...row,
                  matchType: "exact_match",
                  reason: "Linked transfer row and marked processed.",
                  matchedSheetTransfer: {
                    amount: amountSignedForTransfer,
                    transferRowId,
                    transferFrom: tr.transferFrom,
                    transferTo: tr.transferTo,
                    timestamp: tr.timestamp,
                    date: tr.date,
                  },
                  matchedSheetTransferIndex: undefined,
                  matchedSheetExpense: undefined,
                  matchedSheetIndex: undefined,
                };
              });
            }
            return next;
          });
          setDisconnectedIds((prev) => {
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
        } catch (err) {
          setActionError(err instanceof Error ? err.message : "Failed to approve transfer.");
        } finally {
          setProcessingId(null);
        }
        return;
      }

      setActionError("");
      setProcessingId(id);
      try {
        await persistProcessedHash(tx);
        setProcessedHashes((prev) => new Set(prev).add(tx.hash));
        setDisconnectedIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      } catch (err) {
        setActionError(err instanceof Error ? err.message : "Failed to approve transaction.");
      } finally {
        setProcessingId(null);
      }
    },
    [openTransferClaimModal, persistProcessedHash, sheetExpenses, sheetTransfers],
  );

  const handleDisconnectSheetLink = useCallback(
    async (match: MatchResult) => {
      if (typeof window !== "undefined") {
        const ok = window.confirm(
          "Remove the Neon link between this bank line and the sheet row, unmark it processed, and put it back in review? You can link again with Claim or the checkmark.",
        );
        if (!ok) return;
      }
      const tx = match.bankTransaction;
      const bid = idForTx(tx);
      setActionError("");
      setProcessingId(bid);
      try {
        const bankBody = JSON.stringify({
          bankTransaction: { hash: tx.hash, accountName: tx.accountName },
        });
        const procBody = JSON.stringify({ hash: tx.hash, accountName: tx.accountName });
        const [claimsDel, transferDel, procDel] = await Promise.all([
          fetch("/api/reconciliation/claims", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: bankBody,
          }),
          fetch("/api/reconciliation/transfer-claims", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: bankBody,
          }),
          fetch("/api/reconciliation/processed", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: procBody,
          }),
        ]);
        if (!procDel.ok) {
          const err = await procDel.json().catch(() => ({ error: procDel.statusText }));
          throw new Error(err.error || `Could not unmark processed (${procDel.status})`);
        }
        if (!claimsDel.ok) {
          const err = await claimsDel.json().catch(() => ({ error: claimsDel.statusText }));
          throw new Error(err.error || `Could not remove claim (${claimsDel.status})`);
        }
        if (!transferDel.ok) {
          const err = await transferDel.json().catch(() => ({ error: transferDel.statusText }));
          throw new Error(err.error || `Could not remove transfer claim (${transferDel.status})`);
        }

        setProcessedHashes((prev) => {
          const next = new Set(prev);
          next.delete(tx.hash);
          return next;
        });

        const claimsGet = await fetch("/api/reconciliation/claims", { cache: "no-store" });
        if (claimsGet.ok) {
          const data = (await claimsGet.json()) as { claimedRowIds?: string[] };
          setClaimedRowKeys(new Set((data.claimedRowIds ?? []).map((x) => String(x))));
        }

        const tGet = await fetch("/api/reconciliation/transfer-claims", { cache: "no-store" });
        if (tGet.ok) {
          const data = (await tGet.json()) as { statusByRowId?: TransferClaimStatusByRowId };
          setTransferClaimStatusByRowId(data.statusByRowId ?? {});
        }

        const hadStoredCsv = Object.keys(statementCsvRowsByAccountRef.current).length > 0;
        const patchDisconnectedRow = () => {
          setMatchesByAccount((prev) => {
            const next: Record<string, MatchResult[]> = {};
            for (const [acct, rows] of Object.entries(prev)) {
              next[acct] = rows.map((row) => {
                if (idForTx(row.bankTransaction) !== bid) return row;
                return {
                  ...row,
                  matchType: "unmatched",
                  reason: "Disconnected from sheet link.",
                  matchedSheetExpense: undefined,
                  matchedSheetTransfer: undefined,
                  matchedSheetIndex: undefined,
                  matchedSheetTransferIndex: undefined,
                };
              });
            }
            return mergeWellsFargoBucketIntoChecking(next);
          });
        };
        try {
          if (hadStoredCsv) {
            await rematchAllStoredAccounts();
          } else {
            patchDisconnectedRow();
          }
        } catch (rematchErr) {
          setActionError(
            rematchErr instanceof Error ? rematchErr.message : "Rematch failed after disconnect.",
          );
          patchDisconnectedRow();
        }
      } catch (err) {
        setActionError(err instanceof Error ? err.message : "Failed to disconnect link.");
      } finally {
        setProcessingId(null);
      }
    },
    [rematchAllStoredAccounts],
  );

  const openDismissModal = useCallback((match: MatchResult) => {
    setDismissModal({
      open: true,
      match,
      note: "",
      submitting: false,
      error: "",
    });
  }, []);

  const closeDismissModal = useCallback(() => {
    setDismissModal({ open: false, match: null, note: "", submitting: false, error: "" });
  }, []);

  const handleDismissSubmit = useCallback(async () => {
    const match = dismissModal.match;
    if (!match) return;
    const tx = match.bankTransaction;
    const id = idForTx(tx);
    const note = dismissModal.note.trim();
    if (!note) {
      setDismissModal((prev) => ({ ...prev, error: "Enter a note." }));
      return;
    }
    setDismissModal((prev) => ({ ...prev, submitting: true, error: "" }));
    try {
      const res = await fetch("/api/reconciliation/dismissals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hash: tx.hash, accountName: tx.accountName, note }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || `Failed to save dismissal (${res.status})`);
      }
      setProcessedHashes((prev) => new Set(prev).add(tx.hash));
      setDismissalNotesById((prev) => ({ ...prev, [id]: note }));
      setDisconnectedIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      setDismissModal({ open: false, match: null, note: "", submitting: false, error: "" });
    } catch (err) {
      setDismissModal((prev) => ({
        ...prev,
        submitting: false,
        error: err instanceof Error ? err.message : "Failed to dismiss.",
      }));
    }
  }, [dismissModal.match, dismissModal.note]);

  const openUserDismissModal = useCallback((entry: UserInputtedEntry) => {
    setUserDismissModal({
      open: true,
      entry,
      note: "",
      submitting: false,
      error: "",
    });
  }, []);

  const closeUserDismissModal = useCallback(() => {
    setUserDismissModal({ open: false, entry: null, note: "", submitting: false, error: "" });
  }, []);

  const handleUserDismissSubmit = useCallback(async () => {
    const entry = userDismissModal.entry;
    if (!entry) return;
    const parsed = parseSheetDismissKeyFromEntryId(entry.id);
    if (!parsed) {
      setUserDismissModal((prev) => ({ ...prev, error: "This row cannot be dismissed (missing row id)." }));
      return;
    }
    const note = userDismissModal.note.trim();
    if (!note) {
      setUserDismissModal((prev) => ({ ...prev, error: "Enter a note." }));
      return;
    }
    setUserDismissModal((prev) => ({ ...prev, submitting: true, error: "" }));
    try {
      const res = await fetch("/api/reconciliation/user-dismissals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sheetName: parsed.sheetName,
          sheetRowId: parsed.sheetRowId,
          note,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || `Failed to save dismissal (${res.status})`);
      }
      setUserDismissedRowKeys((prev) => new Set(prev).add(entry.id));
      setUserDismissalNotesByEntryId((prev) => ({ ...prev, [entry.id]: note }));
      setUserDismissModal({ open: false, entry: null, note: "", submitting: false, error: "" });
    } catch (err) {
      setUserDismissModal((prev) => ({
        ...prev,
        submitting: false,
        error: err instanceof Error ? err.message : "Failed to dismiss.",
      }));
    }
  }, [userDismissModal.entry, userDismissModal.note]);

  const openResetReconcileModal = useCallback(() => {
    setResetReconcileModal({ open: true, confirmText: "", submitting: false, error: "" });
  }, []);

  const closeResetReconcileModal = useCallback(() => {
    setResetReconcileModal({ open: false, confirmText: "", submitting: false, error: "" });
  }, []);

  const handleFullReconcileReset = useCallback(async () => {
    if (resetReconcileModal.confirmText.trim() !== RECONCILIATION_RESET_CONFIRM) {
      setResetReconcileModal((prev) => ({
        ...prev,
        error: `Type ${RECONCILIATION_RESET_CONFIRM} exactly to confirm.`,
      }));
      return;
    }
    setResetReconcileModal((prev) => ({ ...prev, submitting: true, error: "" }));
    try {
      const res = await fetch("/api/reconciliation/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: RECONCILIATION_RESET_CONFIRM }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || `Reset failed (${res.status})`);
      }
      if (typeof window !== "undefined") {
        window.localStorage.removeItem(RECONCILE_STORAGE_KEY);
      }
      setMatchesByAccount({});
      statementCsvRowsByAccountRef.current = {};
      setProcessedHashes(new Set());
      setDismissalNotesById({});
      setUserDismissedRowKeys(new Set());
      setUserDismissalNotesByEntryId({});
      setDisconnectedIds(new Set());
      setClaimedRowKeys(new Set());
      setTransferClaimStatusByRowId({});
      setUploadedFilesByAccount({});
      setActionError("");
      setUploadError("");
      setResetReconcileModal({ open: false, confirmText: "", submitting: false, error: "" });
    } catch (err) {
      setResetReconcileModal((prev) => ({
        ...prev,
        submitting: false,
        error: err instanceof Error ? err.message : "Reset failed.",
      }));
    }
  }, [resetReconcileModal.confirmText]);

  const handleQuickAddSubmit = useCallback(async () => {
    if (!quickAdd.rowId) return;
    const selected = allMatches.find((m) => idForTx(m.bankTransaction) === quickAdd.rowId);
    if (!selected) {
      setQuickAdd((prev) => ({ ...prev, error: "Transaction no longer available." }));
      return;
    }

    const amountNum = Number(quickAdd.amount);
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      setQuickAdd((prev) => ({ ...prev, error: "Enter a valid amount." }));
      return;
    }
    if (!quickAdd.description.trim()) {
      setQuickAdd((prev) => ({ ...prev, error: "Description is required." }));
      return;
    }

    setQuickAdd((prev) => ({ ...prev, submitting: true, error: "" }));
    try {
      await submitExpense({
        expenseType: quickAdd.expenseType,
        amount: amountNum,
        description: quickAdd.description.trim(),
      });
      await persistProcessedHash(selected.bankTransaction);
      setProcessedHashes((prev) => new Set(prev).add(selected.bankTransaction.hash));
      setDisconnectedIds((prev) => {
        const next = new Set(prev);
        next.delete(quickAdd.rowId as string);
        return next;
      });
      closeQuickAdd();
    } catch (err) {
      setQuickAdd((prev) => ({
        ...prev,
        submitting: false,
        error: err instanceof Error ? err.message : "Failed to quick add.",
      }));
    }
  }, [allMatches, closeQuickAdd, persistProcessedHash, quickAdd]);

  const splitTargetAmount = useMemo(() => {
    if (!splitModal.rowId) return 0;
    const selected = allMatches.find((m) => idForTx(m.bankTransaction) === splitModal.rowId);
    if (!selected) return 0;
    return Math.abs(selected.bankTransaction.amount);
  }, [allMatches, splitModal.rowId]);

  const splitTargetTransaction = useMemo(() => {
    if (!splitModal.rowId) return null;
    const selected = allMatches.find((m) => idForTx(m.bankTransaction) === splitModal.rowId);
    return selected?.bankTransaction ?? null;
  }, [allMatches, splitModal.rowId]);

  const sortedSplitCandidates = useMemo(
    () => sortByNewestDate(splitModal.candidates, (row) => row.timestamp),
    [splitModal.candidates],
  );

  const filteredSplitCandidates = useMemo(() => {
    const q = normalizeText(splitSearchQuery);
    if (!q) return sortedSplitCandidates;
    return sortedSplitCandidates.filter((row) =>
      [
        row.sheetName,
        row.expenseType,
        row.description,
        row.account,
        row.rowId,
        row.timestamp,
      ].some((value) => normalizeText(value).includes(q)),
    );
  }, [sortedSplitCandidates, splitSearchQuery]);

  const selectedClaimRows = useMemo(
    () => splitModal.candidates.filter((row) => splitModal.selectedKeys.includes(row.key)),
    [splitModal.candidates, splitModal.selectedKeys],
  );

  const splitSelectionIncludesTransfer = useMemo(
    () => selectedClaimRows.some((row) => row.sheetName === "Transfers"),
    [selectedClaimRows],
  );

  const splitEnteredAmount = useMemo(
    () => selectedClaimRows.reduce((sum, row) => sum + row.amount, 0),
    [selectedClaimRows],
  );

  const splitRemainingAmount = useMemo(
    () => splitTargetAmount - splitEnteredAmount,
    [splitEnteredAmount, splitTargetAmount],
  );

  const handleToggleSplitClaim = useCallback((key: string) => {
    setSplitModal((prev) => {
      const selected = new Set(prev.selectedKeys);
      if (selected.has(key)) selected.delete(key);
      else selected.add(key);
      return {
        ...prev,
        error: "",
        selectedKeys: Array.from(selected),
      };
    });
  }, []);

  const handleSplitSubmit = useCallback(async () => {
    if (!splitModal.rowId) return;
    const selected = allMatches.find((m) => idForTx(m.bankTransaction) === splitModal.rowId);
    if (!selected) {
      setSplitModal((prev) => ({ ...prev, error: "Transaction no longer available." }));
      return;
    }

    const selectedRows = splitModal.candidates.filter((row) => splitModal.selectedKeys.includes(row.key));
    if (selectedRows.length === 0) {
      setSplitModal((prev) => ({ ...prev, error: "Select at least one existing sheet row." }));
      return;
    }

    const transferSelected = selectedRows.filter((row) => row.sheetName === "Transfers");
    const expenseSelected = selectedRows.filter((row) => row.sheetName === "Expenses");
    if (transferSelected.length > 0 && expenseSelected.length > 0) {
      setSplitModal((prev) => ({
        ...prev,
        error:
          "Claim transfer rows separately from expense rows (one claim for transfers only, another for expenses).",
      }));
      return;
    }
    if (transferSelected.length > 1) {
      setSplitModal((prev) => ({
        ...prev,
        error: "Select only one transfer sheet row per claim.",
      }));
      return;
    }

    const targetCents = toCents(Math.abs(selected.bankTransaction.amount));
    const enteredCents = selectedRows.reduce((sum, row) => sum + toCents(row.amount), 0);
    if (enteredCents !== targetCents) {
      setSplitModal((prev) => ({
        ...prev,
        error: `Selected rows must total ${fmtMoney(Math.abs(selected.bankTransaction.amount))}.`,
      }));
      return;
    }

    setSplitModal((prev) => ({ ...prev, submitting: true, error: "" }));
    try {
      const res = await fetch("/api/reconciliation/claims", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bankTransaction: {
            hash: selected.bankTransaction.hash,
            accountName: selected.bankTransaction.accountName,
            amount: selected.bankTransaction.amount,
            date: selected.bankTransaction.date,
            description: selected.bankTransaction.description,
          },
          links: selectedRows.map((row) => ({
            sheetName: row.sheetName,
            sheetRowId: row.rowId,
            amount: row.amount,
          })),
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || `Failed to claim existing rows (${res.status})`);
      }

      if (transferSelected.length === 1) {
        const tr = transferSelected[0];
        const tRes = await fetch("/api/reconciliation/transfer-claims", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            transferRowId: tr.rowId,
            expectedLegs: splitModal.transferExpectedLegs,
            bankTransaction: {
              hash: selected.bankTransaction.hash,
              accountName: selected.bankTransaction.accountName,
              amount: selected.bankTransaction.amount,
            },
          }),
        });
        if (!tRes.ok) {
          const err = await tRes.json().catch(() => ({ error: tRes.statusText }));
          throw new Error(
            err.error ||
              `Saved sheet link but transfer leg tracking failed (${tRes.status}). Try again or use disconnect.`,
          );
        }
        const tClaimsGet = await fetch("/api/reconciliation/transfer-claims", { cache: "no-store" });
        if (tClaimsGet.ok) {
          const transferClaimsData = (await tClaimsGet.json()) as {
            statusByRowId?: TransferClaimStatusByRowId;
          };
          setTransferClaimStatusByRowId(transferClaimsData.statusByRowId ?? {});
        }
      }

      setClaimedRowKeys((prev) => {
        const next = new Set(prev);
        selectedRows.forEach((row) => next.add(row.key));
        return next;
      });
      setProcessedHashes((prev) => new Set(prev).add(selected.bankTransaction.hash));
      const totalClaimedAmount = selectedRows.reduce((sum, row) => sum + row.amount, 0);
      const claimedDescription =
        selectedRows.length === 1
          ? selectedRows[0].description || selected.bankTransaction.description
          : `Split claim (${selectedRows.length} rows): ${selectedRows
              .map((row) => row.description)
              .filter((value) => Boolean(value && value.trim()))
              .slice(0, 2)
              .join(" + ") || selected.bankTransaction.description}`;
      const linkedExpense = {
        amount: totalClaimedAmount,
        timestamp:
          selectedRows.length === 1
            ? selectedRows[0].timestamp ?? selected.bankTransaction.date
            : selected.bankTransaction.date,
        description: claimedDescription,
        expenseType: selectedRows.length === 1 ? selectedRows[0].expenseType : "Split Claim",
        account:
          selectedRows.length === 1
            ? selectedRows[0].account ?? selected.bankTransaction.accountName
            : selected.bankTransaction.accountName,
        rowId:
          selectedRows.length === 1
            ? selectedRows[0].rowId
            : selectedRows.map((row) => row.rowId).join(", "),
      };

      const singleTransfer = transferSelected.length === 1 ? transferSelected[0] : null;
      const amountSignedForTransfer = singleTransfer
        ? selected.bankTransaction.amount < 0
          ? -Math.abs(singleTransfer.amount)
          : Math.abs(singleTransfer.amount)
        : 0;

      setMatchesByAccount((prev) => {
        const next: Record<string, MatchResult[]> = {};
        for (const [account, rows] of Object.entries(prev)) {
          next[account] = rows.map((row) => {
            if (idForTx(row.bankTransaction) !== splitModal.rowId) return row;
            if (singleTransfer) {
              return {
                ...row,
                matchType: "exact_match",
                reason: "Claimed transfer sheet row and marked processed.",
                matchedSheetTransfer: {
                  amount: amountSignedForTransfer,
                  transferRowId: singleTransfer.rowId,
                  transferFrom: singleTransfer.transferFrom,
                  transferTo: singleTransfer.transferTo,
                  timestamp: singleTransfer.timestamp,
                  date: singleTransfer.date,
                },
                matchedSheetTransferIndex: undefined,
                matchedSheetExpense: undefined,
                matchedSheetIndex: undefined,
              };
            }
            return {
              ...row,
              reason:
                selectedRows.length === 1
                  ? "Claimed existing sheet row and marked processed."
                  : `Claimed ${selectedRows.length} existing sheet rows and marked processed.`,
              matchedSheetExpense: linkedExpense,
              matchedSheetIndex: undefined,
              matchedSheetTransfer: undefined,
              matchedSheetTransferIndex: undefined,
            };
          });
        }
        return next;
      });
      setDisconnectedIds((prev) => {
        const next = new Set(prev);
        next.delete(splitModal.rowId as string);
        return next;
      });
      closeSplitModal();
    } catch (err) {
      setSplitModal((prev) => ({
        ...prev,
        submitting: false,
        error: err instanceof Error ? err.message : "Failed to claim selected rows.",
      }));
    }
  }, [allMatches, closeSplitModal, splitModal.rowId, splitModal.transferExpectedLegs, splitModal.selectedKeys, splitModal.candidates]);

  const handleTransferClaimSubmit = useCallback(async () => {
    if (!transferClaimModal.rowId) return;
    const selected = allMatches.find((m) => idForTx(m.bankTransaction) === transferClaimModal.rowId);
    if (!selected) {
      setTransferClaimModal((prev) => ({ ...prev, error: "Transaction no longer available." }));
      return;
    }
    const transferRowId = String(selected.matchedSheetTransfer?.transferRowId ?? "").trim();
    if (!transferRowId) {
      setTransferClaimModal((prev) => ({
        ...prev,
        error: "Matched transfer row is missing Transfer Row ID.",
      }));
      return;
    }

    setTransferClaimModal((prev) => ({ ...prev, submitting: true, error: "" }));
    try {
      const res = await fetch("/api/reconciliation/transfer-claims", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transferRowId,
          expectedLegs: transferClaimModal.expectedLegs,
          bankTransaction: {
            hash: selected.bankTransaction.hash,
            accountName: selected.bankTransaction.accountName,
            amount: selected.bankTransaction.amount,
          },
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || `Failed to claim transfer leg (${res.status})`);
      }
      const payload = (await res.json()) as {
        expectedLegs?: number;
        claimedCount?: number;
        isComplete?: boolean;
      };
      const refreshedTransferClaimsRes = await fetch("/api/reconciliation/transfer-claims", {
        cache: "no-store",
      });
      if (refreshedTransferClaimsRes.ok) {
        const transferClaimsData = (await refreshedTransferClaimsRes.json()) as {
          statusByRowId?: TransferClaimStatusByRowId;
        };
        setTransferClaimStatusByRowId(transferClaimsData.statusByRowId ?? {});
      } else {
        // Fallback to optimistic local patch when refresh endpoint is unavailable.
        setTransferClaimStatusByRowId((prev) => ({
          ...prev,
          [transferRowId]: {
            expectedLegs: payload.expectedLegs === 1 ? 1 : 2,
            claimedCount: Number(payload.claimedCount ?? 1),
            isComplete: Boolean(payload.isComplete),
          },
        }));
      }
      try {
        await rematchAllStoredAccounts();
      } catch (rematchErr) {
        setActionError(
          rematchErr instanceof Error ? rematchErr.message : "Rematch after transfer claim failed.",
        );
        setProcessedHashes((prev) => new Set(prev).add(selected.bankTransaction.hash));
      }
      setDisconnectedIds((prev) => {
        const next = new Set(prev);
        next.delete(transferClaimModal.rowId as string);
        return next;
      });
      closeTransferClaimModal();
    } catch (err) {
      setTransferClaimModal((prev) => ({
        ...prev,
        submitting: false,
        error: err instanceof Error ? err.message : "Failed to claim transfer.",
      }));
    }
  }, [allMatches, closeTransferClaimModal, rematchAllStoredAccounts, transferClaimModal]);

  const onDrop = useCallback(
    async (files: File[]) => {
      const file = files[0];
      if (!file) return;
      setUploadError("");
      setActionError("");
      setIsUploading(true);

      try {
        const parsedRows = await parseCsvFile(file);
        if (parsedRows.length === 0) {
          throw new Error("CSV file has no data rows.");
        }

        const mergedCsv = mergeCsvRowArrays(
          statementCsvRowsByAccountRef.current[selectedAccount],
          parsedRows,
        );
        statementCsvRowsByAccountRef.current = {
          ...statementCsvRowsByAccountRef.current,
          [selectedAccount]: mergedCsv,
        };

        const [
          sheetRows,
          sheetTransfers,
          processedHashesRes,
          dismissalsRes,
          userDismissalsRes,
          claimsRes,
          transferClaimsRes,
        ] = await Promise.all([
          getExpenses(),
          getTransfers(),
          fetch("/api/reconciliation/processed", { cache: "no-store" }),
          fetch("/api/reconciliation/dismissals", { cache: "no-store" }),
          fetch("/api/reconciliation/user-dismissals", { cache: "no-store" }),
          fetch("/api/reconciliation/claims", { cache: "no-store" }),
          fetch("/api/reconciliation/transfer-claims", { cache: "no-store" }),
        ]);
        if (!processedHashesRes.ok) {
          const err = await processedHashesRes.json().catch(() => ({ error: processedHashesRes.statusText }));
          throw new Error(err.error || "Failed to load processed hashes.");
        }
        if (!dismissalsRes.ok) {
          const err = await dismissalsRes.json().catch(() => ({ error: dismissalsRes.statusText }));
          throw new Error(err.error || "Failed to load dismissals.");
        }
        if (!userDismissalsRes.ok) {
          const err = await userDismissalsRes.json().catch(() => ({ error: userDismissalsRes.statusText }));
          throw new Error(err.error || "Failed to load user dismissals.");
        }
        if (!claimsRes.ok) {
          const err = await claimsRes.json().catch(() => ({ error: claimsRes.statusText }));
          throw new Error(err.error || "Failed to load claimed sheet rows.");
        }
        if (!transferClaimsRes.ok) {
          const err = await transferClaimsRes.json().catch(() => ({ error: transferClaimsRes.statusText }));
          throw new Error(err.error || "Failed to load transfer claims.");
        }
        const processedHashesData = (await processedHashesRes.json()) as { hashes?: string[] };
        const processedHashes = processedHashesData.hashes ?? [];
        const dismissalsData = (await dismissalsRes.json()) as {
          dismissals?: Array<{ hash: string; accountName: string; note: string }>;
        };
        const dismissalMap: Record<string, string> = {};
        for (const d of dismissalsData.dismissals ?? []) {
          dismissalMap[`${d.accountName}|${d.hash}`] = d.note;
        }
        setDismissalNotesById(dismissalMap);
        const userDismissalsData = (await userDismissalsRes.json()) as {
          dismissedKeys?: string[];
          dismissals?: Array<{ sheetName: string; sheetRowId: string; note: string }>;
        };
        setUserDismissedRowKeys(
          new Set<string>((userDismissalsData.dismissedKeys ?? []).map((k) => String(k))),
        );
        const userNoteMap: Record<string, string> = {};
        for (const d of userDismissalsData.dismissals ?? []) {
          userNoteMap[claimKey(d.sheetName, d.sheetRowId)] = d.note;
        }
        setUserDismissalNotesByEntryId(userNoteMap);
        const claimsData = (await claimsRes.json()) as { claimedRowIds?: string[] };
        const claimedRows = new Set((claimsData.claimedRowIds ?? []).map((id) => String(id)));
        const transferClaimsData = (await transferClaimsRes.json()) as {
          statusByRowId?: TransferClaimStatusByRowId;
        };
        setSheetExpenses(sheetRows);
        setSheetTransfers(sheetTransfers);
        setClaimedRowKeys(claimedRows);
        setTransferClaimStatusByRowId(transferClaimsData.statusByRowId ?? {});

        const res = await fetch("/api/reconciliation/match", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            accountName: selectedAccount,
            rows: mergedCsv,
            sheetExpenses: sheetRows,
            sheetTransfers,
            processedHashes,
          }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: res.statusText }));
          throw new Error(err.error || `Failed to match CSV (${res.status})`);
        }
        const data = (await res.json()) as MatchResponse;
        const autoApprovable = data.matches.filter(
          (match) => match.matchType === "exact_match" && hasLinkedUserInputtedEntry(match),
        );
        const autoApprovedHashes: string[] = [];
        const autoApprovalErrors: string[] = [];
        await Promise.all(
          autoApprovable.map(async (match) => {
            try {
              await persistProcessedHash(match.bankTransaction);
              autoApprovedHashes.push(match.bankTransaction.hash);
            } catch (err) {
              autoApprovalErrors.push(
                err instanceof Error
                  ? err.message
                  : `Failed to auto-approve ${match.bankTransaction.description || "transaction"}.`,
              );
            }
          }),
        );

        setMatchesByAccount((prev) =>
          mergeWellsFargoBucketIntoChecking({
            ...prev,
            [selectedAccount]: data.matches,
          }),
        );
        if (autoApprovedHashes.length > 0) {
          setProcessedHashes((prev) => {
            const next = new Set(prev);
            autoApprovedHashes.forEach((hash) => next.add(hash));
            return next;
          });
        }
        if (autoApprovalErrors.length > 0) {
          setActionError(autoApprovalErrors[0]);
        }
        const uploadedFileName = file.name.trim();
        if (uploadedFileName) {
          await fetch("/api/reconciliation/uploaded-files", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              accountName: selectedAccount,
              fileName: uploadedFileName,
            }),
          });
          setUploadedFilesByAccount((prev) => {
            const existing = prev[selectedAccount] ?? [];
            if (existing.includes(uploadedFileName)) return prev;
            return {
              ...prev,
              [selectedAccount]: [...existing, uploadedFileName],
            };
          });
        }
        setActiveTab(selectedAccount);
      } catch (err) {
        setUploadError(err instanceof Error ? err.message : "Upload failed.");
      } finally {
        setIsUploading(false);
      }
    },
    [persistProcessedHash, selectedAccount],
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    multiple: false,
    accept: { "text/csv": [".csv"] },
  });

  const activeReviewRows = (statementReviewRowsByAccount[activeTab] ?? []).filter(
    (row) => row.bankTransaction.accountName === activeTab,
  );
  const activeAutoMatchedRows = (statementAutoMatchedRowsByAccount[activeTab] ?? []).filter(
    (row) => row.bankTransaction.accountName === activeTab,
  );
  const activeCompletedRows = (statementCompletedRowsByAccount[activeTab] ?? []).filter(
    (row) => row.bankTransaction.accountName === activeTab,
  );
  const activeMatchedRowsAll = sortByNewestDate(
    [...activeAutoMatchedRows, ...activeCompletedRows],
    (row) => row.bankTransaction.date,
  );
  const activeUserLinkedMatchedRows = activeMatchedRowsAll.filter((m) => hasLinkedUserInputtedEntry(m));
  const activeStatementClosedOnlyRows = activeMatchedRowsAll.filter((m) => !hasLinkedUserInputtedEntry(m));
  const selectedAccountUploadedFiles = uploadedFilesByAccount[selectedAccount] ?? [];

  return (
    <DashboardLayout>
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h1 className="text-2xl font-semibold text-white">Reconcile</h1>
          <div className="flex items-center gap-2 flex-wrap justify-end">
            <button
              type="button"
              onClick={openResetReconcileModal}
              className="px-3 py-1.5 rounded-lg border border-red-500/40 text-red-300 text-sm hover:text-red-200 hover:bg-red-500/10 transition-colors"
            >
              Clear reconciliation data
            </button>
            <button
              type="button"
              onClick={openAnchorModal}
              className="px-3 py-1.5 rounded-lg bg-[#252525] border border-charcoal-dark text-gray-200 text-sm hover:text-white hover:bg-[#2d2d2d] transition-colors"
            >
              Set Statement Ending Balance
            </button>
            <label className="text-sm text-gray-300">Account</label>
            <select
              value={viewMode === "home" ? ALL_ACCOUNTS_OPTION : selectedAccount}
              onChange={(e) => {
                const nextValue = e.target.value;
                if (nextValue === ALL_ACCOUNTS_OPTION) {
                  setViewMode("home");
                  return;
                }
                const account = nextValue as AccountOption;
                setSelectedAccount(account);
                setActiveTab(account);
                setViewMode("accountDetail");
              }}
              className="px-3 py-1.5 rounded-lg bg-charcoal border border-charcoal-dark text-gray-200 text-sm focus:border-accent focus:ring-1 focus:ring-accent outline-none"
            >
              <option value={ALL_ACCOUNTS_OPTION}>{ALL_ACCOUNTS_OPTION}</option>
              {ACCOUNT_OPTIONS.map((account) => (
                <option key={account} value={account}>
                  {account}
                </option>
              ))}
            </select>
          </div>
        </div>

        {viewMode === "accountDetail" && (
          <div className="grid gap-4 lg:grid-cols-2">
            <div
              {...getRootProps()}
              className={`rounded-xl border border-dashed p-6 text-center cursor-pointer transition-colors ${
                isDragActive
                  ? "border-accent bg-accent/10"
                  : "border-charcoal-dark bg-[#252525] hover:border-accent/70 hover:bg-[#2a2a2a]"
              }`}
            >
              <input {...getInputProps()} />
              <Upload className="mx-auto mb-2 text-gray-400" />
              <p className="text-gray-200 text-sm">
                {isDragActive ? "Drop the CSV here..." : "Drop a CSV here, or click to upload"}
              </p>
              <p className="text-xs text-gray-500 mt-1">
                Account profile: <span className="text-gray-300">{selectedAccount}</span>
              </p>
              {!accountHasConfiguredParser(selectedAccount) && (
                <p className="text-xs text-yellow-300/90 mt-1">
                  CSV parser not configured yet for this account. Upload may return no transactions.
                </p>
              )}
              {isUploading && (
                <div className="mt-2 inline-flex items-center gap-2 text-sm text-gray-300">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Processing...
                </div>
              )}
            </div>
            <section className="rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden">
              <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark">
                <h2 className="text-white font-semibold">Files</h2>
              </div>
              <div className="p-3 text-sm">
                {selectedAccountUploadedFiles.length === 0 ? (
                  <p className="text-gray-400">No files uploaded for this account yet.</p>
                ) : (
                  <div className="space-y-2">
                    {selectedAccountUploadedFiles.map((fileName) => (
                      <div
                        key={fileName}
                        className="rounded-lg border border-charcoal-dark bg-[#2c2c2c] px-3 py-2 text-gray-200 truncate"
                        title={fileName}
                      >
                        {fileName}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>
          </div>
        )}

        {(uploadError || actionError) && (
          <div className="rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 px-4 py-2 text-sm">
            {uploadError || actionError}
          </div>
        )}

        {viewMode === "home" ? (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <div className="space-y-4 min-w-0">
            <section className="rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden min-w-0">
              <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark flex flex-col gap-3">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="text-white font-semibold">User-inputted: Unmatched / Questionable</h2>
                  <span className="text-xs text-gray-300">{homeFilteredIncompleteRows.length}</span>
                </div>
                <div className="flex flex-col sm:flex-row flex-wrap gap-3 sm:items-end">
                  <div className="flex flex-1 min-w-[200px] items-center gap-2">
                    <Search className="w-4 h-4 text-gray-500 shrink-0" aria-hidden />
                    <label htmlFor="home-reconcile-search" className="sr-only">
                      Search transactions
                    </label>
                    <input
                      id="home-reconcile-search"
                      type="search"
                      value={homeSearchQuery}
                      onChange={(e) => setHomeSearchQuery(e.target.value)}
                      placeholder="Search incomplete & matched lists (user text, bank description, account…)"
                      className="w-full px-3 py-1.5 rounded-lg bg-charcoal border border-charcoal-dark text-gray-200 text-sm focus:border-accent focus:ring-1 focus:ring-accent outline-none"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <Filter className="w-4 h-4 text-gray-500 shrink-0" aria-hidden />
                    <label htmlFor="home-account-filter" className="text-xs text-gray-400 whitespace-nowrap">
                      Account
                    </label>
                    <select
                      id="home-account-filter"
                      value={homeAccountFilter}
                      onChange={(e) =>
                        setHomeAccountFilter(e.target.value as AccountOption | typeof ALL_ACCOUNTS_OPTION)
                      }
                      className="px-3 py-1.5 rounded-lg bg-charcoal border border-charcoal-dark text-gray-200 text-sm focus:border-accent focus:ring-1 focus:ring-accent outline-none min-w-[10rem]"
                    >
                      <option value={ALL_ACCOUNTS_OPTION}>{ALL_ACCOUNTS_OPTION}</option>
                      {ACCOUNT_OPTIONS.map((account) => (
                        <option key={account} value={account}>
                          {account}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>
              <div className="p-3 text-sm">
                {userInputtedReviewRows.length === 0 ? (
                  <p className="text-gray-400">No unmatched or questionable user-inputted transactions.</p>
                ) : homeFilteredIncompleteRows.length === 0 ? (
                  <p className="text-gray-400">No rows match your search or account filter.</p>
                ) : (
                  <div className="space-y-2">
                    {homeFilteredIncompleteRows.map(({ entry, suggestedBank }, index) => {
                      const match = suggestedBank;
                      const tx = match?.bankTransaction;
                      const id = tx ? idForTx(tx) : `no-bank:${entry.id}`;
                      const isTransferCandidate = Boolean(
                        match &&
                          (match.matchType === "transfer" ||
                            match.matchType === "questionable_match_fuzzy") &&
                          Boolean(match.matchedSheetTransfer?.transferRowId),
                      );
                      return (
                        <div
                          key={`${entry.id}-${index}`}
                          className="rounded-lg border border-charcoal-dark bg-[#2c2c2c] px-3 py-2"
                        >
                          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-start">
                            <div className="min-w-0">
                              <p className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">
                                User-inputted
                              </p>
                              {entry.source === "Expenses" ? (
                                <>
                                  <p className="text-yellow-300 text-sm truncate">{entry.title}</p>
                                  <p className="text-xs text-gray-400 mt-0.5">
                                    {entry.subtitle} • {fmtMoney(entry.amount)}
                                  </p>
                                </>
                              ) : (
                                <>
                                  <p className="text-green-300 text-sm truncate">{entry.title}</p>
                                  <p className="text-xs text-gray-400 mt-0.5">
                                    {entry.subtitle} • {fmtMoney(entry.amount)}
                                  </p>
                                </>
                              )}
                            </div>
                            <div className="min-w-0">
                              <p className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">
                                Bank Transaction
                              </p>
                              {tx ? (
                                <>
                                  <p className="text-gray-200 font-medium truncate">{tx.description || "—"}</p>
                                  <p className="text-xs text-gray-400 mt-0.5">
                                    {tx.accountName} • {fmtDate(tx.date)} • {fmtMoney(tx.amount)}
                                  </p>
                                </>
                              ) : (
                                <p className="text-xs text-gray-500">
                                  No suggested statement line yet. Use Claim to pick a statement transaction.
                                </p>
                              )}
                            </div>
                            <div className="shrink-0 flex items-center gap-1">
                              <button
                                type="button"
                                onClick={() => match && handleApprove(match)}
                                disabled={!match || processingId === id}
                                className="p-1.5 rounded-md text-green-300 hover:text-green-200 hover:bg-green-500/10 disabled:opacity-60 transition-colors"
                                aria-label={isTransferCandidate ? "Claim transfer leg" : "Approve match"}
                                title={isTransferCandidate ? "Claim transfer leg" : "Approve and mark processed"}
                              >
                                {match && processingId === id ? (
                                  <Loader2 className="w-4 h-4 animate-spin" />
                                ) : (
                                  <Check className="w-4 h-4" />
                                )}
                              </button>
                              {match && (
                                <button
                                  type="button"
                                  onClick={() => openDismissModal(match)}
                                  className="p-1.5 rounded-md text-amber-300/90 hover:text-amber-200 hover:bg-amber-500/10 transition-colors"
                                  aria-label="Dismiss statement line with note"
                                  title="Dismiss statement line (bank) with note"
                                >
                                  <Ban className="w-4 h-4" />
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => openUserDismissModal(entry)}
                                disabled={!parseSheetDismissKeyFromEntryId(entry.id)}
                                className="p-1.5 rounded-md text-red-300 hover:text-red-200 hover:bg-red-500/10 disabled:opacity-60 transition-colors"
                                aria-label="Dismiss user-inputted row with note"
                                title="Dismiss user-inputted row with note"
                              >
                                <X className="w-4 h-4" />
                              </button>
                              <button
                                type="button"
                                onClick={() => match && openQuickAdd(match)}
                                disabled={!match || Boolean(match.matchedSheetTransfer)}
                                className="p-1.5 rounded-md text-blue-300 hover:text-blue-200 hover:bg-blue-500/10 disabled:opacity-60 transition-colors"
                                aria-label="Quick add"
                                title="Quick add to sheet"
                              >
                                <PlusCircle className="w-4 h-4" />
                              </button>
                              <button
                                type="button"
                                onClick={() => openUserStatementClaimModal(entry)}
                                className="px-2 py-1 rounded-md text-[11px] text-purple-300 hover:text-purple-200 hover:bg-purple-500/10 transition-colors"
                                aria-label="Claim statement line"
                                title="Pick a statement line to link"
                              >
                                Claim
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </section>

            <section className="rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden min-w-0">
              <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark flex items-center justify-between gap-3">
                <h2 className="text-white font-semibold">User-inputted: Matched</h2>
                <span className="text-xs text-gray-300">{homeFilteredMatchedRows.length}</span>
              </div>
              <div className="p-3 text-sm">
                <p className="text-xs text-gray-500 mb-3">
                  When a suggested row has a sheet Row ID, the checkmark saves a real Neon link between that expense
                  or transfer and the bank line (same as Claim). If there is no Row ID, the checkmark only marks the
                  statement processed—see{" "}
                  <span className="text-gray-400">Statement: closed without sheet row</span>. Use{" "}
                  <span className="text-gray-400">Disconnect</span> to undo a link and match again.
                </p>
                {allHomeUserLinkedMatchedMatches.length === 0 ? (
                  <p className="text-gray-400">No sheet-linked matches yet.</p>
                ) : homeFilteredMatchedRows.length === 0 ? (
                  <p className="text-gray-400">No rows match your search or account filter.</p>
                ) : (
                  <div className="space-y-2">
                    {homeFilteredMatchedRows.map((match, index) => {
                      const tx = match.bankTransaction;
                      const rowId = idForTx(tx);
                      const dismissalNote = dismissalNotesById[rowId];
                      return (
                        <div
                          key={`${rowId}-${index}`}
                          className="rounded-lg border border-charcoal-dark bg-[#2c2c2c] px-3 py-2"
                        >
                          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-start">
                            <div className="min-w-0">
                              <p className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">
                                User-inputted Entry
                              </p>
                              {dismissalNote ? (
                                <p className="text-amber-200/90 text-sm whitespace-pre-wrap break-words">
                                  Dismissed: {dismissalNote}
                                </p>
                              ) : match.matchedSheetExpense ? (
                                <>
                                  <p className="text-green-300 text-sm truncate">
                                    {match.matchedSheetExpense.description || "—"}
                                  </p>
                                  <p className="text-xs text-gray-400 mt-0.5">
                                    {(match.matchedSheetExpense.expenseType ?? "—")} •{" "}
                                    {fmtDate(
                                      match.matchedSheetExpense.timestamp ?? match.matchedSheetExpense.date,
                                    )}{" "}
                                    • {fmtMoney(match.matchedSheetExpense.amount)}
                                    {match.matchedSheetExpense.account
                                      ? ` • ${match.matchedSheetExpense.account}`
                                      : ""}
                                  </p>
                                </>
                              ) : match.matchedSheetTransfer ? (
                                <>
                                  <p className="text-green-300 text-sm truncate">
                                    {(match.matchedSheetTransfer.transferFrom ?? "—")} →{" "}
                                    {(match.matchedSheetTransfer.transferTo ?? "—")}
                                  </p>
                                  <p className="text-xs text-gray-400 mt-0.5">
                                    Transfer •{" "}
                                    {fmtDate(
                                      match.matchedSheetTransfer.timestamp ?? match.matchedSheetTransfer.date,
                                    )}{" "}
                                    • {fmtMoney(match.matchedSheetTransfer.amount)}
                                  </p>
                                </>
                              ) : (
                                <p className="text-xs text-gray-500">Processed</p>
                              )}
                            </div>
                            <div className="min-w-0">
                              <p className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">
                                Bank Transaction
                              </p>
                              <p className="text-gray-200 truncate">{tx.description || "—"}</p>
                              <p className="text-xs text-gray-400 mt-0.5">
                                {tx.accountName} • {fmtDate(tx.date)} • {fmtMoney(tx.amount)}
                              </p>
                            </div>
                            <div className="shrink-0 flex items-start pt-0.5">
                              <button
                                type="button"
                                onClick={() => void handleDisconnectSheetLink(match)}
                                disabled={processingId === rowId}
                                className="p-1.5 rounded-md text-orange-300/90 hover:text-orange-200 hover:bg-orange-500/10 disabled:opacity-60 transition-colors"
                                title="Remove sheet link and reopen this bank line"
                                aria-label="Disconnect sheet link"
                              >
                                {processingId === rowId ? (
                                  <Loader2 className="w-4 h-4 animate-spin" />
                                ) : (
                                  <Link2Off className="w-4 h-4" />
                                )}
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </section>

            {allHomeStatementClosedOnlyMatches.length > 0 && (
              <section className="rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden min-w-0">
                <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark flex items-center justify-between gap-3">
                  <h2 className="text-white font-semibold">Statement: closed without sheet row</h2>
                  <span className="text-xs text-gray-300">{homeFilteredStatementClosedRows.length}</span>
                </div>
                <div className="p-3 text-sm">
                  <p className="text-xs text-gray-500 mb-3">
                    Processed or dismissed on the bank side only—no expense/transfer row attached in the matcher. To
                    account for them: add or fix the row in Google Sheets, refresh matches for that account, then use{" "}
                    <span className="text-gray-400">Claim</span> on the home list (or Claim from an unmatched
                    statement row).
                  </p>
                  {homeFilteredStatementClosedRows.length === 0 ? (
                    <p className="text-gray-400">No rows match your search or account filter.</p>
                  ) : (
                    <div className="space-y-2">
                      {homeFilteredStatementClosedRows.map((match, index) => {
                        const tx = match.bankTransaction;
                        const rowId = idForTx(tx);
                        const dismissalNote = dismissalNotesById[rowId];
                        return (
                          <div
                            key={`closed-${rowId}-${index}`}
                            className="rounded-lg border border-charcoal-dark bg-[#2c2c2c] px-3 py-2"
                          >
                            <div className="grid gap-3 md:grid-cols-2 items-start">
                              <div className="min-w-0">
                                <p className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">
                                  Statement status
                                </p>
                                {dismissalNote ? (
                                  <p className="text-amber-200/90 text-sm whitespace-pre-wrap break-words">
                                    Dismissed: {dismissalNote}
                                  </p>
                                ) : (
                                  <p className="text-xs text-gray-500">
                                    Processed on statement only — no linked expense or transfer row in the matcher.
                                  </p>
                                )}
                              </div>
                              <div className="min-w-0">
                                <p className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">
                                  Bank transaction
                                </p>
                                <p className="text-gray-200 truncate">{tx.description || "—"}</p>
                                <p className="text-xs text-gray-400 mt-0.5">
                                  {tx.accountName} • {fmtDate(tx.date)} • {fmtMoney(tx.amount)}
                                </p>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </section>
            )}

            <section className="rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden min-w-0">
              <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark flex items-center justify-between gap-3">
                <h2 className="text-white font-semibold">User-inputted: Dismissed</h2>
                <span className="text-xs text-gray-300">{homeFilteredUserDismissedRows.length}</span>
              </div>
              <div className="p-3 text-sm">
                {userDismissedRowKeys.size === 0 ? (
                  <p className="text-gray-400">No user-inputted rows dismissed yet.</p>
                ) : homeFilteredUserDismissedRows.length === 0 ? (
                  <p className="text-gray-400">No rows match your search or account filter.</p>
                ) : (
                  <div className="space-y-2">
                    {homeFilteredUserDismissedRows.map((entry, index) => (
                      <div
                        key={`${entry.id}-${index}`}
                        className="rounded-lg border border-charcoal-dark bg-[#2c2c2c] px-3 py-2"
                      >
                        <div className="grid gap-3 md:grid-cols-2 items-start">
                          <div className="min-w-0">
                            <p className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">
                              User-inputted
                            </p>
                            {entry.source === "Expenses" ? (
                              <>
                                <p className="text-yellow-300 text-sm truncate">{entry.title}</p>
                                <p className="text-xs text-gray-400 mt-0.5">
                                  {entry.subtitle} • {fmtMoney(entry.amount)}
                                </p>
                              </>
                            ) : (
                              <>
                                <p className="text-green-300 text-sm truncate">{entry.title}</p>
                                <p className="text-xs text-gray-400 mt-0.5">
                                  {entry.subtitle} • {fmtMoney(entry.amount)}
                                </p>
                              </>
                            )}
                          </div>
                          <div className="min-w-0">
                            <p className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">
                              Note
                            </p>
                            <p className="text-amber-200/90 text-sm whitespace-pre-wrap break-words">
                              {userDismissalNotesByEntryId[entry.id] ?? "—"}
                            </p>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>
            </div>

            <section className="rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden min-w-0">
              <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark flex items-center justify-between gap-3">
                <h2 className="text-white font-semibold">Statement Accounts</h2>
                <span className="text-xs text-gray-300">
                  {tabAccounts.reduce(
                    (sum, account) => sum + (statementReviewRowsByAccount[account]?.length ?? 0),
                    0,
                  )}{" "}
                  to reconcile
                </span>
              </div>
              <div className="p-3 text-sm space-y-3">
                {tabAccounts.map((account) => {
                  const reviewRows = statementReviewRowsByAccount[account] ?? [];
                  const hasParser = accountHasConfiguredParser(account);
                  return (
                    <div
                      key={account}
                      className="rounded-lg border border-charcoal-dark bg-[#2c2c2c] px-3 py-3"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-gray-100 font-medium">{account}</p>
                        <button
                          type="button"
                          onClick={() => {
                            setActiveTab(account);
                            if (ACCOUNT_OPTIONS.includes(account as AccountOption)) {
                              setSelectedAccount(account as AccountOption);
                            }
                            setViewMode("accountDetail");
                          }}
                          className="px-2.5 py-1 rounded-md text-xs text-blue-300 hover:text-blue-200 hover:bg-blue-500/10 transition-colors"
                        >
                          See all transactions
                        </button>
                      </div>
                      <p className="text-xs text-gray-400 mt-1">
                        Unmatched / suggested: {reviewRows.length}
                      </p>
                      {reviewRows.length === 0 && !hasParser && (
                        <p className="text-[11px] text-yellow-300/90 mt-1">
                          Statement CSV parser not configured yet for this account.
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          </div>
        ) : (
          <>
            <section className="rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden">
              <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark flex items-center justify-between gap-3">
                <h2 className="text-white font-semibold">{activeTab}: Unmatched / Suggested</h2>
                <span className="text-xs text-gray-300">{activeReviewRows.length}</span>
                <button
                  type="button"
                  onClick={() => setViewMode("home")}
                  className="px-2.5 py-1 rounded-md text-xs text-gray-300 hover:text-white hover:bg-[#2c2c2c] transition-colors"
                >
                  Back to home
                </button>
              </div>
              <div className="p-3 text-sm">
                {activeReviewRows.length === 0 ? (
                  <p className="text-gray-400">No rows requiring manual review for this account.</p>
                ) : (
                  <div className="space-y-2">
                    {activeReviewRows.map((match, index) => {
                      const tx = match.bankTransaction;
                      const id = idForTx(tx);
                      const isTransferCandidate =
                        (match.matchType === "transfer" || match.matchType === "questionable_match_fuzzy") &&
                        Boolean(match.matchedSheetTransfer?.transferRowId);
                      return (
                        <div
                          key={`${id}-${index}`}
                          className="rounded-lg border border-charcoal-dark bg-[#2c2c2c] px-3 py-2"
                        >
                          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-start">
                            <div className="min-w-0">
                              <p className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">
                                Bank Transaction
                              </p>
                              <p className="text-gray-200 font-medium truncate">{tx.description || "—"}</p>
                              <p className="text-xs text-gray-400 mt-0.5">
                                {tx.accountName} • {fmtDate(tx.date)} • {fmtMoney(tx.amount)}
                              </p>
                            </div>
                            <div className="min-w-0">
                              <p className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">
                                Possible Sheet Match
                              </p>
                              {match.matchType === "questionable_match_fuzzy" && match.matchedSheetExpense ? (
                                <>
                                  <p className="text-yellow-300 text-sm truncate">
                                    {match.matchedSheetExpense.description || "—"}
                                  </p>
                                  <p className="text-xs text-gray-400 mt-0.5">
                                    {(match.matchedSheetExpense.expenseType ?? "—")} •{" "}
                                    {fmtDate(match.matchedSheetExpense.timestamp ?? match.matchedSheetExpense.date)} •{" "}
                                    {fmtMoney(match.matchedSheetExpense.amount)}
                                    {match.matchedSheetExpense.account
                                      ? ` • ${match.matchedSheetExpense.account}`
                                      : ""}
                                  </p>
                                </>
                              ) : (match.matchType === "questionable_match_fuzzy" ||
                                  match.matchType === "transfer") &&
                                match.matchedSheetTransfer ? (
                                <>
                                  <p
                                    className={`text-sm truncate ${
                                      match.matchType === "transfer" ? "text-green-300" : "text-yellow-300"
                                    }`}
                                  >
                                    {(match.matchedSheetTransfer.transferFrom ?? "—")} →{" "}
                                    {(match.matchedSheetTransfer.transferTo ?? "—")}
                                  </p>
                                  <p className="text-xs text-gray-400 mt-0.5">
                                    Transfer •{" "}
                                    {fmtDate(
                                      match.matchedSheetTransfer.timestamp ??
                                        match.matchedSheetTransfer.date,
                                    )}{" "}
                                    • {fmtMoney(match.matchedSheetTransfer.amount)}
                                  </p>
                                  <p className="text-[11px] text-gray-500 mt-0.5">
                                    Transfer Row ID: {match.matchedSheetTransfer.transferRowId ?? "missing"}
                                  </p>
                                </>
                              ) : (
                                <p className="text-xs text-gray-500">No candidate match</p>
                              )}
                            </div>
                            <div className="shrink-0 flex items-center gap-1">
                              <button
                                type="button"
                                onClick={() => handleApprove(match)}
                                disabled={processingId === id}
                                className="p-1.5 rounded-md text-green-300 hover:text-green-200 hover:bg-green-500/10 disabled:opacity-60 transition-colors"
                                aria-label={isTransferCandidate ? "Claim transfer leg" : "Approve match"}
                                title={isTransferCandidate ? "Claim transfer leg" : "Approve and mark processed"}
                              >
                                {processingId === id ? (
                                  <Loader2 className="w-4 h-4 animate-spin" />
                                ) : (
                                  <Check className="w-4 h-4" />
                                )}
                              </button>
                              <button
                                type="button"
                                onClick={() => openDismissModal(match)}
                                className="p-1.5 rounded-md text-red-300 hover:text-red-200 hover:bg-red-500/10 transition-colors"
                                aria-label="Dismiss with note"
                                title="Dismiss with note"
                              >
                                <X className="w-4 h-4" />
                              </button>
                              <button
                                type="button"
                                onClick={() => openQuickAdd(match)}
                                disabled={Boolean(match.matchedSheetTransfer)}
                                className="p-1.5 rounded-md text-blue-300 hover:text-blue-200 hover:bg-blue-500/10 transition-colors"
                                aria-label="Quick add"
                                title="Quick add to sheet"
                              >
                                <PlusCircle className="w-4 h-4" />
                              </button>
                              <button
                                type="button"
                                onClick={() => openSplitModal(match)}
                                disabled={Boolean(match.matchedSheetTransfer)}
                                className="px-2 py-1 rounded-md text-[11px] text-purple-300 hover:text-purple-200 hover:bg-purple-500/10 transition-colors"
                                aria-label="Claim existing rows"
                                title="Claim existing unmatched sheet rows"
                              >
                                Claim
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </section>

            <section className="rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden">
              <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark flex items-center justify-between gap-3">
                <h2 className="text-white font-semibold">{activeTab}: Matched to sheet</h2>
                <span className="text-xs text-gray-300">{activeUserLinkedMatchedRows.length}</span>
              </div>
              <div className="p-3 text-sm">
                <p className="text-xs text-gray-500 mb-3">
                  Checkmark with a sheet Row ID saves the Neon claim link.{" "}
                  <span className="text-gray-400">Disconnect</span> removes the link and unmarks processed so you can
                  match again.
                </p>
                {activeUserLinkedMatchedRows.length === 0 ? (
                  <p className="text-gray-400">No rows linked to an expense or transfer for this account yet.</p>
                ) : (
                  <div className="space-y-2">
                    {activeUserLinkedMatchedRows.map((match, index) => {
                      const tx = match.bankTransaction;
                      const rowId = idForTx(tx);
                      const dismissalNote = dismissalNotesById[rowId];
                      return (
                        <div
                          key={`${rowId}-${index}`}
                          className="rounded-lg border border-charcoal-dark bg-[#2c2c2c] px-3 py-2"
                        >
                          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-start">
                            <div className="min-w-0">
                              <p className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">
                                Bank Transaction
                              </p>
                              <p className="text-gray-200 truncate">{tx.description || "—"}</p>
                              <p className="text-xs text-gray-400 mt-0.5">
                                {tx.accountName} • {fmtDate(tx.date)} • {fmtMoney(tx.amount)}
                              </p>
                            </div>
                            <div className="min-w-0">
                              <p className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">
                                User-inputted Entry
                              </p>
                              {dismissalNote ? (
                                <p className="text-amber-200/90 text-sm whitespace-pre-wrap break-words">
                                  Dismissed: {dismissalNote}
                                </p>
                              ) : match.matchedSheetExpense ? (
                                <>
                                  <p className="text-green-300 text-sm truncate">
                                    {match.matchedSheetExpense.description || "—"}
                                  </p>
                                  <p className="text-xs text-gray-400 mt-0.5">
                                    {(match.matchedSheetExpense.expenseType ?? "—")} •{" "}
                                    {fmtDate(
                                      match.matchedSheetExpense.timestamp ?? match.matchedSheetExpense.date,
                                    )}{" "}
                                    • {fmtMoney(match.matchedSheetExpense.amount)}
                                  </p>
                                </>
                              ) : match.matchedSheetTransfer ? (
                                <>
                                  <p className="text-green-300 text-sm truncate">
                                    {(match.matchedSheetTransfer.transferFrom ?? "—")} →{" "}
                                    {(match.matchedSheetTransfer.transferTo ?? "—")}
                                  </p>
                                  <p className="text-xs text-gray-400 mt-0.5">
                                    Transfer •{" "}
                                    {fmtDate(
                                      match.matchedSheetTransfer.timestamp ?? match.matchedSheetTransfer.date,
                                    )}{" "}
                                    • {fmtMoney(match.matchedSheetTransfer.amount)}
                                  </p>
                                </>
                              ) : (
                                <p className="text-xs text-gray-500">Processed</p>
                              )}
                            </div>
                            <div className="shrink-0 flex items-start pt-0.5">
                              <button
                                type="button"
                                onClick={() => void handleDisconnectSheetLink(match)}
                                disabled={processingId === rowId}
                                className="p-1.5 rounded-md text-orange-300/90 hover:text-orange-200 hover:bg-orange-500/10 disabled:opacity-60 transition-colors"
                                title="Remove sheet link and reopen this bank line"
                                aria-label="Disconnect sheet link"
                              >
                                {processingId === rowId ? (
                                  <Loader2 className="w-4 h-4 animate-spin" />
                                ) : (
                                  <Link2Off className="w-4 h-4" />
                                )}
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </section>

            {activeStatementClosedOnlyRows.length > 0 && (
              <section className="rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden">
                <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark flex items-center justify-between gap-3">
                  <h2 className="text-white font-semibold">{activeTab}: Closed on statement (no sheet link)</h2>
                  <span className="text-xs text-gray-300">{activeStatementClosedOnlyRows.length}</span>
                </div>
                <div className="p-3 text-sm">
                  <p className="text-xs text-gray-500 mb-3">
                    Processed or dismissed here without a linked expense/transfer row. Add or fix the sheet row and
                    refresh matches, or use Claim where amounts match.
                  </p>
                  <div className="space-y-2">
                    {activeStatementClosedOnlyRows.map((match, index) => {
                      const tx = match.bankTransaction;
                      const rowId = idForTx(tx);
                      const dismissalNote = dismissalNotesById[rowId];
                      return (
                        <div
                          key={`acct-closed-${rowId}-${index}`}
                          className="rounded-lg border border-charcoal-dark bg-[#2c2c2c] px-3 py-2"
                        >
                          <div className="grid gap-3 md:grid-cols-2 items-start">
                            <div className="min-w-0">
                              <p className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">
                                Bank Transaction
                              </p>
                              <p className="text-gray-200 truncate">{tx.description || "—"}</p>
                              <p className="text-xs text-gray-400 mt-0.5">
                                {tx.accountName} • {fmtDate(tx.date)} • {fmtMoney(tx.amount)}
                              </p>
                            </div>
                            <div className="min-w-0">
                              <p className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">
                                Statement status
                              </p>
                              {dismissalNote ? (
                                <p className="text-amber-200/90 text-sm whitespace-pre-wrap break-words">
                                  Dismissed: {dismissalNote}
                                </p>
                              ) : (
                                <p className="text-xs text-gray-500">
                                  Processed on statement only — no linked sheet row.
                                </p>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </section>
            )}

            {activeReviewRows.length > 0 && (
              <p className="text-xs text-gray-500">
                Showing {activeReviewRows.length} unmatched/suggested row
                {activeReviewRows.length === 1 ? "" : "s"} for {activeTab}.
              </p>
            )}
          </>
        )}
      </div>

      {quickAdd.open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50"
          onClick={closeQuickAdd}
          role="dialog"
          aria-modal="true"
          aria-labelledby="quick-add-title"
        >
          <div
            className="w-full max-w-md rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark flex items-center justify-between">
              <h2 id="quick-add-title" className="text-white font-semibold">Quick Add Transaction</h2>
              <button
                type="button"
                onClick={closeQuickAdd}
                className="p-1 rounded-md text-gray-400 hover:text-white hover:bg-charcoal transition-colors"
                aria-label="Close modal"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-4 space-y-3">
              <div>
                <label className="block text-xs text-gray-400 mb-1">Expense Type</label>
                <select
                  value={quickAdd.expenseType}
                  onChange={(e) => setQuickAdd((prev) => ({ ...prev, expenseType: e.target.value }))}
                  className="w-full px-3 py-2 rounded-lg bg-charcoal border border-charcoal-dark text-gray-200 text-sm focus:border-accent focus:ring-1 focus:ring-accent outline-none"
                >
                  {EXPENSE_TYPE_OPTIONS.map((opt) => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">Amount</label>
                <input
                  type="text"
                  inputMode="decimal"
                  value={quickAdd.amount}
                  onChange={(e) => setQuickAdd((prev) => ({ ...prev, amount: e.target.value }))}
                  className="w-full px-3 py-2 rounded-lg bg-charcoal border border-charcoal-dark text-gray-200 text-sm focus:border-accent focus:ring-1 focus:ring-accent outline-none"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">Description</label>
                <input
                  type="text"
                  value={quickAdd.description}
                  onChange={(e) => setQuickAdd((prev) => ({ ...prev, description: e.target.value }))}
                  className="w-full px-3 py-2 rounded-lg bg-charcoal border border-charcoal-dark text-gray-200 text-sm focus:border-accent focus:ring-1 focus:ring-accent outline-none"
                />
              </div>
              {quickAdd.error && <p className="text-xs text-red-400">{quickAdd.error}</p>}
            </div>
            <div className="px-4 py-3 border-t border-charcoal-dark flex justify-end gap-2">
              <button
                type="button"
                onClick={closeQuickAdd}
                className="px-3 py-1.5 rounded-lg text-sm text-gray-400 hover:text-white transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleQuickAddSubmit}
                disabled={quickAdd.submitting}
                className="px-3 py-1.5 rounded-lg text-sm bg-accent text-white hover:bg-accent-dark transition-colors disabled:opacity-60 inline-flex items-center gap-1.5"
              >
                {quickAdd.submitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                Save
              </button>
            </div>
          </div>
        </div>
      )}
      {dismissModal.open && dismissModal.match && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50"
          onClick={closeDismissModal}
          role="dialog"
          aria-modal="true"
          aria-labelledby="dismiss-statement-title"
        >
          <div
            className="w-full max-w-md rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark flex items-center justify-between">
              <h2 id="dismiss-statement-title" className="text-white font-semibold">
                Dismiss statement line
              </h2>
              <button
                type="button"
                onClick={closeDismissModal}
                className="p-1 rounded-md text-gray-400 hover:text-white hover:bg-charcoal transition-colors"
                aria-label="Close modal"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-4 space-y-3">
              <div className="rounded-md border border-charcoal-dark bg-charcoal px-3 py-2 text-sm text-gray-300">
                <p className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">Bank</p>
                <p className="text-gray-100 truncate">
                  {dismissModal.match.bankTransaction.description || "—"}
                </p>
                <p className="text-xs text-gray-400 mt-0.5">
                  {dismissModal.match.bankTransaction.accountName} •{" "}
                  {fmtDate(dismissModal.match.bankTransaction.date)} •{" "}
                  {fmtMoney(dismissModal.match.bankTransaction.amount)}
                </p>
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">Note (saved to Neon)</label>
                <textarea
                  value={dismissModal.note}
                  onChange={(e) =>
                    setDismissModal((prev) => ({ ...prev, note: e.target.value, error: "" }))
                  }
                  rows={4}
                  placeholder="e.g. Paid for group dinner; reimbursed on Venmo."
                  className="w-full px-3 py-2 rounded-lg bg-charcoal border border-charcoal-dark text-gray-200 text-sm focus:border-accent focus:ring-1 focus:ring-accent outline-none resize-y min-h-[96px]"
                />
              </div>
              {dismissModal.error && <p className="text-xs text-red-400">{dismissModal.error}</p>}
            </div>
            <div className="px-4 py-3 border-t border-charcoal-dark flex justify-end gap-2">
              <button
                type="button"
                onClick={closeDismissModal}
                className="px-3 py-1.5 rounded-lg text-sm text-gray-400 hover:text-white transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleDismissSubmit()}
                disabled={dismissModal.submitting}
                className="px-3 py-1.5 rounded-lg text-sm bg-amber-700/90 text-white hover:bg-amber-700 transition-colors disabled:opacity-60 inline-flex items-center gap-1.5"
              >
                {dismissModal.submitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                Save dismissal
              </button>
            </div>
          </div>
        </div>
      )}
      {userDismissModal.open && userDismissModal.entry && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50"
          onClick={closeUserDismissModal}
          role="dialog"
          aria-modal="true"
          aria-labelledby="dismiss-user-sheet-title"
        >
          <div
            className="w-full max-w-md rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark flex items-center justify-between">
              <h2 id="dismiss-user-sheet-title" className="text-white font-semibold">
                Dismiss user-inputted row
              </h2>
              <button
                type="button"
                onClick={closeUserDismissModal}
                className="p-1 rounded-md text-gray-400 hover:text-white hover:bg-charcoal transition-colors"
                aria-label="Close modal"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-4 space-y-3">
              <div className="rounded-md border border-charcoal-dark bg-charcoal px-3 py-2 text-sm text-gray-300">
                <p className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">
                  {userDismissModal.entry.source}
                </p>
                <p className="text-gray-100 truncate">{userDismissModal.entry.title}</p>
                <p className="text-xs text-gray-400 mt-0.5">
                  {userDismissModal.entry.subtitle} • {fmtMoney(userDismissModal.entry.amount)}
                </p>
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">Note (saved to Neon)</label>
                <textarea
                  value={userDismissModal.note}
                  onChange={(e) =>
                    setUserDismissModal((prev) => ({ ...prev, note: e.target.value, error: "" }))
                  }
                  rows={4}
                  placeholder="e.g. Duplicate entry; entered in error."
                  className="w-full px-3 py-2 rounded-lg bg-charcoal border border-charcoal-dark text-gray-200 text-sm focus:border-accent focus:ring-1 focus:ring-accent outline-none resize-y min-h-[96px]"
                />
              </div>
              {userDismissModal.error && <p className="text-xs text-red-400">{userDismissModal.error}</p>}
            </div>
            <div className="px-4 py-3 border-t border-charcoal-dark flex justify-end gap-2">
              <button
                type="button"
                onClick={closeUserDismissModal}
                className="px-3 py-1.5 rounded-lg text-sm text-gray-400 hover:text-white transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleUserDismissSubmit()}
                disabled={userDismissModal.submitting}
                className="px-3 py-1.5 rounded-lg text-sm bg-amber-700/90 text-white hover:bg-amber-700 transition-colors disabled:opacity-60 inline-flex items-center gap-1.5"
              >
                {userDismissModal.submitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                Save dismissal
              </button>
            </div>
          </div>
        </div>
      )}
      {resetReconcileModal.open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50"
          onClick={closeResetReconcileModal}
          role="dialog"
          aria-modal="true"
          aria-labelledby="reset-reconcile-title"
        >
          <div
            className="w-full max-w-md rounded-xl bg-[#252525] border border-red-500/30 overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark flex items-center justify-between">
              <h2 id="reset-reconcile-title" className="text-white font-semibold">
                Clear all reconciliation data
              </h2>
              <button
                type="button"
                onClick={closeResetReconcileModal}
                className="p-1 rounded-md text-gray-400 hover:text-white hover:bg-charcoal transition-colors"
                aria-label="Close modal"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-4 space-y-3 text-sm text-gray-300">
              <p>
                This removes <span className="text-gray-200">statement match data</span> from this
                browser, and deletes in Neon: processed hashes, claim links, transfer claims,
                dismissal notes (statement and user-inputted sheet rows), and uploaded-file history.
                Your Google Sheet expenses are not changed. Statement ending balances (anchors) are
                kept.
              </p>
              <p className="text-xs text-gray-500">
                Type{" "}
                <code className="text-amber-200/90">{RECONCILIATION_RESET_CONFIRM}</code> to confirm.
              </p>
              <input
                type="text"
                value={resetReconcileModal.confirmText}
                onChange={(e) =>
                  setResetReconcileModal((prev) => ({
                    ...prev,
                    confirmText: e.target.value,
                    error: "",
                  }))
                }
                autoComplete="off"
                className="w-full px-3 py-2 rounded-lg bg-charcoal border border-charcoal-dark text-gray-200 text-sm focus:border-red-500/50 focus:ring-1 focus:ring-red-500/30 outline-none font-mono"
                placeholder={RECONCILIATION_RESET_CONFIRM}
              />
              {resetReconcileModal.error && (
                <p className="text-xs text-red-400">{resetReconcileModal.error}</p>
              )}
            </div>
            <div className="px-4 py-3 border-t border-charcoal-dark flex justify-end gap-2">
              <button
                type="button"
                onClick={closeResetReconcileModal}
                className="px-3 py-1.5 rounded-lg text-sm text-gray-400 hover:text-white transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleFullReconcileReset()}
                disabled={resetReconcileModal.submitting}
                className="px-3 py-1.5 rounded-lg text-sm bg-red-600 text-white hover:bg-red-500 transition-colors disabled:opacity-60 inline-flex items-center gap-1.5"
              >
                {resetReconcileModal.submitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                Clear everything
              </button>
            </div>
          </div>
        </div>
      )}
      {splitModal.open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50"
          onClick={closeSplitModal}
          role="dialog"
          aria-modal="true"
          aria-labelledby="claim-existing-title"
        >
          <div
            className="w-full max-w-3xl rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark flex items-center justify-between">
              <h2 id="claim-existing-title" className="text-white font-semibold">
                Claim Existing Sheet Rows
              </h2>
              <button
                type="button"
                onClick={closeSplitModal}
                className="p-1 rounded-md text-gray-400 hover:text-white hover:bg-charcoal transition-colors"
                aria-label="Close modal"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-4 space-y-3">
              {splitTargetTransaction && (
                <div className="rounded-md border border-charcoal-dark bg-charcoal px-3 py-2 text-sm text-gray-300">
                  <p className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">Selected Transaction</p>
                  <p className="text-gray-100 truncate">{splitTargetTransaction.description || "—"}</p>
                  <p className="text-xs text-gray-400 mt-0.5">
                    {splitTargetTransaction.accountName} • {fmtDate(splitTargetTransaction.date)} •{" "}
                    {fmtMoney(splitTargetTransaction.amount)}
                  </p>
                </div>
              )}
              <div className="rounded-md border border-charcoal-dark bg-charcoal px-3 py-2 text-sm text-gray-300">
                Target: <span className="text-white">{fmtMoney(splitTargetAmount)}</span>
                <span className="text-gray-500"> • </span>
                Entered: <span className="text-white">{fmtMoney(splitEnteredAmount)}</span>
                <span className="text-gray-500"> • </span>
                Remaining:{" "}
                <span
                  className={
                    toCents(splitRemainingAmount) === 0
                      ? "text-green-300"
                      : splitRemainingAmount > 0
                        ? "text-yellow-300"
                        : "text-red-300"
                  }
                >
                  {fmtMoney(splitRemainingAmount)}
                </span>
              </div>

              {splitSelectionIncludesTransfer && (
                <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 space-y-2">
                  <p className="text-xs text-amber-100/90">
                    This claim links a <span className="font-medium">Transfers</span> sheet row. How many
                    bank legs should this transfer need?
                  </p>
                  <div className="flex flex-wrap gap-4 text-sm text-gray-200">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="split-transfer-legs"
                        checked={splitModal.transferExpectedLegs === 2}
                        onChange={() =>
                          setSplitModal((prev) => ({ ...prev, transferExpectedLegs: 2, error: "" }))
                        }
                        disabled={splitModal.submitting}
                      />
                      Two legs (typical between two accounts)
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="split-transfer-legs"
                        checked={splitModal.transferExpectedLegs === 1}
                        onChange={() =>
                          setSplitModal((prev) => ({ ...prev, transferExpectedLegs: 1, error: "" }))
                        }
                        disabled={splitModal.submitting}
                      />
                      One leg only
                    </label>
                  </div>
                </div>
              )}

              <div>
                <label className="block text-xs text-gray-400 mb-1">Search rows</label>
                <input
                  type="text"
                  value={splitSearchQuery}
                  onChange={(e) => setSplitSearchQuery(e.target.value)}
                  placeholder="Search expenses or transfers (type, description, row ID, date)"
                  className="w-full px-3 py-2 rounded-lg bg-charcoal border border-charcoal-dark text-gray-200 text-sm focus:border-accent focus:ring-1 focus:ring-accent outline-none"
                />
              </div>

              <div className="max-h-[50vh] overflow-auto rounded-md border border-charcoal-dark bg-charcoal">
                {filteredSplitCandidates.length === 0 ? (
                  <p className="px-3 py-2 text-sm text-gray-400">
                    {splitSearchQuery.trim()
                      ? "No rows match your search."
                      : "No unclaimed sheet rows are available. Expense rows need a Row ID; transfer rows need a Transfer Row ID."}
                  </p>
                ) : (
                  <div className="divide-y divide-charcoal-dark">
                    {filteredSplitCandidates.map((row) => {
                      const selected = splitModal.selectedKeys.includes(row.key);
                      return (
                        <label
                          key={row.key}
                          className="flex items-start gap-3 px-3 py-2 cursor-pointer hover:bg-[#2d2d2d]"
                        >
                          <input
                            type="checkbox"
                            checked={selected}
                            onChange={() => handleToggleSplitClaim(row.key)}
                            disabled={splitModal.submitting}
                            className="mt-1"
                          />
                          <div className="min-w-0">
                            <p className="text-[10px] uppercase tracking-wide text-gray-500 mb-0.5">
                              {row.sheetName}
                            </p>
                            <p className="text-sm text-gray-200 truncate">
                              {row.expenseType || "—"} • {row.description || "—"}
                            </p>
                            <p className="text-xs text-gray-400 mt-0.5">
                              {fmtMoney(row.amount)}
                              {row.timestamp ? ` • ${fmtDate(row.timestamp)}` : ""}
                              {row.account ? ` • ${row.account}` : ""}
                            </p>
                            <p className="text-[11px] text-gray-500 mt-0.5">
                              {row.sheetName === "Transfers" ? "Transfer Row ID" : "Row ID"}: {row.rowId}
                            </p>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>

              {splitModal.error && <p className="text-xs text-red-400">{splitModal.error}</p>}
            </div>
            <div className="px-4 py-3 border-t border-charcoal-dark flex justify-end gap-2">
              <button
                type="button"
                onClick={closeSplitModal}
                className="px-3 py-1.5 rounded-lg text-sm text-gray-400 hover:text-white transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSplitSubmit}
                disabled={splitModal.submitting}
                className="px-3 py-1.5 rounded-lg text-sm bg-accent text-white hover:bg-accent-dark transition-colors disabled:opacity-60 inline-flex items-center gap-1.5"
              >
                {splitModal.submitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                Claim Rows
              </button>
            </div>
          </div>
        </div>
      )}
      {userStatementClaimModal.open && userStatementClaimModal.entry && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50"
          onClick={closeUserStatementClaimModal}
          role="dialog"
          aria-modal="true"
          aria-labelledby="user-statement-claim-title"
        >
          <div
            className="w-full max-w-3xl rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden max-h-[90vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark flex items-center justify-between shrink-0">
              <h2 id="user-statement-claim-title" className="text-white font-semibold">
                Link to statement transaction
              </h2>
              <button
                type="button"
                onClick={closeUserStatementClaimModal}
                className="p-1 rounded-md text-gray-400 hover:text-white hover:bg-charcoal transition-colors"
                aria-label="Close modal"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-4 space-y-3 overflow-y-auto flex-1 min-h-0">
              <div className="rounded-md border border-charcoal-dark bg-charcoal px-3 py-2 text-sm text-gray-300">
                <p className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">User-inputted</p>
                <p className="text-gray-100 truncate">{userStatementClaimModal.entry.title}</p>
                <p className="text-xs text-gray-400 mt-0.5">
                  {userStatementClaimModal.entry.source} • {userStatementClaimModal.entry.subtitle} •{" "}
                  {fmtMoney(userStatementClaimModal.entry.amount)}
                </p>
              </div>
              <p className="text-xs text-gray-400">
                Lists unprocessed statement lines (all accounts when Account is All) whose amount matches this
                entry. Search and account filter narrow the list.
              </p>
              {userStatementClaimModal.entry.source === "Transfers" && (
                <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 space-y-2">
                  <p className="text-xs text-amber-100/90">
                    How many bank legs should this transfer need?
                  </p>
                  <div className="flex flex-wrap gap-4 text-sm text-gray-200">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="user-claim-transfer-legs"
                        checked={userStatementClaimModal.transferExpectedLegs === 2}
                        onChange={() =>
                          setUserStatementClaimModal((prev) => ({
                            ...prev,
                            transferExpectedLegs: 2,
                            error: "",
                          }))
                        }
                        disabled={userStatementClaimModal.submitting}
                      />
                      Two legs
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="user-claim-transfer-legs"
                        checked={userStatementClaimModal.transferExpectedLegs === 1}
                        onChange={() =>
                          setUserStatementClaimModal((prev) => ({
                            ...prev,
                            transferExpectedLegs: 1,
                            error: "",
                          }))
                        }
                        disabled={userStatementClaimModal.submitting}
                      />
                      One leg only
                    </label>
                  </div>
                </div>
              )}
              <div className="flex flex-col sm:flex-row gap-3 sm:items-end">
                <div className="flex-1 min-w-0">
                  <label className="block text-xs text-gray-400 mb-1">Search statement lines</label>
                  <input
                    type="search"
                    value={userStatementClaimModal.searchQuery}
                    onChange={(e) =>
                      setUserStatementClaimModal((prev) => ({
                        ...prev,
                        searchQuery: e.target.value,
                        error: "",
                      }))
                    }
                    placeholder="Description, date, account…"
                    className="w-full px-3 py-2 rounded-lg bg-charcoal border border-charcoal-dark text-gray-200 text-sm focus:border-accent focus:ring-1 focus:ring-accent outline-none"
                  />
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Filter className="w-4 h-4 text-gray-500" aria-hidden />
                  <label htmlFor="user-claim-account-filter" className="text-xs text-gray-400 whitespace-nowrap">
                    Account
                  </label>
                  <select
                    id="user-claim-account-filter"
                    value={userStatementClaimModal.accountFilter}
                    onChange={(e) =>
                      setUserStatementClaimModal((prev) => ({
                        ...prev,
                        accountFilter: e.target.value as AccountOption | typeof ALL_ACCOUNTS_OPTION,
                        error: "",
                      }))
                    }
                    className="px-3 py-2 rounded-lg bg-charcoal border border-charcoal-dark text-gray-200 text-sm focus:border-accent focus:ring-1 focus:ring-accent outline-none min-w-[10rem]"
                  >
                    <option value={ALL_ACCOUNTS_OPTION}>{ALL_ACCOUNTS_OPTION}</option>
                    {ACCOUNT_OPTIONS.map((account) => (
                      <option key={account} value={account}>
                        {account}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="max-h-[40vh] overflow-auto rounded-md border border-charcoal-dark bg-charcoal">
                {userClaimFilteredStatementLines.length === 0 ? (
                  <p className="px-3 py-2 text-sm text-gray-400">
                    No matching statement lines. Upload CSVs or adjust search / account filter.
                  </p>
                ) : (
                  <div className="divide-y divide-charcoal-dark">
                    {userClaimFilteredStatementLines.map((m, idx) => {
                      const tid = idForTx(m.bankTransaction);
                      const selected = userStatementClaimModal.selectedBankRowId === tid;
                      return (
                        <label
                          key={`${tid}-${idx}`}
                          className="flex items-start gap-3 px-3 py-2 cursor-pointer hover:bg-[#2d2d2d]"
                        >
                          <input
                            type="radio"
                            name="user-statement-pick"
                            checked={selected}
                            onChange={() =>
                              setUserStatementClaimModal((prev) => ({
                                ...prev,
                                selectedBankRowId: tid,
                                error: "",
                              }))
                            }
                            disabled={userStatementClaimModal.submitting}
                            className="mt-1"
                          />
                          <div className="min-w-0">
                            <p className="text-[10px] uppercase tracking-wide text-gray-500 mb-0.5">
                              {m.bankTransaction.accountName}
                            </p>
                            <p className="text-sm text-gray-200 truncate">
                              {m.bankTransaction.description || "—"}
                            </p>
                            <p className="text-xs text-gray-400 mt-0.5">
                              {fmtDate(m.bankTransaction.date)} • {fmtMoney(m.bankTransaction.amount)}
                            </p>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
              {userStatementClaimModal.error && (
                <p className="text-xs text-red-400">{userStatementClaimModal.error}</p>
              )}
            </div>
            <div className="px-4 py-3 border-t border-charcoal-dark flex justify-end gap-2 shrink-0">
              <button
                type="button"
                onClick={closeUserStatementClaimModal}
                className="px-3 py-1.5 rounded-lg text-sm text-gray-400 hover:text-white transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleUserStatementClaimSubmit()}
                disabled={userStatementClaimModal.submitting}
                className="px-3 py-1.5 rounded-lg text-sm bg-accent text-white hover:bg-accent-dark transition-colors disabled:opacity-60 inline-flex items-center gap-1.5"
              >
                {userStatementClaimModal.submitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                Link statement
              </button>
            </div>
          </div>
        </div>
      )}
      {transferClaimModal.open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50"
          onClick={closeTransferClaimModal}
          role="dialog"
          aria-modal="true"
          aria-labelledby="transfer-claim-title"
        >
          <div
            className="w-full max-w-md rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark flex items-center justify-between">
              <h2 id="transfer-claim-title" className="text-white font-semibold">
                Claim Transfer Leg
              </h2>
              <button
                type="button"
                onClick={closeTransferClaimModal}
                className="p-1 rounded-md text-gray-400 hover:text-white hover:bg-charcoal transition-colors"
                aria-label="Close modal"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-4 space-y-3">
              <p className="text-sm text-gray-300">
                Choose how many bank legs this transfer should require.
              </p>
              <div className="space-y-2">
                <label className="flex items-center gap-2 text-sm text-gray-200">
                  <input
                    type="radio"
                    name="transfer-expected-legs"
                    checked={transferClaimModal.expectedLegs === 2}
                    onChange={() =>
                      setTransferClaimModal((prev) => ({ ...prev, expectedLegs: 2, error: "" }))
                    }
                    disabled={transferClaimModal.submitting}
                  />
                  2-leg transfer (between two bank accounts)
                </label>
                <label className="flex items-center gap-2 text-sm text-gray-200">
                  <input
                    type="radio"
                    name="transfer-expected-legs"
                    checked={transferClaimModal.expectedLegs === 1}
                    onChange={() =>
                      setTransferClaimModal((prev) => ({ ...prev, expectedLegs: 1, error: "" }))
                    }
                    disabled={transferClaimModal.submitting}
                  />
                  1-leg transfer (cash or external movement)
                </label>
              </div>
              {transferClaimModal.error && (
                <p className="text-xs text-red-400">{transferClaimModal.error}</p>
              )}
            </div>
            <div className="px-4 py-3 border-t border-charcoal-dark flex justify-end gap-2">
              <button
                type="button"
                onClick={closeTransferClaimModal}
                className="px-3 py-1.5 rounded-lg text-sm text-gray-400 hover:text-white transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleTransferClaimSubmit}
                disabled={transferClaimModal.submitting}
                className="px-3 py-1.5 rounded-lg text-sm bg-accent text-white hover:bg-accent-dark transition-colors disabled:opacity-60 inline-flex items-center gap-1.5"
              >
                {transferClaimModal.submitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                Claim Transfer
              </button>
            </div>
          </div>
        </div>
      )}
      {anchorModal.open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50"
          onClick={closeAnchorModal}
          role="dialog"
          aria-modal="true"
          aria-labelledby="statement-anchor-title"
        >
          <div
            className="w-full max-w-md rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark flex items-center justify-between">
              <h2 id="statement-anchor-title" className="text-white font-semibold">
                Set Statement Ending Balance
              </h2>
              <button
                type="button"
                onClick={closeAnchorModal}
                className="p-1 rounded-md text-gray-400 hover:text-white hover:bg-charcoal transition-colors"
                aria-label="Close modal"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-4 space-y-3">
              <p className="text-sm text-gray-300">
                Account: <span className="text-white">{selectedAccount}</span>
              </p>
              {anchorModal.loading ? (
                <div className="inline-flex items-center gap-2 text-sm text-gray-300">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Loading current balance...
                </div>
              ) : (
                <>
                  <div>
                    <label className="block text-xs text-gray-400 mb-1">Statement Ending Date</label>
                    <input
                      type="date"
                      value={anchorModal.date}
                      onChange={(e) =>
                        setAnchorModal((prev) => ({ ...prev, date: e.target.value }))
                      }
                      className="w-full px-3 py-2 rounded-lg bg-charcoal border border-charcoal-dark text-gray-200 text-sm focus:border-accent focus:ring-1 focus:ring-accent outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-400 mb-1">Confirmed Balance</label>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={anchorModal.balance}
                      onChange={(e) =>
                        setAnchorModal((prev) => ({ ...prev, balance: e.target.value }))
                      }
                      className="w-full px-3 py-2 rounded-lg bg-charcoal border border-charcoal-dark text-gray-200 text-sm focus:border-accent focus:ring-1 focus:ring-accent outline-none"
                    />
                  </div>
                </>
              )}
              {anchorModal.error && <p className="text-xs text-red-400">{anchorModal.error}</p>}
            </div>
            <div className="px-4 py-3 border-t border-charcoal-dark flex justify-end gap-2">
              <button
                type="button"
                onClick={closeAnchorModal}
                className="px-3 py-1.5 rounded-lg text-sm text-gray-400 hover:text-white transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSaveAnchor}
                disabled={anchorModal.loading || anchorModal.saving}
                className="px-3 py-1.5 rounded-lg text-sm bg-accent text-white hover:bg-accent-dark transition-colors disabled:opacity-60 inline-flex items-center gap-1.5"
              >
                {anchorModal.saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                Save Anchor
              </button>
            </div>
          </div>
        </div>
      )}
    </DashboardLayout>
  );
}
