"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useRef,
  type ReactNode,
} from "react";
import { useRefresh } from "@/contexts/RefreshContext";
import { getExpenses, getTransfers } from "@/services/sheetsApi";
import type { SheetRow, TransferRow } from "@/services/sheetsApi";

type ExpensesDataContextType = {
  allRows: SheetRow[];
  allTransfers: TransferRow[];
  loading: boolean;
  error: string | null;
};

const ExpensesDataContext = createContext<ExpensesDataContextType | null>(null);

/**
 * Fetches full-year expenses and transfers once (no month filter) and keeps them in memory.
 * Pages filter by selectedMonth client-side for instant month/page switching.
 */
export function ExpensesDataProvider({ children }: { children: ReactNode }) {
  const { refreshKey } = useRefresh();
  const [allRows, setAllRows] = useState<SheetRow[]>([]);
  const [allTransfers, setAllTransfers] = useState<TransferRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const initialLoadDone = useRef(false);

  useEffect(() => {
    let cancelled = false;
    if (!initialLoadDone.current) {
      setLoading(true);
      setError(null);
    }
    Promise.all([getExpenses(), getTransfers()])
      .then(([rows, transfers]) => {
        if (!cancelled) {
          setAllRows(rows);
          setAllTransfers(transfers);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load");
      })
      .finally(() => {
        if (!cancelled) {
          initialLoadDone.current = true;
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  return (
    <ExpensesDataContext.Provider
      value={{ allRows, allTransfers, loading, error }}
    >
      {children}
    </ExpensesDataContext.Provider>
  );
}

export function useExpensesData() {
  const ctx = useContext(ExpensesDataContext);
  if (!ctx) throw new Error("useExpensesData must be used within ExpensesDataProvider");
  return ctx;
}
