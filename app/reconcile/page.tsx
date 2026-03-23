"use client";

import { useMemo, useState, useCallback, useEffect } from "react";
import Link from "next/link";
import { useDropzone } from "react-dropzone";
import Papa from "papaparse";
import { Check, Loader2, PlusCircle, Upload, X } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";
import { getExpenses, getTransfers, submitExpense } from "@/services/sheetsApi";
import { EXPENSE_TYPE_OPTIONS } from "@/lib/constants";
import { getLatestSnaptradeBalances } from "@/services/snaptradeApi";
import type { BankTransaction, MatchResult } from "@/services/reconciliationService";
import {
  computeAccountBalances,
  getAccountAnchors,
  mapAccountNameToBalanceKey,
} from "@/services/accountBalancesService";

type AccountOption = "Wells Fargo" | "Venmo - Daniel" | "Venmo - Katie";

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

type AnchorModalState = {
  open: boolean;
  date: string;
  balance: string;
  loading: boolean;
  saving: boolean;
  error: string;
};

const ACCOUNT_OPTIONS: AccountOption[] = ["Wells Fargo", "Venmo - Daniel", "Venmo - Katie"];
const RECONCILE_STORAGE_KEY = "reconcile-page-state-v3";

const SHEET_BASE_LINK = process.env.NEXT_PUBLIC_GOOGLE_SHEET_URL ?? "";

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
  const [selectedAccount, setSelectedAccount] = useState<AccountOption>("Wells Fargo");
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [matchesByAccount, setMatchesByAccount] = useState<Record<string, MatchResult[]>>({});
  const [activeTab, setActiveTab] = useState<string>(ACCOUNT_OPTIONS[0]);
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());
  const [approvedIds, setApprovedIds] = useState<Set<string>>(new Set());
  const [actionError, setActionError] = useState("");
  const [processingId, setProcessingId] = useState<string | null>(null);
  const [quickAdd, setQuickAdd] = useState<QuickAddState>({
    open: false,
    rowId: null,
    expenseType: "Misc.",
    amount: "",
    description: "",
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

  const allMatches = useMemo(
    () => Object.values(matchesByAccount).flat(),
    [matchesByAccount],
  );

  const inboxRows = useMemo(
    () =>
      allMatches.filter((match) => {
        const id = idForTx(match.bankTransaction);
        if (dismissedIds.has(id) || approvedIds.has(id)) return false;
        return match.matchType === "unmatched" || match.matchType === "questionable_match_fuzzy";
      }),
    [allMatches, dismissedIds, approvedIds],
  );

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
    [persistProcessedHash],
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

        const [sheetRows, sheetTransfers, processedHashesRes] = await Promise.all([
          getExpenses(),
          getTransfers(),
          fetch("/api/reconciliation/processed", { cache: "no-store" }),
        ]);
        if (!processedHashesRes.ok) {
          const err = await processedHashesRes.json().catch(() => ({ error: processedHashesRes.statusText }));
          throw new Error(err.error || "Failed to load processed hashes.");
        }
        const processedHashesData = (await processedHashesRes.json()) as { hashes?: string[] };
        const processedHashes = processedHashesData.hashes ?? [];

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
        const autoApprovable = data.matches.filter(
          (match) =>
            match.matchType !== "unmatched" &&
            match.matchType !== "questionable_match_fuzzy",
        );
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

  const activeMatches = matchesByAccount[activeTab] ?? [];

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
              onChange={(e) => setSelectedAccount(e.target.value as AccountOption)}
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

        <section className="rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden">
          <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark">
            <h2 className="text-white font-semibold">Unmatched or Questionable Transactions</h2>
          </div>
          <div className="p-3 text-sm">
            {inboxRows.length === 0 ? (
              <p className="text-gray-400">No unmatched or questionable rows right now.</p>
            ) : (
              <div className="space-y-2">
                {inboxRows.map((match, index) => {
                  const tx = match.bankTransaction;
                  const id = idForTx(tx);
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
                          ) : match.matchType === "questionable_match_fuzzy" && match.matchedSheetTransfer ? (
                            <>
                              <p className="text-yellow-300 text-sm truncate">
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
                            aria-label="Approve match"
                            title="Approve and mark processed"
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
                            className="p-1.5 rounded-md text-blue-300 hover:text-blue-200 hover:bg-blue-500/10 transition-colors"
                            aria-label="Quick add"
                            title="Quick add to sheet"
                          >
                            <PlusCircle className="w-4 h-4" />
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
          <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark flex items-center gap-2 overflow-x-auto">
            {tabAccounts.map((account) => (
              <button
                key={account}
                type="button"
                onClick={() => setActiveTab(account)}
                className={`px-3 py-1 rounded-md text-sm whitespace-nowrap transition-colors ${
                  activeTab === account
                    ? "bg-[#252525] text-white"
                    : "text-gray-400 hover:text-white"
                }`}
              >
                {account}
              </button>
            ))}
          </div>
          <div className="p-3 text-sm">
            {activeMatches.length === 0 ? (
              <p className="text-gray-400">Upload a CSV for this institution to view transaction history.</p>
            ) : (
              <div className="space-y-2">
                {activeMatches.map((match, index) => {
                  const tx = match.bankTransaction;
                  const id = idForTx(tx);
                  const isAutoMatched =
                    match.matchType !== "unmatched" &&
                    match.matchType !== "questionable_match_fuzzy";
                  const isMatched = isAutoMatched || approvedIds.has(id);
                  const isManualOnly = match.matchType === "unmatched" || dismissedIds.has(id);
                  const link = buildSheetLink(match.matchedSheetIndex);
                  return (
                    <div
                      key={`${id}-${index}`}
                      className="rounded-lg border border-charcoal-dark bg-[#2c2c2c] px-3 py-2"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-gray-200 truncate">{tx.description || "—"}</p>
                          <p className="text-xs text-gray-400 mt-0.5">
                            {fmtDate(tx.date)} • {fmtMoney(tx.amount)}
                          </p>
                          {isMatched && match.matchedSheetExpense && (
                            <p className="text-xs text-gray-500 mt-1 truncate">
                              Sheet: {match.matchedSheetExpense.expenseType ?? "—"} •{" "}
                              {match.matchedSheetExpense.description ?? "—"}
                              {match.matchedSheetExpense.account
                                ? ` • ${match.matchedSheetExpense.account}`
                                : ""}
                            </p>
                          )}
                          {isMatched && !match.matchedSheetExpense && match.matchedSheetTransfer && (
                            <p className="text-xs text-gray-500 mt-1 truncate">
                              Transfer: {match.matchedSheetTransfer.transferFrom ?? "—"} →{" "}
                              {match.matchedSheetTransfer.transferTo ?? "—"} •{" "}
                              {fmtDate(
                                match.matchedSheetTransfer.timestamp ??
                                  match.matchedSheetTransfer.date,
                              )}
                            </p>
                          )}
                        </div>
                        <div className="text-right shrink-0">
                          {isMatched ? (
                            <div className="text-green-300 text-xs font-medium">
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
                          ) : isManualOnly ? (
                            <span className="text-yellow-300 text-xs font-medium">Manual Only</span>
                          ) : (
                            <span className="text-gray-400 text-xs font-medium">Pending</span>
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
