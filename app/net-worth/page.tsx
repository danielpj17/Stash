"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import MonthDropdown from "@/components/MonthDropdown";
import { useMonth } from "@/contexts/MonthContext";
import { useRefresh } from "@/contexts/RefreshContext";
import { useExpensesData } from "@/contexts/ExpensesDataContext";
import { rowMatchesMonth } from "@/services/sheetsApi";
import { getNetWorthSummary, type NetWorthSummary } from "@/services/netWorthService";
import {
  getSnaptradeHistory,
  getSnaptradeInvestments,
  getLatestSnaptradeBalances,
  refreshSnaptradeBalances,
  type RefreshSnaptradeBalancesResponse,
} from "@/services/snaptradeApi";
import { computeAccountBalances } from "@/services/accountBalancesService";
import {
  ASSET_CATEGORIES,
  LIABILITY_CATEGORIES,
  PIE_COLORS,
} from "@/lib/constants";
import {
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  Tooltip,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
} from "recharts";

type ManualItem = {
  id: string;
  name: string;
  value: number;
  category: string;
  acquisition_date?: string | null;
  details?: Record<string, unknown>;
  updated_at?: string;
};

type EditingState = {
  id: string;
  name: string;
  value: string;
  category: string;
};

type ManualFormState = {
  id?: string;
  name: string;
  value: string;
  category: string;
  acquisitionDate: string;
  details: Record<string, string>;
};

type GrowthPoint = {
  month: string;
  label: string;
  sheetsNetChange: number | null;
  fidelityValue: number | null;
};

const fmtCurrency = (n: number) =>
  "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function parseMonthFromRow(row: { month?: string; timestamp?: string }): string | null {
  if (row.timestamp) {
    const d = new Date(row.timestamp);
    if (!Number.isNaN(d.getTime())) {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      return `${y}-${m}`;
    }
  }

  const raw = String(row.month ?? "").trim().toLowerCase();
  if (!raw) return null;

  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric >= 1 && numeric <= 12) {
    return `2026-${String(numeric).padStart(2, "0")}`;
  }

  const monthNames = [
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
  ];

  for (let i = 0; i < monthNames.length; i += 1) {
    if (!raw.includes(monthNames[i])) continue;
    const parsedYear = Number(raw.replace(/[^0-9]/g, ""));
    const year = Number.isFinite(parsedYear) && parsedYear > 1900 ? parsedYear : 2026;
    return `${year}-${String(i + 1).padStart(2, "0")}`;
  }

  return null;
}

