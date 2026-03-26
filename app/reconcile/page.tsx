"use client";

import { useMemo, useState, useCallback, useEffect } from "react";
import Link from "next/link";
import { useDropzone } from "react-dropzone";
import Papa from "papaparse";
import { Check, Loader2, PlusCircle, Upload, X } from "lucide-react";
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
  sheetName: "Expenses";
  rowId: string;
  amount: number;
  expenseType: string;
  description: string;
  timestamp?: string;
  account?: string;
};

type SplitModalState = {
  open: boolean;
  rowId: string | null;
  selectedKeys: string[];
  candidates: SplitDraftLine[];
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
};

type AnchorModalState = {
  open: boolean;
  date: string;
  balance: string;
  loading: boolean;
  saving: boolean;
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
const CSV_PARSER_READY_ACCOUNTS = new Set<AccountOption>([
  "WF Checking",
  "WF Savings",
  "Venmo - Daniel",
  "Venmo - Katie",
]);
const RECONCILE_STORAGE_KEY = "reconcile-page-state-v3";

const SHEET_BASE_LINK = process.env.NEXT_PUBLIC_GOOGLE_SHEET_URL ?? "";

function claimKey(sheetName: string, rowId: string): string {
  return `${sheetName}:${rowId}`;
}

function idForTx(tx: BankTransaction): string {
  return `${tx.accountName}|${tx.hash}`;
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

function accountHasConfiguredParser(account: string): boolean {
  return CSV_PARSER_READY_ACCOUNTS.has(account as AccountOption);
}

function toCents(value: number): number {
  return Math.round(value * 100);
}

function buildSheetLink(index?: number): string | null {
  if (!SHEET_BASE_LINK || index === undefined || index < 0) return null;
  return `${SHEET_BASE_LINK}#gid=0&range=A${index + 2}`;
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
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());
  const [approvedIds, setApprovedIds] = useState<Set<string>>(new Set());
  const [actionError, setActionError] = useState("");
  const [processingId, setProcessingId] = useState<string | null>(null);
  const [sheetExpenses, setSheetExpenses] = useState<SheetRow[]>([]);
  const [sheetTransfers, setSheetTransfers] = useState<TransferRow[]>([]);
  const [claimedRowKeys, setClaimedRowKeys] = useState<Set<string>>(new Set());
  const [transferClaimStatusByRowId, setTransferClaimStatusByRowId] =
    useState<TransferClaimStatusByRowId>({});
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

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(RECONCILE_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as {
        selectedAccount?: string;
        activeTab?: string;
        matchesByAccount?: Record<string, MatchResult[]>;
        dismissedIds?: string[];
        approvedIds?: string[];
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
        setMatchesByAccount(parsed.matchesByAccount);
      }
      if (Array.isArray(parsed.dismissedIds)) {
        setDismissedIds(new Set(parsed.dismissedIds.map((id) => String(id))));
      }
      if (Array.isArray(parsed.approvedIds)) {
        setApprovedIds(new Set(parsed.approvedIds.map((id) => String(id))));
      }
    } catch {
      // Ignore corrupted local storage and continue with empty in-memory state.
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const payload = {
      selectedAccount,
      activeTab,
      matchesByAccount,
      dismissedIds: Array.from(dismissedIds),
      approvedIds: Array.from(approvedIds),
    };
    try {
      window.localStorage.setItem(RECONCILE_STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // Ignore storage quota/security errors; page still works in-memory.
    }
  }, [activeTab, approvedIds, dismissedIds, matchesByAccount, selectedAccount]);

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

  const tabAccounts = useMemo(
    () => {
      const uploaded = Object.keys(matchesByAccount);
      const merged = [...ACCOUNT_OPTIONS];
      for (const account of uploaded) {
        if (!merged.includes(account as AccountOption)) merged.push(account as AccountOption);
      }
      return merged;
    },
    [matchesByAccount],
  );

  const statementRowsByAccount = useMemo(() => {
    const byAccount: Record<string, MatchResult[]> = {};
    tabAccounts.forEach((account) => {
      byAccount[account] = sortByNewestDate(
        matchesByAccount[account] ?? [],
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
        if (dismissedIds.has(id) || approvedIds.has(id)) return false;
        return isStatementManualReview(match);
      });
    });
    return byAccount;
  }, [dismissedIds, approvedIds, statementRowsByAccount, tabAccounts]);

  const statementCompletedRowsByAccount = useMemo(() => {
    const byAccount: Record<string, MatchResult[]> = {};
    tabAccounts.forEach((account) => {
      byAccount[account] = statementRowsByAccount[account].filter((match) => {
        const id = idForTx(match.bankTransaction);
        return match.matchType === "exact_match" || approvedIds.has(id);
      });
    });
    return byAccount;
  }, [approvedIds, statementRowsByAccount, tabAccounts]);

  const accountDetailRows = useMemo(
    () => [
      ...(statementReviewRowsByAccount[activeTab] ?? []),
      ...(statementCompletedRowsByAccount[activeTab] ?? []),
    ],
    [activeTab, statementCompletedRowsByAccount, statementReviewRowsByAccount],
  );

  const userInputtedEntries = useMemo(() => {
    const expenseEntries: UserInputtedEntry[] = sheetExpenses.map((row, index) => {
      const rowId = (row.rowId ?? "").trim();
      const key = rowId ? claimKey("Expenses", rowId) : `Expenses:missing:${index}`;
      const claimed = rowId ? claimedRowKeys.has(claimKey("Expenses", rowId)) : false;
      const dateValue = row.timestamp ?? "";
      return {
        id: key,
        source: "Expenses",
        dateValue,
        title: row.description || row.expenseType || "Expense row",
        subtitle: `${row.account ?? "No account"} • ${fmtDate(dateValue)}`,
        amount: Number(row.amount ?? 0),
        isCompleted: claimed,
      };
    });

    const transferEntries: UserInputtedEntry[] = sheetTransfers.map((row, index) => {
      const rowId = (row.transferRowId ?? "").trim();
      const status = rowId ? transferClaimStatusByRowId[rowId] : undefined;
      const dateValue = row.timestamp ?? "";
      const title = `${row.transferFrom || "—"} → ${row.transferTo || "—"}`;
      return {
        id: rowId ? `Transfers:${rowId}` : `Transfers:missing:${index}`,
        source: "Transfers",
        dateValue,
        title,
        subtitle: `Transfer • ${fmtDate(dateValue)}`,
        amount: Number(row.amount ?? 0),
        isCompleted: Boolean(status?.isComplete),
      };
    });

    return sortByNewestDate([...expenseEntries, ...transferEntries], (entry) => entry.dateValue);
  }, [claimedRowKeys, sheetExpenses, sheetTransfers, transferClaimStatusByRowId]);

  const userInputtedReviewRows = useMemo(
    () => userInputtedEntries.filter((entry) => !entry.isCompleted),
    [userInputtedEntries],
  );
  const userInputtedCompletedRows = useMemo(
    () => userInputtedEntries.filter((entry) => entry.isCompleted),
    [userInputtedEntries],
  );

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
      const [freshSheetRows, claimsRes] = await Promise.all([
        getExpenses(),
        fetch("/api/reconciliation/claims", { cache: "no-store" }),
      ]);
      if (!claimsRes.ok) {
        const err = await claimsRes.json().catch(() => ({ error: claimsRes.statusText }));
        throw new Error(err.error || "Failed to load claimed sheet rows.");
      }
      const claimsData = (await claimsRes.json()) as { claimedRowIds?: string[] };
      const claimedRows = new Set((claimsData.claimedRowIds ?? []).map((id) => String(id)));

      setSheetExpenses(freshSheetRows);
      setClaimedRowKeys(claimedRows);

      const availableCandidates = freshSheetRows
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
            account: row.account,
          };
        });

      setSplitModal({
        open: true,
        rowId: idForTx(tx),
        selectedKeys: [],
        candidates: availableCandidates,
        submitting: false,
        error: "",
      });
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

      setActionError("");
      setProcessingId(id);
      try {
        await persistProcessedHash(tx);
        setApprovedIds((prev) => new Set(prev).add(id));
      } catch (err) {
        setActionError(err instanceof Error ? err.message : "Failed to approve transaction.");
      } finally {
        setProcessingId(null);
      }
    },
    [openTransferClaimModal, persistProcessedHash],
  );

  const handleDismiss = useCallback((match: MatchResult) => {
    const id = idForTx(match.bankTransaction);
    setDismissedIds((prev) => new Set(prev).add(id));
  }, []);

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
      setApprovedIds((prev) => new Set(prev).add(quickAdd.rowId as string));
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

  const selectedClaimRows = useMemo(
    () => splitModal.candidates.filter((row) => splitModal.selectedKeys.includes(row.key)),
    [splitModal.candidates, splitModal.selectedKeys],
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
      setClaimedRowKeys((prev) => {
        const next = new Set(prev);
        selectedRows.forEach((row) => next.add(row.key));
        return next;
      });
      setApprovedIds((prev) => new Set(prev).add(splitModal.rowId as string));
      closeSplitModal();
    } catch (err) {
      setSplitModal((prev) => ({
        ...prev,
        submitting: false,
        error: err instanceof Error ? err.message : "Failed to claim selected rows.",
      }));
    }
  }, [allMatches, closeSplitModal, splitModal]);

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
      setTransferClaimStatusByRowId((prev) => ({
        ...prev,
        [transferRowId]: {
          expectedLegs: payload.expectedLegs === 1 ? 1 : 2,
          claimedCount: Number(payload.claimedCount ?? 1),
          isComplete: Boolean(payload.isComplete),
        },
      }));
      setApprovedIds((prev) => new Set(prev).add(transferClaimModal.rowId as string));
      closeTransferClaimModal();
    } catch (err) {
      setTransferClaimModal((prev) => ({
        ...prev,
        submitting: false,
        error: err instanceof Error ? err.message : "Failed to claim transfer.",
      }));
    }
  }, [allMatches, closeTransferClaimModal, transferClaimModal]);

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

        const [sheetRows, sheetTransfers, processedHashesRes, claimsRes, transferClaimsRes] = await Promise.all([
          getExpenses(),
          getTransfers(),
          fetch("/api/reconciliation/processed", { cache: "no-store" }),
          fetch("/api/reconciliation/claims", { cache: "no-store" }),
          fetch("/api/reconciliation/transfer-claims", { cache: "no-store" }),
        ]);
        if (!processedHashesRes.ok) {
          const err = await processedHashesRes.json().catch(() => ({ error: processedHashesRes.statusText }));
          throw new Error(err.error || "Failed to load processed hashes.");
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
            rows: parsedRows,
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
        const autoApprovable = data.matches.filter((match) => match.matchType === "exact_match");
        const autoApprovedIds: string[] = [];
        const autoApprovalErrors: string[] = [];
        await Promise.all(
          autoApprovable.map(async (match) => {
            try {
              await persistProcessedHash(match.bankTransaction);
              autoApprovedIds.push(idForTx(match.bankTransaction));
            } catch (err) {
              autoApprovalErrors.push(
                err instanceof Error
                  ? err.message
                  : `Failed to auto-approve ${match.bankTransaction.description || "transaction"}.`,
              );
            }
          }),
        );

        setMatchesByAccount((prev) => ({
          ...prev,
          [selectedAccount]: data.matches,
        }));
        if (autoApprovedIds.length > 0) {
          setApprovedIds((prev) => {
            const next = new Set(prev);
            autoApprovedIds.forEach((id) => next.add(id));
            return next;
          });
        }
        if (autoApprovalErrors.length > 0) {
          setActionError(autoApprovalErrors[0]);
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

  const activeReviewRows = statementReviewRowsByAccount[activeTab] ?? [];
  const activeCompletedRows = statementCompletedRowsByAccount[activeTab] ?? [];

  return (
    <DashboardLayout>
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h1 className="text-2xl font-semibold text-white">Reconcile</h1>
          <div className="flex items-center gap-2 flex-wrap justify-end">
            <button
              type="button"
              onClick={openAnchorModal}
              className="px-3 py-1.5 rounded-lg bg-[#252525] border border-charcoal-dark text-gray-200 text-sm hover:text-white hover:bg-[#2d2d2d] transition-colors"
            >
              Set Statement Ending Balance
            </button>
            <label className="text-sm text-gray-300">Account</label>
            <select
              value={selectedAccount}
              onChange={(e) => {
                const account = e.target.value as AccountOption;
                setSelectedAccount(account);
                setActiveTab(account);
              }}
              className="px-3 py-1.5 rounded-lg bg-charcoal border border-charcoal-dark text-gray-200 text-sm focus:border-accent focus:ring-1 focus:ring-accent outline-none"
            >
              {ACCOUNT_OPTIONS.map((account) => (
                <option key={account} value={account}>
                  {account}
                </option>
              ))}
            </select>
          </div>
        </div>

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

        {(uploadError || actionError) && (
          <div className="rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 px-4 py-2 text-sm">
            {uploadError || actionError}
          </div>
        )}

        {viewMode === "home" ? (
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-4">
              <section className="rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden">
                <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark">
                  <h2 className="text-white font-semibold">User-inputted: Unmatched / Questionable</h2>
                </div>
                <div className="p-3 text-sm">
                  {userInputtedReviewRows.length === 0 ? (
                    <p className="text-gray-400">No unmatched or questionable user-inputted transactions.</p>
                  ) : (
                    <div className="space-y-2">
                      {userInputtedReviewRows.map((entry) => (
                        <div
                          key={entry.id}
                          className="rounded-lg border border-charcoal-dark bg-[#2c2c2c] px-3 py-2"
                        >
                          <p className="text-gray-200 truncate">{entry.title}</p>
                          <p className="text-xs text-gray-400 mt-0.5">
                            {entry.source} • {entry.subtitle} • {fmtMoney(entry.amount)}
                          </p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </section>

              <section className="rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden">
                <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark">
                  <h2 className="text-white font-semibold">User-inputted: Completed</h2>
                </div>
                <div className="p-3 text-sm">
                  {userInputtedCompletedRows.length === 0 ? (
                    <p className="text-gray-400">No completed user-inputted transactions yet.</p>
                  ) : (
                    <div className="space-y-2">
                      {userInputtedCompletedRows.map((entry) => (
                        <div
                          key={entry.id}
                          className="rounded-lg border border-charcoal-dark bg-[#2c2c2c] px-3 py-2"
                        >
                          <p className="text-gray-200 truncate">{entry.title}</p>
                          <p className="text-xs text-gray-400 mt-0.5">
                            {entry.source} • {entry.subtitle} • {fmtMoney(entry.amount)}
                          </p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </section>
            </div>

            <section className="rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden">
              <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark">
                <h2 className="text-white font-semibold">Statement Accounts: Unmatched / Questionable</h2>
              </div>
              <div className="p-3 text-sm space-y-3">
                {tabAccounts.map((account) => {
                  const rows = statementReviewRowsByAccount[account] ?? [];
                  const remainingCount = rows.length > 3 ? rows.length - 3 : 0;
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
                        {rows.length} row{rows.length === 1 ? "" : "s"} needing review
                      </p>
                      {rows.length === 0 && !hasParser && (
                        <p className="text-[11px] text-yellow-300/90 mt-1">
                          Statement CSV parser not configured yet for this account.
                        </p>
                      )}
                      {rows.length > 0 && (
                        <div className="mt-2 space-y-1.5">
                          {rows.slice(0, 3).map((match, idx) => (
                            <div key={`${idForTx(match.bankTransaction)}-${idx}`} className="text-xs text-gray-300">
                              {fmtDate(match.bankTransaction.date)} • {match.bankTransaction.description || "—"} •{" "}
                              {fmtMoney(match.bankTransaction.amount)}
                            </div>
                          ))}
                          {remainingCount > 0 && (
                            <p className="text-[11px] text-gray-500">+{remainingCount} more</p>
                          )}
                        </div>
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
                <h2 className="text-white font-semibold">{activeTab}: Unmatched / Questionable</h2>
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
                                onClick={() => handleDismiss(match)}
                                className="p-1.5 rounded-md text-red-300 hover:text-red-200 hover:bg-red-500/10 transition-colors"
                                aria-label="Dismiss"
                                title="Dismiss"
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
              <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark">
                <h2 className="text-white font-semibold">{activeTab}: Completed / Matched</h2>
              </div>
              <div className="p-3 text-sm">
                {activeCompletedRows.length === 0 ? (
                  <p className="text-gray-400">No completed matches yet for this account.</p>
                ) : (
                  <div className="space-y-2">
                    {activeCompletedRows.map((match, index) => {
                      const tx = match.bankTransaction;
                      const link = buildSheetLink(match.matchedSheetIndex);
                      return (
                        <div
                          key={`${idForTx(tx)}-${index}`}
                          className="rounded-lg border border-charcoal-dark bg-[#2c2c2c] px-3 py-2"
                        >
                          <div className="flex items-center justify-between gap-3">
                            <div className="min-w-0">
                              <p className="text-gray-200 truncate">{tx.description || "—"}</p>
                              <p className="text-xs text-gray-400 mt-0.5">
                                {fmtDate(tx.date)} • {fmtMoney(tx.amount)}
                              </p>
                            </div>
                            <div className="text-right shrink-0 text-green-300 text-xs font-medium">
                              Matched
                              {link ? (
                                <Link href={link} target="_blank" className="ml-2 underline text-blue-300">
                                  Sheet entry
                                </Link>
                              ) : (
                                <Link href="/budget" className="ml-2 underline text-blue-300">
                                  Budget entry
                                </Link>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </section>

            {accountDetailRows.length > 0 && (
              <p className="text-xs text-gray-500">
                Showing {activeReviewRows.length} unmatched/questionable and {activeCompletedRows.length} completed
                rows for {activeTab}.
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

              <div className="max-h-[50vh] overflow-auto rounded-md border border-charcoal-dark bg-charcoal">
                {splitModal.candidates.length === 0 ? (
                  <p className="px-3 py-2 text-sm text-gray-400">
                    No unclaimed expense rows with a Row ID are available.
                  </p>
                ) : (
                  <div className="divide-y divide-charcoal-dark">
                    {splitModal.candidates.map((row) => {
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
                            <p className="text-sm text-gray-200 truncate">
                              {row.expenseType || "—"} • {row.description || "—"}
                            </p>
                            <p className="text-xs text-gray-400 mt-0.5">
                              {fmtMoney(row.amount)}
                              {row.timestamp ? ` • ${fmtDate(row.timestamp)}` : ""}
                              {row.account ? ` • ${row.account}` : ""}
                            </p>
                            <p className="text-[11px] text-gray-500 mt-0.5">
                              Row ID: {row.rowId}
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