function lastSixMonthKeys(): string[] {
  const out: string[] = [];
  const d = new Date();
  d.setDate(1);
  for (let i = 5; i >= 0; i -= 1) {
    const x = new Date(d.getFullYear(), d.getMonth() - i, 1);
    out.push(`${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

function monthLabel(key: string): string {
  const [year, month] = key.split("-");
  const d = new Date(Number(year), Number(month) - 1, 1);
  return d.toLocaleDateString("en-US", { month: "short" });
}

function formatDateLabel(isoDate: string): string {
  const d = new Date(isoDate);
  if (Number.isNaN(d.getTime())) return "Unknown";
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "2-digit",
  });
}

function formatAcquiredDate(dateValue?: string | null): string {
  if (!dateValue) return "—";
  const parsed = new Date(dateValue);
  if (Number.isNaN(parsed.getTime())) return dateValue;
  return parsed.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

async function fetchManualItems(url: string): Promise<ManualItem[]> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `Failed to fetch ${url}`);
  }
  const data = (await res.json()) as Array<Partial<ManualItem>>;
  return Array.isArray(data)
    ? data.map((item) => ({
        id: String(item.id ?? ""),
        name: String(item.name ?? ""),
        value: Number(item.value ?? 0),
        category: String(item.category ?? ""),
        acquisition_date:
          typeof item.acquisition_date === "string"
            ? item.acquisition_date
            : typeof (item as { acquisitionDate?: unknown }).acquisitionDate === "string"
              ? String((item as { acquisitionDate?: unknown }).acquisitionDate)
              : null,
        details:
          item.details && typeof item.details === "object" && !Array.isArray(item.details)
            ? (item.details as Record<string, unknown>)
            : {},
        updated_at: item.updated_at ? String(item.updated_at) : undefined,
      }))
    : [];
}

export default function NetWorthPage() {
  const { selectedMonth } = useMonth();
  const { triggerRefresh } = useRefresh();
  const { allRows, allTransfers, loading: expensesLoading, error: expensesError } = useExpensesData();

  const [summary, setSummary] = useState<NetWorthSummary | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);

  const [assets, setAssets] = useState<ManualItem[]>([]);
  const [liabilities, setLiabilities] = useState<ManualItem[]>([]);
  const [tableError, setTableError] = useState<string | null>(null);
  const [tableLoading, setTableLoading] = useState(true);

  const [activeManualTab, setActiveManualTab] = useState<"assets" | "liabilities">("assets");
  const [manualModalOpen, setManualModalOpen] = useState(false);
  const [manualFormMode, setManualFormMode] = useState<"create" | "edit">("create");
  const [manualFormTab, setManualFormTab] = useState<"assets" | "liabilities">("assets");
  const [manualForm, setManualForm] = useState<ManualFormState>({
    name: "",
    value: "",
    category: ASSET_CATEGORIES[0],
    acquisitionDate: "",
    details: {},
  });
  const [savingRow, setSavingRow] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const [goalTarget, setGoalTarget] = useState<number>(100000);
  const [historySource, setHistorySource] = useState<"experimental" | "snapshots" | "none">("none");
  const [fidelityHistory, setFidelityHistory] = useState<Array<{ date: string; value: number }>>([]);
  const [investments, setInvestments] = useState<{
    brokerage: number;
    rothIra: number;
    fidelityTotal: number;
    fetchedAt: string | null;
  }>({
    brokerage: 0,
    rothIra: 0,
    fidelityTotal: 0,
    fetchedAt: null,
  });
  const [latestBrokerBalances, setLatestBrokerBalances] = useState<Partial<
    Record<"Fidelity" | "Robinhood" | "Charles Schwab", number>
  >>({});

  const summaryReqRef = useRef(0);
  const tableReqRef = useRef(0);
  const historyReqRef = useRef(0);
  const investmentsReqRef = useRef(0);
  const balancesReqRef = useRef(0);

  const filteredRows = useMemo(
    () => allRows.filter((row) => rowMatchesMonth(row, selectedMonth)),
    [allRows, selectedMonth]
  );

  const incomeBreakdown = useMemo(() => {
    const bySource: Record<string, number> = {};
    filteredRows
      .filter((row) => row.expenseType.trim().toLowerCase() === "income")
      .forEach((row) => {
        const source = row.description.trim() || "Unlabeled Income";
        bySource[source] = (bySource[source] ?? 0) + Number(row.amount || 0);
      });
    return Object.entries(bySource)
      .map(([source, amount]) => ({ source, amount }))
      .sort((a, b) => b.amount - a.amount);
  }, [filteredRows]);

  const sheetsHistoryByMonth = useMemo<Record<string, number>>(() => {
    const incomeByMonth: Record<string, number> = {};
    const expensesByMonth: Record<string, number> = {};
    allRows.forEach((row) => {
      const key = parseMonthFromRow(row);
      if (!key) return;
      const amount = Number(row.amount || 0);
      if (!Number.isFinite(amount)) return;

      if (row.expenseType.trim().toLowerCase() === "income") {
        incomeByMonth[key] = (incomeByMonth[key] ?? 0) + amount;
      } else {
        expensesByMonth[key] = (expensesByMonth[key] ?? 0) + amount;
      }
    });
    const out: Record<string, number> = {};
    Object.keys({ ...incomeByMonth, ...expensesByMonth }).forEach((key) => {
      out[key] = (incomeByMonth[key] ?? 0) - (expensesByMonth[key] ?? 0);
    });
    return out;
  }, [allRows]);

  const fidelityHistoryByMonth = useMemo<Record<string, number>>(() => {
    const out: Record<string, number> = {};
    const sorted = [...fidelityHistory].sort((a, b) => a.date.localeCompare(b.date));
    for (const point of sorted) {
      const d = new Date(point.date);
      if (Number.isNaN(d.getTime())) continue;
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      out[key] = point.value;
    }
    return out;
  }, [fidelityHistory]);

  const trendData = useMemo<GrowthPoint[]>(() => {
    const defaultKeys = lastSixMonthKeys();
    const dynamicKeys = Object.keys({ ...sheetsHistoryByMonth, ...fidelityHistoryByMonth });
    const keys = [...new Set([...defaultKeys, ...dynamicKeys])]
      .sort((a, b) => a.localeCompare(b))
      .slice(-12);
    return keys.map((key) => ({
      month: key,
      label: monthLabel(key),
      sheetsNetChange:
        sheetsHistoryByMonth[key] !== undefined ? Number(sheetsHistoryByMonth[key]) : null,
      fidelityValue:
        fidelityHistoryByMonth[key] !== undefined ? Number(fidelityHistoryByMonth[key]) : null,
    }));
  }, [sheetsHistoryByMonth, fidelityHistoryByMonth]);

  const fidelityLatestPoint = useMemo(() => {
    const value = Number(latestBrokerBalances.Fidelity ?? 0);
    if (!Number.isFinite(value) || value <= 0) return null;
    const now = new Date();
    const key = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    return {
      month: key,
      label: monthLabel(key),
      sheetsNetChange:
        sheetsHistoryByMonth[key] !== undefined ? Number(sheetsHistoryByMonth[key]) : null,
      fidelityValue: value,
    } satisfies GrowthPoint;
  }, [latestBrokerBalances.Fidelity, sheetsHistoryByMonth]);

  const trendDataWithLatest = useMemo(() => {
    if (!fidelityLatestPoint) return trendData;
    const next = [...trendData];
    const idx = next.findIndex((point) => point.month === fidelityLatestPoint.month);
    if (idx >= 0) {
      next[idx] = { ...next[idx], fidelityValue: fidelityLatestPoint.fidelityValue };
      return next;
    }
    return [...next, fidelityLatestPoint].sort((a, b) => a.month.localeCompare(b.month));
  }, [trendData, fidelityLatestPoint]);

  const accountBalances = useMemo(
    () => computeAccountBalances(allRows, allTransfers, latestBrokerBalances),
    [allRows, allTransfers, latestBrokerBalances]
  );
  const visibleAccountBalances = useMemo(
    () => Object.entries(accountBalances).filter(([, value]) => Math.abs(Number(value)) >= 0.005),
    [accountBalances]
  );
  const allAccountBalancesTotal = useMemo(
    () => Object.values(accountBalances).reduce((sum, value) => sum + Number(value || 0), 0),
    [accountBalances]
  );
  const latestBrokerBalancesTotal = useMemo(
    () => Object.values(latestBrokerBalances).reduce((sum, value) => sum + Number(value || 0), 0),
    [latestBrokerBalances]
  );

  const averageMonthlyExpenses = useMemo(() => {
    if (trendDataWithLatest.length === 0) return 0;
    const keys = new Set(trendDataWithLatest.map((point) => point.month));
    const expenseByMonth: Record<string, number> = {};
    allRows.forEach((row) => {
      if (row.expenseType.trim().toLowerCase() === "income") return;
      const key = parseMonthFromRow(row);
      if (!key || !keys.has(key)) return;
      expenseByMonth[key] = (expenseByMonth[key] ?? 0) + Number(row.amount || 0);
    });
    const totals = trendDataWithLatest.map((point) => expenseByMonth[point.month] ?? 0);
    const sum = totals.reduce((acc, v) => acc + v, 0);
    return totals.length ? sum / totals.length : 0;
  }, [allRows, trendDataWithLatest]);

  const loadSummary = useCallback(async () => {
    const reqId = ++summaryReqRef.current;
    setSummaryLoading(true);
    setSummaryError(null);
    try {
      const data = await getNetWorthSummary(selectedMonth);
      if (reqId !== summaryReqRef.current) return;
      setSummary(data);
    } catch (err) {
      if (reqId !== summaryReqRef.current) return;
      setSummaryError(err instanceof Error ? err.message : "Failed to load net worth summary");
    } finally {
      if (reqId !== summaryReqRef.current) return;
      setSummaryLoading(false);
    }
  }, [selectedMonth]);

  const loadManualTables = useCallback(async () => {
    const reqId = ++tableReqRef.current;
    setTableLoading(true);
    setTableError(null);
    try {
      const [assetData, liabilityData] = await Promise.all([
        fetchManualItems("/api/assets"),
        fetchManualItems("/api/liabilities"),
      ]);
      if (reqId !== tableReqRef.current) return;
      setAssets(assetData);
      setLiabilities(liabilityData);
    } catch (err) {
      if (reqId !== tableReqRef.current) return;
      setTableError(err instanceof Error ? err.message : "Failed to load assets/liabilities");
    } finally {
      if (reqId !== tableReqRef.current) return;
      setTableLoading(false);
    }
  }, []);

  const loadFidelityHistory = useCallback(async () => {
    const reqId = ++historyReqRef.current;
    try {
      const data = await getSnaptradeHistory();
      if (reqId !== historyReqRef.current) return;
      setFidelityHistory(data.points);
      setHistorySource(data.source);
    } catch (err) {
      if (reqId !== historyReqRef.current) return;
      console.error("Failed to load Fidelity history:", err);
      setFidelityHistory([]);
      setHistorySource("none");
    }
  }, []);

  const loadInvestments = useCallback(async () => {
    const reqId = ++investmentsReqRef.current;
    try {
      const data = await getSnaptradeInvestments();
      if (reqId !== investmentsReqRef.current) return;
      setInvestments(data);
    } catch (err) {
      if (reqId !== investmentsReqRef.current) return;
      console.error("Failed to load investments:", err);
      setInvestments({
        brokerage: 0,
        rothIra: 0,
        fidelityTotal: 0,
        fetchedAt: null,
      });
    }
  }, []);

  const loadLatestBrokerBalances = useCallback(async () => {
    const reqId = ++balancesReqRef.current;
    try {
      const data: RefreshSnaptradeBalancesResponse = await getLatestSnaptradeBalances();
      if (reqId !== balancesReqRef.current) return;
      setLatestBrokerBalances(data.balances ?? {});
      // Keep investments widget synchronized with latest pull even if historical rows were old schema.
      if (
        data.investments?.fidelityTotal > 0 ||
        Number(data.balances?.Fidelity ?? 0) > 0
      ) {
        const total =
          Number(data.investments?.fidelityTotal ?? 0) > 0
            ? Number(data.investments.fidelityTotal)
            : Number(data.balances?.Fidelity ?? 0);
        const brokerage =
          Number(data.investments?.brokerage ?? 0) + Number(data.investments?.rothIra ?? 0) > 0
            ? Number(data.investments?.brokerage ?? 0)
            : total;
        const rothIra =
          Number(data.investments?.brokerage ?? 0) + Number(data.investments?.rothIra ?? 0) > 0
            ? Number(data.investments?.rothIra ?? 0)
            : 0;
        setInvestments((prev) => ({
          brokerage,
          rothIra,
          fidelityTotal: total,
          fetchedAt: data.fetchedAt ?? prev.fetchedAt,
        }));
      }
    } catch (err) {
      if (reqId !== balancesReqRef.current) return;
      console.error("Failed to load latest broker balances:", err);
    }
  }, []);

  useEffect(() => {
    loadSummary();
  }, [loadSummary]);

  useEffect(() => {
    loadManualTables();
  }, [loadManualTables]);

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    setSummaryError(null);
    setTableError(null);
    triggerRefresh();
    try {
      await refreshSnaptradeBalances();
      await Promise.all([
        loadSummary(),
        loadManualTables(),
        loadFidelityHistory(),
        loadInvestments(),
        loadLatestBrokerBalances(),
      ]);
    } finally {
      setIsRefreshing(false);
    }
  }, [triggerRefresh, loadSummary, loadManualTables, loadFidelityHistory, loadInvestments, loadLatestBrokerBalances]);

  useEffect(() => {
    loadFidelityHistory();
    loadInvestments();
    loadLatestBrokerBalances();
  }, [loadFidelityHistory, loadInvestments, loadLatestBrokerBalances]);

  const adjustedLiquidNetWorth = useMemo(() => {
    if (!summary) return 0;
    const delta = allAccountBalancesTotal - latestBrokerBalancesTotal;
    return summary.liquidNetWorth + delta;
  }, [summary, allAccountBalancesTotal, latestBrokerBalancesTotal]);

  const adjustedTotalNetWorth = useMemo(() => {
    if (!summary) return 0;
    const delta = allAccountBalancesTotal - latestBrokerBalancesTotal;
    return summary.totalNetWorth + delta;
  }, [summary, allAccountBalancesTotal, latestBrokerBalancesTotal]);

  const liquidityRatio = useMemo(() => {
    if (!summary) return 0;
    const liabilitiesTotal = latestBrokerBalancesTotal - summary.liquidNetWorth;
    const liquidAssets = adjustedLiquidNetWorth + liabilitiesTotal;
    if (averageMonthlyExpenses <= 0) return 0;
    return liquidAssets / averageMonthlyExpenses;
  }, [summary, latestBrokerBalancesTotal, adjustedLiquidNetWorth, averageMonthlyExpenses]);

  const runwayMonths = useMemo(() => {
    if (!summary || summary.spending <= 0) return 0;
    return adjustedLiquidNetWorth / summary.spending;
  }, [summary, adjustedLiquidNetWorth]);

  const savingsRate = useMemo(() => {
    if (!summary || summary.earning <= 0) return 0;
    return (summary.saving / summary.earning) * 100;
  }, [summary]);

  const goalProgress = useMemo(() => {
    if (!summary || goalTarget <= 0) return 0;
    return Math.max(0, (adjustedTotalNetWorth / goalTarget) * 100);
  }, [summary, adjustedTotalNetWorth, goalTarget]);

  const resetManualForm = useCallback((tab: "assets" | "liabilities") => {
    setManualForm({
      name: "",
      value: "",
      category: tab === "assets" ? ASSET_CATEGORIES[0] : LIABILITY_CATEGORIES[0],
      acquisitionDate: "",
      details: {},
    });
  }, []);

  const openCreateModal = (tab: "assets" | "liabilities") => {
    setManualFormMode("create");
    setManualFormTab(tab);
    resetManualForm(tab);
    setManualModalOpen(true);
  };

  const openEditModal = (item: ManualItem, tab: "assets" | "liabilities") => {
    setManualFormMode("edit");
    setManualFormTab(tab);
    const details = item.details && typeof item.details === "object" ? item.details : {};
    const detailStrings: Record<string, string> = {};
    Object.entries(details).forEach(([key, value]) => {
      detailStrings[key] = value == null ? "" : String(value);
    });
    setManualForm({
      id: item.id,
      name: item.name,
      value: String(item.value),
      category: item.category,
      acquisitionDate: item.acquisition_date ?? "",
      details: detailStrings,
    });
    setManualModalOpen(true);
  };

  const setDetailField = (key: string, value: string) => {
    setManualForm((prev) => ({
      ...prev,
      details: {
        ...prev.details,
        [key]: value,
      },
    }));
  };

  const saveManualForm = async () => {
    const parsedValue = Number(manualForm.value);
    if (!manualForm.name.trim() || !manualForm.category.trim() || !Number.isFinite(parsedValue)) {
      setTableError("Please provide valid name, category, and numeric value.");
      return;
    }
    const apiPath = manualFormTab === "assets" ? "/api/assets" : "/api/liabilities";
    setSavingRow(`${manualFormTab}:${manualForm.id ?? "new"}`);
    setTableError(null);
    try {
      const details: Record<string, unknown> = {};
      Object.entries(manualForm.details).forEach(([key, value]) => {
        const trimmed = String(value ?? "").trim();
        if (trimmed.length > 0) details[key] = trimmed;
      });
      const res = await fetch(apiPath, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: manualForm.id,
          name: manualForm.name.trim(),
          value: parsedValue,
          category: manualForm.category.trim(),
          acquisitionDate: manualForm.acquisitionDate.trim() || null,
          details,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || `Failed to save ${manualFormTab}`);
      }
      setManualModalOpen(false);
      await Promise.all([loadManualTables(), loadSummary()]);
    } catch (err) {
      setTableError(err instanceof Error ? err.message : `Failed to save ${manualFormTab}`);
    } finally {
      setSavingRow(null);
    }
  };

  const activeRows = activeManualTab === "assets" ? assets : liabilities;
  const activeCategories = activeManualTab === "assets" ? ASSET_CATEGORIES : LIABILITY_CATEGORIES;
  const isAssetForm = manualFormTab === "assets";
  const categoryLower = manualForm.category.trim().toLowerCase();
  const isVehicleAsset = isAssetForm && categoryLower === "vehicle";
  const isRealEstateAsset = isAssetForm && categoryLower === "real estate";
  const isPersonalAsset = isAssetForm && categoryLower === "personal";
  const isCreditCardLiability = !isAssetForm && categoryLower === "credit card";
  const isLoanLiability = !isAssetForm && categoryLower === "loan";
  const isMortgageLiability = !isAssetForm && categoryLower === "mortgage";

  return (
    <DashboardLayout>
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h1 className="text-2xl font-semibold text-white">Net Worth</h1>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleRefresh}
              disabled={isRefreshing}
              className="px-3 py-2 rounded-lg bg-[#252525] border border-charcoal-dark text-gray-200 hover:text-white hover:bg-[#2d2d2d] disabled:opacity-60"
            >
              {isRefreshing ? "Refreshing..." : "Refresh"}
            </button>
            <MonthDropdown />
          </div>
        </div>

        {(summaryError || tableError || expensesError) && (
          <div className="rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 px-4 py-2 text-sm">
            {summaryError ?? tableError ?? expensesError}
          </div>
        )}

        <div className="grid gap-4 md:grid-cols-3">
          <div className="rounded-xl bg-[#252525] border border-charcoal-dark p-4">
            <p className="text-sm text-gray-400">Total Net Worth</p>
            <p className="text-2xl font-semibold text-white mt-2">
              {summaryLoading || !summary ? "Loading..." : fmtCurrency(adjustedTotalNetWorth)}
            </p>
          </div>
          <div className="rounded-xl bg-[#252525] border border-charcoal-dark p-4">
            <p className="text-sm text-gray-400">Liquid Net Worth</p>
            <p className="text-2xl font-semibold text-white mt-2">
              {summaryLoading || !summary ? "Loading..." : fmtCurrency(adjustedLiquidNetWorth)}
            </p>
          </div>
          <div className="rounded-xl bg-[#252525] border border-charcoal-dark p-4">
            <p className="text-sm text-gray-400">Monthly Savings Rate</p>
            <p className="text-2xl font-semibold text-white mt-2">
              {summaryLoading || !summary ? "Loading..." : `${savingsRate.toFixed(1)}%`}
            </p>
          </div>
        </div>

        <div className="rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden">
          <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark flex items-center justify-between">
            <h2 className="text-white font-semibold">Manual Assets & Liabilities</h2>
            <div className="inline-flex items-center gap-2">
              <button
                type="button"
                onClick={() => openCreateModal(activeManualTab)}
                className="px-2.5 py-1 rounded-md bg-[#252525] border border-charcoal-dark text-white hover:bg-[#2f2f2f]"
                aria-label={`Add ${activeManualTab === "assets" ? "asset" : "liability"}`}
                title={`Add ${activeManualTab === "assets" ? "asset" : "liability"}`}
              >
                +
              </button>
              <div className="inline-flex rounded-lg border border-charcoal-dark overflow-hidden">
                <button
                  type="button"
                  onClick={() => setActiveManualTab("assets")}
                  className={`px-3 py-1.5 text-sm ${
                    activeManualTab === "assets" ? "bg-[#50C878] text-black" : "text-gray-300 bg-[#2b2b2b]"
                  }`}
                >
                  Assets
                </button>
                <button
                  type="button"
                  onClick={() => setActiveManualTab("liabilities")}
                  className={`px-3 py-1.5 text-sm ${
                    activeManualTab === "liabilities"
                      ? "bg-[#FF5C5C] text-black"
                      : "text-gray-300 bg-[#2b2b2b]"
                  }`}
                >
                  Liabilities
                </button>
              </div>
            </div>
          </div>
          <div className="p-4 overflow-x-auto">
            {tableLoading ? (
              <p className="text-sm text-gray-400">Loading data...</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-400 border-b border-charcoal-dark">
                    <th className="py-2 pr-2">Name</th>
                    <th className="py-2 pr-2">Category</th>
                    <th className="py-2 pr-2">Acquired</th>
                    <th className="py-2 pr-2 text-right">Value</th>
                    <th className="py-2 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="text-white">
                  {activeRows.map((row) => {
                    return (
                      <tr key={row.id} className="border-b border-charcoal-dark/80 odd:bg-[#2C2C2C]">
                        <td className="py-2 pr-2">{row.name}</td>
                        <td className="py-2 pr-2">{row.category}</td>
                        <td className="py-2 pr-2">{formatAcquiredDate(row.acquisition_date)}</td>
                        <td className="py-2 pr-2 text-right">{fmtCurrency(Number(row.value || 0))}</td>
                        <td className="py-2 text-right">
                          <button
                            type="button"
                            onClick={() => openEditModal(row, activeManualTab)}
                            className="px-3 py-1 rounded-md bg-[#3a3a3a] text-gray-200 hover:bg-[#474747]"
                          >
                            Edit
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden">
            <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark">
              <h2 className="text-white font-semibold">Income Breakdown</h2>
            </div>
            <div className="p-4 h-[320px]">
              {expensesLoading ? (
                <p className="text-sm text-gray-400">Loading chart...</p>
              ) : incomeBreakdown.length === 0 ? (
                <p className="text-sm text-gray-400">No income entries for the selected period.</p>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={incomeBreakdown}
                      dataKey="amount"
                      nameKey="source"
                      innerRadius={70}
                      outerRadius={110}
                      paddingAngle={2}
                    >
                      {incomeBreakdown.map((entry, index) => (
                        <Cell key={entry.source} fill={PIE_COLORS[index % PIE_COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip
                      formatter={(value: number) => fmtCurrency(Number(value))}
                      contentStyle={{
                        backgroundColor: "#2F2F2F",
                        border: "1px solid #474747",
                        borderRadius: "8px",
                        color: "#e5e7eb",
                      }}
                    />
                  </PieChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          <div className="rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden">
            <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark">
              <h2 className="text-white font-semibold">Net Worth History (Sheets + Fidelity)</h2>
            </div>
            <div className="p-4 h-[320px]">
              {trendDataWithLatest.length === 0 ? (
                <p className="text-sm text-gray-400">No historical trend data available yet.</p>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={trendDataWithLatest} margin={{ top: 6, right: 6, bottom: 6, left: 2 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                    <XAxis dataKey="label" stroke="#9ca3af" tick={{ fill: "#9ca3af", fontSize: 11 }} />
                    <YAxis
                      stroke="#9ca3af"
                      tick={{ fill: "#9ca3af", fontSize: 11 }}
                      tickFormatter={(v) => `$${Number(v).toLocaleString()}`}
                    />
                    <Tooltip
                      formatter={(value: number, name: string) => [
                        fmtCurrency(Number(value)),
                        name === "sheetsNetChange" ? "Sheets Net Change" : "Fidelity Value",
                      ]}
                      contentStyle={{
                        backgroundColor: "#2F2F2F",
                        border: "1px solid #474747",
                        borderRadius: "8px",
                        color: "#e5e7eb",
                      }}
                    />
                    <Line
                      type="monotone"
                      dataKey="sheetsNetChange"
                      stroke={PIE_COLORS[0]}
                      strokeWidth={2.5}
                      connectNulls
                    />
                    <Line
                      type="monotone"
                      dataKey="fidelityValue"
                      stroke={PIE_COLORS[1 % PIE_COLORS.length]}
                      strokeWidth={2.5}
                      connectNulls
                    />
                  </LineChart>
                </ResponsiveContainer>
              )}
              <p className="text-xs text-gray-400 mt-2">
                Fidelity history source: {historySource}
              </p>
            </div>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-5">
          <div className="rounded-xl bg-[#252525] border border-charcoal-dark p-4">
            <p className="text-sm text-gray-400">Liquidity Ratio</p>
            <p className="text-xl font-semibold text-white mt-2">{liquidityRatio.toFixed(2)}x</p>
            <p className="text-xs text-gray-500 mt-1">Liquid assets / avg monthly expenses</p>
          </div>
          <div className="rounded-xl bg-[#252525] border border-charcoal-dark p-4">
            <p className="text-sm text-gray-400">Runway</p>
            <p className="text-xl font-semibold text-white mt-2">{runwayMonths.toFixed(1)} months</p>
            <p className="text-xs text-gray-500 mt-1">How long liquid net worth can cover spending</p>
          </div>
          <div className="rounded-xl bg-[#252525] border border-charcoal-dark p-4">
            <p className="text-sm text-gray-400">Current Investments</p>
            <div className="mt-2 space-y-1">
              <p className="text-sm text-gray-300">
                Brokerage: <span className="text-white font-semibold">{fmtCurrency(investments.brokerage)}</span>
              </p>
              <p className="text-sm text-gray-300">
                Roth IRA: <span className="text-white font-semibold">{fmtCurrency(investments.rothIra)}</span>
              </p>
              <p className="text-sm text-gray-300">
                Total: <span className="text-white font-semibold">{fmtCurrency(investments.fidelityTotal)}</span>
              </p>
            </div>
            <p className="text-xs text-gray-500 mt-2">
              Last pulled: {investments.fetchedAt ? formatDateLabel(investments.fetchedAt) : "Not yet refreshed"}
            </p>
          </div>
          <div className="rounded-xl bg-[#252525] border border-charcoal-dark p-4">
            <p className="text-sm text-gray-400">Connected Account Balances</p>
            <div className="mt-2 space-y-1 text-sm">
              {visibleAccountBalances.length === 0 ? (
                <p className="text-gray-500">No linked balances yet.</p>
              ) : (
                visibleAccountBalances
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([name, value]) => (
                    <p key={name} className="text-gray-300">
                      {name}: <span className="text-white font-semibold">{fmtCurrency(Number(value ?? 0))}</span>
                    </p>
                  ))
              )}
            </div>
          </div>
          <div className="rounded-xl bg-[#252525] border border-charcoal-dark p-4">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm text-gray-400">Goal Tracking</p>
              <input
                type="number"
                min={1}
                value={goalTarget}
                onChange={(e) => setGoalTarget(Math.max(1, Number(e.target.value) || 1))}
                className="w-28 rounded-md bg-[#1f1f1f] border border-charcoal-dark px-2 py-1 text-sm text-right text-white"
              />
            </div>
            <p className="text-xs text-gray-500 mt-2">Target: {fmtCurrency(goalTarget)}</p>
            <div className="w-full h-3 rounded-full bg-[#1e1e1e] mt-3 overflow-hidden">
              <div
                className="h-full bg-[#50C878]"
                style={{ width: `${Math.min(100, goalProgress)}%` }}
              />
            </div>
            <p className="text-xs text-gray-300 mt-2">
              {summary ? `${goalProgress.toFixed(1)}% complete` : "Loading progress..."}
            </p>
          </div>
        </div>

        {manualModalOpen && (
          <div
            className="fixed inset-0 z-50 bg-black/50 p-4 flex items-center justify-center"
            onClick={() => setManualModalOpen(false)}
          >
            <div
              className="w-full max-w-2xl rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark flex items-center justify-between">
                <h3 className="text-white font-semibold">
                  {manualFormMode === "create" ? "Add" : "Edit"} {manualFormTab === "assets" ? "Asset" : "Liability"}
                </h3>
                <button
                  type="button"
                  onClick={() => setManualModalOpen(false)}
                  className="px-2 py-1 rounded-md text-gray-300 hover:text-white hover:bg-[#2f2f2f]"
                >
                  Close
                </button>
              </div>
              <div className="p-4 grid gap-3 md:grid-cols-2">
                <label className="text-sm text-gray-300">
                  Name
                  <input
                    value={manualForm.name}
                    onChange={(e) => setManualForm((prev) => ({ ...prev, name: e.target.value }))}
                    className="mt-1 w-full rounded-md bg-[#1f1f1f] border border-charcoal-dark px-2 py-1 text-white"
                    placeholder={manualFormTab === "assets" ? "Primary Residence, Toyota Camry..." : "Chase Freedom, Mortgage..."}
                  />
                </label>
                <label className="text-sm text-gray-300">
                  Category
                  <select
                    value={manualForm.category}
                    onChange={(e) => setManualForm((prev) => ({ ...prev, category: e.target.value }))}
                    className="mt-1 w-full rounded-md bg-[#1f1f1f] border border-charcoal-dark px-2 py-1 text-white"
                  >
                    {(manualFormTab === "assets" ? ASSET_CATEGORIES : LIABILITY_CATEGORIES).map((cat) => (
                      <option key={cat} value={cat}>
                        {cat}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-sm text-gray-300">
                  Current Value
                  <input
                    value={manualForm.value}
                    onChange={(e) => setManualForm((prev) => ({ ...prev, value: e.target.value }))}
                    className="mt-1 w-full rounded-md bg-[#1f1f1f] border border-charcoal-dark px-2 py-1 text-white text-right"
                    placeholder="0.00"
                  />
                </label>
                <label className="text-sm text-gray-300">
                  Acquisition Date
                  <input
                    type="date"
                    value={manualForm.acquisitionDate}
                    onChange={(e) =>
                      setManualForm((prev) => ({ ...prev, acquisitionDate: e.target.value }))
                    }
                    className="mt-1 w-full rounded-md bg-[#1f1f1f] border border-charcoal-dark px-2 py-1 text-white"
                  />
                </label>

                {isVehicleAsset && (
                  <>
                    <label className="text-sm text-gray-300">
                      Year
                      <input
                        value={manualForm.details.year ?? ""}
                        onChange={(e) => setDetailField("year", e.target.value)}
                        className="mt-1 w-full rounded-md bg-[#1f1f1f] border border-charcoal-dark px-2 py-1 text-white"
                      />
                    </label>
                    <label className="text-sm text-gray-300">
                      Model
                      <input
                        value={manualForm.details.model ?? ""}
                        onChange={(e) => setDetailField("model", e.target.value)}
                        className="mt-1 w-full rounded-md bg-[#1f1f1f] border border-charcoal-dark px-2 py-1 text-white"
                      />
                    </label>
                    <label className="text-sm text-gray-300">
                      Current Miles
                      <input
                        value={manualForm.details.currentMiles ?? ""}
                        onChange={(e) => setDetailField("currentMiles", e.target.value)}
                        className="mt-1 w-full rounded-md bg-[#1f1f1f] border border-charcoal-dark px-2 py-1 text-white"
                      />
                    </label>
                    <label className="text-sm text-gray-300">
                      Debt Financed?
                      <select
                        value={manualForm.details.debtFinanced ?? ""}
                        onChange={(e) => setDetailField("debtFinanced", e.target.value)}
                        className="mt-1 w-full rounded-md bg-[#1f1f1f] border border-charcoal-dark px-2 py-1 text-white"
                      >
                        <option value="">Select</option>
                        <option value="Yes">Yes</option>
                        <option value="No">No</option>
                      </select>
                    </label>
                    <label className="text-sm text-gray-300 md:col-span-2">
                      Remaining Auto Loan Balance
                      <input
                        value={manualForm.details.loanBalance ?? ""}
                        onChange={(e) => setDetailField("loanBalance", e.target.value)}
                        className="mt-1 w-full rounded-md bg-[#1f1f1f] border border-charcoal-dark px-2 py-1 text-white"
                      />
                    </label>
                  </>
                )}

                {isRealEstateAsset && (
                  <>
                    <label className="text-sm text-gray-300">
                      Property Type
                      <input
                        value={manualForm.details.propertyType ?? ""}
                        onChange={(e) => setDetailField("propertyType", e.target.value)}
                        className="mt-1 w-full rounded-md bg-[#1f1f1f] border border-charcoal-dark px-2 py-1 text-white"
                      />
                    </label>
                    <label className="text-sm text-gray-300">
                      Address
                      <input
                        value={manualForm.details.address ?? ""}
                        onChange={(e) => setDetailField("address", e.target.value)}
                        className="mt-1 w-full rounded-md bg-[#1f1f1f] border border-charcoal-dark px-2 py-1 text-white"
                      />
                    </label>
                    <label className="text-sm text-gray-300">
                      Sq Ft
                      <input
                        value={manualForm.details.squareFeet ?? ""}
                        onChange={(e) => setDetailField("squareFeet", e.target.value)}
                        className="mt-1 w-full rounded-md bg-[#1f1f1f] border border-charcoal-dark px-2 py-1 text-white"
                      />
                    </label>
                    <label className="text-sm text-gray-300">
                      Mortgage Financed?
                      <select
                        value={manualForm.details.mortgageFinanced ?? ""}
                        onChange={(e) => setDetailField("mortgageFinanced", e.target.value)}
                        className="mt-1 w-full rounded-md bg-[#1f1f1f] border border-charcoal-dark px-2 py-1 text-white"
                      >
                        <option value="">Select</option>
                        <option value="Yes">Yes</option>
                        <option value="No">No</option>
                      </select>
                    </label>
                    <label className="text-sm text-gray-300 md:col-span-2">
                      Remaining Mortgage Balance
                      <input
                        value={manualForm.details.mortgageBalance ?? ""}
                        onChange={(e) => setDetailField("mortgageBalance", e.target.value)}
                        className="mt-1 w-full rounded-md bg-[#1f1f1f] border border-charcoal-dark px-2 py-1 text-white"
                      />
                    </label>
                  </>
                )}

                {isPersonalAsset && (
                  <label className="text-sm text-gray-300 md:col-span-2">
                    Notes / Description
                    <input
                      value={manualForm.details.notes ?? ""}
                      onChange={(e) => setDetailField("notes", e.target.value)}
                      className="mt-1 w-full rounded-md bg-[#1f1f1f] border border-charcoal-dark px-2 py-1 text-white"
                    />
                  </label>
                )}

                {!isAssetForm && (
                  <>
                    <label className="text-sm text-gray-300">
                      Lender / Issuer
                      <input
                        value={manualForm.details.lender ?? ""}
                        onChange={(e) => setDetailField("lender", e.target.value)}
                        className="mt-1 w-full rounded-md bg-[#1f1f1f] border border-charcoal-dark px-2 py-1 text-white"
                      />
                    </label>
                    <label className="text-sm text-gray-300">
                      Interest Rate (%)
                      <input
                        value={manualForm.details.interestRate ?? ""}
                        onChange={(e) => setDetailField("interestRate", e.target.value)}
                        className="mt-1 w-full rounded-md bg-[#1f1f1f] border border-charcoal-dark px-2 py-1 text-white"
                      />
                    </label>
                    <label className="text-sm text-gray-300">
                      Minimum Payment
                      <input
                        value={manualForm.details.minimumPayment ?? ""}
                        onChange={(e) => setDetailField("minimumPayment", e.target.value)}
                        className="mt-1 w-full rounded-md bg-[#1f1f1f] border border-charcoal-dark px-2 py-1 text-white"
                      />
                    </label>
                  </>
                )}

                {isCreditCardLiability && (
                  <>
                    <label className="text-sm text-gray-300">
                      Last 4 Digits
                      <input
                        value={manualForm.details.last4 ?? ""}
                        onChange={(e) => setDetailField("last4", e.target.value)}
                        className="mt-1 w-full rounded-md bg-[#1f1f1f] border border-charcoal-dark px-2 py-1 text-white"
                      />
                    </label>
                    <label className="text-sm text-gray-300">
                      Credit Limit
                      <input
                        value={manualForm.details.creditLimit ?? ""}
                        onChange={(e) => setDetailField("creditLimit", e.target.value)}
                        className="mt-1 w-full rounded-md bg-[#1f1f1f] border border-charcoal-dark px-2 py-1 text-white"
                      />
                    </label>
                  </>
                )}

                {isLoanLiability && (
                  <>
                    <label className="text-sm text-gray-300">
                      Loan Type
                      <input
                        value={manualForm.details.loanType ?? ""}
                        onChange={(e) => setDetailField("loanType", e.target.value)}
                        className="mt-1 w-full rounded-md bg-[#1f1f1f] border border-charcoal-dark px-2 py-1 text-white"
                      />
                    </label>
                    <label className="text-sm text-gray-300">
                      Term (months)
                      <input
                        value={manualForm.details.termMonths ?? ""}
                        onChange={(e) => setDetailField("termMonths", e.target.value)}
                        className="mt-1 w-full rounded-md bg-[#1f1f1f] border border-charcoal-dark px-2 py-1 text-white"
                      />
                    </label>
                  </>
                )}

                {isMortgageLiability && (
                  <label className="text-sm text-gray-300 md:col-span-2">
                    Property Address
                    <input
                      value={manualForm.details.propertyAddress ?? ""}
                      onChange={(e) => setDetailField("propertyAddress", e.target.value)}
                      className="mt-1 w-full rounded-md bg-[#1f1f1f] border border-charcoal-dark px-2 py-1 text-white"
                    />
                  </label>
                )}
              </div>
              <div className="px-4 py-3 border-t border-charcoal-dark flex justify-end gap-2 bg-[#252525]">
                <button
                  type="button"
                  onClick={() => setManualModalOpen(false)}
                  className="px-3 py-1.5 rounded-md bg-[#3a3a3a] text-gray-200"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={saveManualForm}
                  disabled={Boolean(savingRow)}
                  className="px-3 py-1.5 rounded-md bg-[#50C878] text-black disabled:opacity-50"
                >
                  {savingRow ? "Saving..." : "Save"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
