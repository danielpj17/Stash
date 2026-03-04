"use client";

import { useEffect, useState, useMemo, useCallback } from "react";
import Link from "next/link";
import { X, Save, PlusCircle } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";
import MonthDropdown from "@/components/MonthDropdown";
import { useMonth } from "@/contexts/MonthContext";
import { useRefresh } from "@/contexts/RefreshContext";
import { getExpenses } from "@/services/sheetsApi";
import type { SheetRow } from "@/services/sheetsApi";
import { EXPENSE_CATEGORIES, CATEGORY_COLORS, BUDGET_STORAGE_KEY } from "@/lib/constants";
import {
  PieChart,
  Pie,
  Cell,
  Sector,
  ResponsiveContainer,
  Tooltip,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
} from "recharts";

/* ------------------------------------------------------------------ */
/*  Budget storage — per-month with migration from old flat format     */
/* ------------------------------------------------------------------ */

type MonthlyBudgets = Record<string, Record<string, number>>;

function isOldFlatFormat(parsed: Record<string, unknown>): boolean {
  const keys = Object.keys(parsed);
  if (keys.length === 0) return false;
  return EXPENSE_CATEGORIES.some((cat) => typeof parsed[cat] === "number");
}

function loadAllBudgets(): MonthlyBudgets {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(BUDGET_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    if (isOldFlatFormat(parsed)) {
      const goals: Record<string, number> = {};
      EXPENSE_CATEGORIES.forEach((cat) => {
        const v = parsed[cat];
        if (typeof v === "number") goals[cat] = v;
      });
      const migrated: MonthlyBudgets = {};
      for (let m = 1; m <= 12; m++) migrated[String(m)] = { ...goals };
      localStorage.setItem(BUDGET_STORAGE_KEY, JSON.stringify(migrated));
      return migrated;
    }

    return parsed as MonthlyBudgets;
  } catch {
    return {};
  }
}

function loadMonthBudget(month: string): Record<string, number> {
  const all = loadAllBudgets();
  if (month === "full") {
    const totals: Record<string, number> = {};
    EXPENSE_CATEGORIES.forEach((cat) => (totals[cat] = 0));
    for (let m = 1; m <= 12; m++) {
      const md = all[String(m)] ?? {};
      EXPENSE_CATEGORIES.forEach((cat) => {
        totals[cat] += md[cat] ?? 0;
      });
    }
    return totals;
  }
  const md = all[month] ?? {};
  const result: Record<string, number> = {};
  EXPENSE_CATEGORIES.forEach((cat) => {
    result[cat] = md[cat] ?? 0;
  });
  return result;
}

function saveCategoryBudget(month: string, category: string, amount: number) {
  if (typeof window === "undefined") return;
  const all = loadAllBudgets();
  if (!all[month]) {
    all[month] = {};
    EXPENSE_CATEGORIES.forEach((cat) => (all[month][cat] = 0));
  }
  all[month][category] = amount;
  localStorage.setItem(BUDGET_STORAGE_KEY, JSON.stringify(all));
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function buildExpenseTotals(rows: SheetRow[]): { category: string; total: number }[] {
  const byCategory: Record<string, number> = {};
  EXPENSE_CATEGORIES.forEach((cat) => (byCategory[cat] = 0));
  rows.forEach((r) => {
    if (r.expenseType !== "Income" && byCategory[r.expenseType] !== undefined) {
      byCategory[r.expenseType] += r.amount;
    }
  });
  return EXPENSE_CATEGORIES.map((cat) => ({
    category: cat,
    total: byCategory[cat] ?? 0,
  }));
}

function getProgressColor(pct: number): string {
  if (pct >= 100) return "#FF5C5C";
  if (pct >= 90) return "#ff8000";
  if (pct >= 70) return "#F9B43B";
  return "#50C878";
}

function formatDateMMDDYY(timestamp?: string): string {
  if (!timestamp) return "\u2014";
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return "\u2014";
  return d.toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "2-digit" });
}

type DailyPoint = { label: string; amount: number };

function getWeekStartDate(date: Date): Date {
  const start = new Date(date);
  const day = start.getDay();
  start.setDate(start.getDate() - day);
  start.setHours(0, 0, 0, 0);
  return start;
}

function formatWeekLabel(weekStart: Date): string {
  return `Week of ${weekStart.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
}

function formatLocalDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getDaysInSelectedMonth(selectedMonth: string): number[] {
  const monthNum = Number(selectedMonth);
  if (!Number.isFinite(monthNum) || monthNum < 1 || monthNum > 12) return [];
  const year = 2026;
  const lastDay = new Date(year, monthNum, 0).getDate();
  const now = new Date();
  const isCurrentMonth = now.getFullYear() === year && now.getMonth() + 1 === monthNum;
  const endDay = isCurrentMonth ? Math.min(now.getDate(), lastDay) : lastDay;
  const days: number[] = [];
  for (let d = 1; d <= endDay; d++) days.push(d);
  return days;
}

function buildDailyExpenses(rows: SheetRow[], selectedMonth: string): DailyPoint[] {
  const expenses = rows.filter((r) => r.expenseType !== "Income");
  const isFull = selectedMonth === "full";

  if (isFull) {
    if (expenses.length === 0) return [];
    const byKey: Record<string, number> = {};
    expenses.forEach((r) => {
      if (!r.timestamp) return;
      const d = new Date(r.timestamp);
      if (Number.isNaN(d.getTime())) return;
      const key = formatLocalDateKey(getWeekStartDate(d));
      byKey[key] = (byKey[key] ?? 0) + r.amount;
    });
    const entries = Object.entries(byKey).sort(([a], [b]) => a.localeCompare(b));
    return entries.map(([key, amount]) => ({
      label: formatWeekLabel(new Date(`${key}T00:00:00`)),
      amount,
    }));
  }

  const byKey: Record<string, number> = {};
  expenses.forEach((r) => {
    if (!r.timestamp) return;
    const d = new Date(r.timestamp);
    if (Number.isNaN(d.getTime())) return;
    const key = String(d.getDate());
    byKey[key] = (byKey[key] ?? 0) + r.amount;
  });
  const days = getDaysInSelectedMonth(selectedMonth);
  return days.map((day) => ({
    label: String(day),
    amount: byKey[String(day)] ?? 0,
  }));
}

function buildDailyIncome(rows: SheetRow[], selectedMonth: string): DailyPoint[] {
  const income = rows.filter((r) => r.expenseType === "Income");
  const isFull = selectedMonth === "full";

  if (isFull) {
    if (income.length === 0) return [];
    const byKey: Record<string, number> = {};
    income.forEach((r) => {
      if (!r.timestamp) return;
      const d = new Date(r.timestamp);
      if (Number.isNaN(d.getTime())) return;
      const key = formatLocalDateKey(getWeekStartDate(d));
      byKey[key] = (byKey[key] ?? 0) + r.amount;
    });
    const entries = Object.entries(byKey).sort(([a], [b]) => a.localeCompare(b));
    return entries.map(([key, amount]) => ({
      label: formatWeekLabel(new Date(`${key}T00:00:00`)),
      amount,
    }));
  }

  const byKey: Record<string, number> = {};
  income.forEach((r) => {
    if (!r.timestamp) return;
    const d = new Date(r.timestamp);
    if (Number.isNaN(d.getTime())) return;
    const key = String(d.getDate());
    byKey[key] = (byKey[key] ?? 0) + r.amount;
  });
  const days = getDaysInSelectedMonth(selectedMonth);
  return days.map((day) => ({
    label: String(day),
    amount: byKey[String(day)] ?? 0,
  }));
}

function toCumulative(points: DailyPoint[]): DailyPoint[] {
  let sum = 0;
  return points.map(({ label, amount }) => {
    sum += amount;
    return { label, amount: sum };
  });
}

const fmtDollars = (n: number) =>
  "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const chartMargin = { top: 6, right: 6, bottom: 6, left: 2 };
const gridStroke = "rgba(255,255,255,0.06)";
const axisStroke = "#9ca3af";

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

type PieSlice = { category: string; value: number; isOverBudget: boolean };

export default function BudgetPage() {
  const { selectedMonth, selectedLabel } = useMonth();
  const { refreshKey } = useRefresh();

  const [rows, setRows] = useState<SheetRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [budgetGoals, setBudgetGoals] = useState<Record<string, number>>({});

  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [editBudgetValue, setEditBudgetValue] = useState("");
  const [activePieIndex, setActivePieIndex] = useState<number | null>(null);

  useEffect(() => {
    setBudgetGoals(loadMonthBudget(selectedMonth));
  }, [selectedMonth]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getExpenses(selectedMonth)
      .then((data) => { if (!cancelled) setRows(data); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [selectedMonth, refreshKey]);

  useEffect(() => {
    if (!selectedCategory) return;
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === "Escape") setSelectedCategory(null); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedCategory]);

  /* ---------- derived data ---------- */

  const expenseData = useMemo(() => buildExpenseTotals(rows), [rows]);
  const expenseTotal = expenseData.reduce((s, r) => s + r.total, 0);
  const totalBudget = EXPENSE_CATEGORIES.reduce((s, cat) => s + (budgetGoals[cat] ?? 0), 0);
  const incomeTransactions = useMemo(() => {
    return rows
      .filter((r) => r.expenseType === "Income")
      .sort((a, b) => {
        const tA = a.timestamp ? new Date(a.timestamp).getTime() : 0;
        const tB = b.timestamp ? new Date(b.timestamp).getTime() : 0;
        return tB - tA;
      });
  }, [rows]);
  const incomeTotal = incomeTransactions.reduce((sum, r) => sum + r.amount, 0);

  const categoryTransactions = useMemo(() => {
    if (!selectedCategory) return [];
    return rows
      .filter((r) => r.expenseType === selectedCategory)
      .sort((a, b) => {
        const tA = a.timestamp ? new Date(a.timestamp).getTime() : 0;
        const tB = b.timestamp ? new Date(b.timestamp).getTime() : 0;
        return tB - tA;
      });
  }, [rows, selectedCategory]);

  const budgetPieData: PieSlice[] = useMemo(() => {
    if (totalBudget <= 0) return [];
    return expenseData
      .filter((d) => d.total > 0)
      .map((d) => {
        const catBudget = budgetGoals[d.category] ?? 0;
        return {
          category: d.category,
          value: d.total,
          isOverBudget: catBudget > 0 && d.total > catBudget,
        };
      });
  }, [expenseData, totalBudget, budgetGoals]);

  const legendData = useMemo(() => {
    if (totalBudget <= 0) return [];
    return budgetPieData.map((d) => ({
      ...d,
      pct: (d.value / totalBudget) * 100,
    }));
  }, [budgetPieData, totalBudget]);
  const pieChartData = useMemo(() => {
    if (totalBudget <= 0) return [];
    const spentValue = budgetPieData.reduce((sum, d) => sum + d.value, 0);
    const remainingValue = Math.max(totalBudget - spentValue, 0);
    if (remainingValue <= 0) return budgetPieData;
    return [
      ...budgetPieData,
      { category: "__blank__", value: remainingValue, isOverBudget: false },
    ];
  }, [budgetPieData, totalBudget]);
  const dailyExpenses = useMemo(
    () => toCumulative(buildDailyExpenses(rows, selectedMonth)),
    [rows, selectedMonth]
  );
  const dailyIncome = useMemo(
    () => toCumulative(buildDailyIncome(rows, selectedMonth)),
    [rows, selectedMonth]
  );

  /* ---------- actions ---------- */

  const openCategory = useCallback((cat: string) => {
    setSelectedCategory(cat);
    setEditBudgetValue(String(budgetGoals[cat] ?? 0));
  }, [budgetGoals]);

  const handleSaveBudget = useCallback(() => {
    if (!selectedCategory || selectedMonth === "full") return;
    const num = parseFloat(editBudgetValue.replace(/,/g, ""));
    const amount = Number.isNaN(num) ? 0 : num;
    saveCategoryBudget(selectedMonth, selectedCategory, amount);
    setBudgetGoals((prev) => ({ ...prev, [selectedCategory]: amount }));
  }, [selectedCategory, selectedMonth, editBudgetValue]);

  /* ---------- render ---------- */

  if (loading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center min-h-[40vh] text-gray-400">Loading\u2026</div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h1 className="text-2xl font-semibold text-white">Budget</h1>
          <div className="flex items-center gap-2">
            <Link
              href="/new-expense"
              className="p-2 rounded-lg text-gray-400 hover:text-[#50C878] hover:bg-charcoal transition-colors"
              aria-label="New expense"
            >
              <PlusCircle className="w-6 h-6" />
            </Link>
            <MonthDropdown />
          </div>
        </div>

        {error && (
          <div className="rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 px-4 py-2 text-sm">
            {error}
            {!error.includes("NEXT_PUBLIC") && (
              <span className="block mt-1 text-gray-400">Showing empty data until the connection works.</span>
            )}
          </div>
        )}

        <div className="grid gap-4 lg:grid-cols-3">
          {/* Left column: Budget on top of Income */}
          <div className="flex flex-col gap-4">
            <div className="rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden flex flex-col">
              <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark flex items-center justify-between gap-3">
                <h2 className="text-white font-semibold">Budget</h2>
                <span className="text-sm font-semibold text-white whitespace-nowrap">
                  {fmtDollars(expenseTotal)}{" "}
                  <span className="text-gray-400 font-normal">/</span>{" "}
                  {fmtDollars(totalBudget)}
                </span>
              </div>

              <div className="p-3 flex-1 min-h-0 bg-[#252525]">
                {totalBudget <= 0 && (
                  <p className="text-gray-400 text-sm py-2 text-center mb-2">
                    No budget set for this month. Click a category to set one.
                  </p>
                )}

                <div className="flex items-center gap-2 px-2 pb-2 text-gray-500 text-[11px] font-medium uppercase tracking-wide border-b border-charcoal-dark">
                  <span className="w-[88px] shrink-0">Category</span>
                  <span className="w-[68px] shrink-0 text-right">Spent</span>
                  <span className="flex-1 min-w-[60px]" />
                  <span className="w-[72px] shrink-0 text-right">Budgeted</span>
                </div>

                <div className="-mx-0">
                  {expenseData.map((row, index) => {
                    const budget = budgetGoals[row.category] ?? 0;
                    const pct = budget > 0 ? (row.total / budget) * 100 : 0;
                    const barColor = getProgressColor(pct);
                    const barWidth = Math.min(pct, 100);

                    return (
                      <button
                        type="button"
                        key={row.category}
                        onClick={() => openCategory(row.category)}
                        className={`w-full flex items-center gap-2 text-white px-2 py-[7px] text-left cursor-pointer hover:bg-[#333] transition-colors text-sm ${
                          index % 2 === 0 ? "bg-[#2C2C2C]" : "bg-[#252525]"
                        }`}
                      >
                        <span className="w-[88px] shrink-0 text-gray-300 truncate">{row.category}</span>
                        <span className="w-[68px] shrink-0 text-right text-gray-200 tabular-nums text-xs">
                          {fmtDollars(row.total)}
                        </span>
                        <span className="flex-1 min-w-[60px] mx-1">
                          <span className="block w-full h-2.5 rounded-full bg-[#1a1a1a] overflow-hidden">
                            <span
                              className="block h-full rounded-full transition-all duration-500"
                              style={{
                                width: budget > 0 ? `${barWidth}%` : "0%",
                                backgroundColor: barColor,
                              }}
                            />
                          </span>
                        </span>
                        <span className="w-[72px] shrink-0 text-right text-gray-400 tabular-nums text-xs">
                          {budget > 0 ? fmtDollars(budget) : "—"}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden flex flex-col">
              <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark flex items-center justify-between gap-3">
                <h2 className="text-white font-semibold">Income</h2>
                <span className="text-sm font-semibold text-white whitespace-nowrap">
                  Total: {fmtDollars(incomeTotal)}
                </span>
              </div>
              <div className="p-4 flex-1 min-h-0 bg-[#252525]">
                <div className="min-h-[180px] text-sm -mx-2">
                  {incomeTransactions.length === 0 ? (
                    <p className="text-gray-400 px-2 py-2">No income entries for this period.</p>
                  ) : (
                    incomeTransactions.map((row, index) => (
                      <div
                        key={`${row.timestamp ?? index}-${row.amount}-${row.description}`}
                        className={`flex justify-between items-baseline gap-3 text-white px-2 py-1.5 ${index % 2 === 0 ? "bg-[#2C2C2C]" : "bg-[#252525]"}`}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="text-gray-200">{row.description.trim() || "Income"}</span>
                          <span className="text-gray-500 text-xs ml-2 shrink-0">{formatDateMMDDYY(row.timestamp)}</span>
                        </span>
                        <span className="text-right shrink-0">
                          {fmtDollars(row.amount)}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Middle column: Budget Usage pie */}
          <div className="flex flex-col gap-4">
            <div className="rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden flex flex-col">
              <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark">
                <h2 className="text-white font-semibold">Budget Usage &mdash; {selectedLabel}</h2>
              </div>

              <div className="p-2 flex-1 min-h-0 bg-[#252525]">
                {totalBudget <= 0 ? (
                  <div className="flex items-center justify-center h-56 text-gray-400 text-sm">
                    Set a budget to see the chart.
                  </div>
                ) : (
                  <>
                    <div className="h-56 w-full" onMouseLeave={() => setActivePieIndex(null)}>
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
                          <Pie
                            data={pieChartData}
                            dataKey="value"
                            nameKey="category"
                            cx="50%"
                            cy="50%"
                            innerRadius="62%"
                            outerRadius="88%"
                            paddingAngle={2}
                            startAngle={90}
                            endAngle={-270}
                            activeIndex={activePieIndex ?? undefined}
                            onMouseEnter={(_d, i) => {
                              const row = pieChartData[i];
                              setActivePieIndex(row?.category === "__blank__" ? null : i);
                            }}
                            onMouseLeave={() => setActivePieIndex(null)}
                            style={{ outline: "none" }}
                            activeShape={(props: unknown) => {
                              const p = props as React.ComponentProps<typeof Sector> & {
                                style?: React.CSSProperties;
                                payload?: PieSlice;
                              };
                              const isBlank = p.payload?.category === "__blank__";
                              return (
                                <Sector
                                  {...p}
                                  stroke={isBlank ? "none" : "white"}
                                  strokeWidth={isBlank ? 0 : 2}
                                  style={{ ...p.style, outline: "none" }}
                                />
                              );
                            }}
                            inactiveShape={(props: unknown) => {
                              const p = props as React.ComponentProps<typeof Sector> & {
                                style?: React.CSSProperties;
                              };
                              return <Sector {...p} stroke="none" style={{ ...p.style, opacity: 0.45, outline: "none" }} />;
                            }}
                          >
                            {pieChartData.map((slice) => {
                              if (slice.category === "__blank__") {
                                return (
                                  <Cell
                                    key="__blank__"
                                    fill="rgba(0,0,0,0)"
                                    stroke="none"
                                    style={{ outline: "none" }}
                                  />
                                );
                              }
                              const color = CATEGORY_COLORS[slice.category] ?? "#888";
                              return (
                                <Cell
                                  key={slice.category}
                                  fill={color}
                                  stroke={slice.isOverBudget ? "#FF5C5C" : "white"}
                                  strokeWidth={slice.isOverBudget ? 2.5 : 1}
                                  style={{ outline: "none" }}
                                />
                              );
                            })}
                          </Pie>
                          <Tooltip
                            active={activePieIndex !== null}
                            content={() => {
                              if (activePieIndex == null || totalBudget <= 0) return null;
                              const slice = pieChartData[activePieIndex];
                              if (!slice || slice.category === "__blank__") return null;
                              const pct = (slice.value / totalBudget) * 100;
                              return (
                                <div
                                  style={{
                                    backgroundColor: "#282828",
                                    border: "1px solid #333333",
                                    borderRadius: "8px",
                                    color: "#e5e7eb",
                                    padding: "8px 12px",
                                  }}
                                >
                                  {slice.category}: {fmtDollars(slice.value)} ({pct.toFixed(1)}%)
                                </div>
                              );
                            }}
                          />
                        </PieChart>
                      </ResponsiveContainer>
                    </div>

                    <div className="mt-3 overflow-x-auto -mx-2">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-left text-gray-400 border-b border-charcoal-dark">
                            <th className="pb-1.5 pr-2 pl-2">Category</th>
                            <th className="pb-1.5 text-right pr-2">% of Budget</th>
                          </tr>
                        </thead>
                        <tbody className="text-white">
                          {[...legendData]
                            .sort((a, b) => b.pct - a.pct)
                            .map((row) => (
                              <tr key={row.category} className="border-b border-charcoal-dark/80 odd:bg-[#2C2C2C]">
                                <td className="py-1.5 pr-2 pl-2 text-gray-200">
                                  <span
                                    className="inline-block w-3 h-3 rounded-sm shrink-0 mr-2 align-middle"
                                    style={{
                                      backgroundColor: CATEGORY_COLORS[row.category] ?? "#888",
                                      outline: row.isOverBudget ? "2px solid #FF5C5C" : undefined,
                                      outlineOffset: "-1px",
                                    }}
                                    aria-hidden
                                  />
                                  {row.category}
                                  {row.isOverBudget && <span className="text-[11px] text-red-400 ml-1.5">over budget</span>}
                                </td>
                                <td className="py-1.5 text-right pr-2 tabular-nums">
                                  {row.pct.toFixed(1)}%
                                </td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Right column: Expenses over month on top of Income over month */}
          <div className="flex flex-col gap-4">
            <div className="rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden flex flex-col">
              <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark">
                <h2 className="text-white font-semibold">
                  Expenses: {selectedLabel}
                </h2>
              </div>
              <div className="pt-2 pr-4 pb-2 pl-0 flex-1 min-h-[260px] min-w-0 bg-[#252525] flex flex-col">
                {dailyExpenses.length === 0 ? (
                  <p className="text-gray-400 text-sm flex items-center justify-center h-full">No expense data for this period.</p>
                ) : (
                  <div className="flex-1 min-h-0 w-full -ml-2">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={dailyExpenses} margin={chartMargin}>
                        <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} />
                        <XAxis dataKey="label" stroke={axisStroke} tick={{ fill: "#9ca3af", fontSize: 11 }} />
                        <YAxis stroke={axisStroke} tick={{ fill: "#9ca3af", fontSize: 11 }} tickFormatter={(v) => `$${v}`} />
                        <Tooltip
                          formatter={(value: number) => [`$${Number(value).toLocaleString()}`, "Cumulative"]}
                          contentStyle={{
                            backgroundColor: "#2F2F2F",
                            border: "1px solid #474747",
                            borderRadius: "8px",
                            color: "#e5e7eb",
                          }}
                          labelStyle={{ color: "#CCCCCC" }}
                        />
                        <Line type="stepAfter" dataKey="amount" stroke="#4EA8FF" strokeWidth={2} dot={false} name="Expenses" />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </div>
            </div>

            <div className="rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden flex flex-col">
              <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark">
                <h2 className="text-white font-semibold">
                  Income: {selectedLabel}
                </h2>
              </div>
              <div className="pt-2 pr-4 pb-2 pl-0 flex-1 min-h-[260px] min-w-0 bg-[#252525] flex flex-col">
                {dailyIncome.length === 0 ? (
                  <p className="text-gray-400 text-sm flex items-center justify-center h-full">No income data for this period.</p>
                ) : (
                  <div className="flex-1 min-h-0 w-full -ml-2">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={dailyIncome} margin={chartMargin}>
                        <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} />
                        <XAxis dataKey="label" stroke={axisStroke} tick={{ fill: "#9ca3af", fontSize: 11 }} />
                        <YAxis stroke={axisStroke} tick={{ fill: "#9ca3af", fontSize: 11 }} tickFormatter={(v) => `$${v}`} />
                        <Tooltip
                          formatter={(value: number) => [`$${Number(value).toLocaleString()}`, "Cumulative"]}
                          contentStyle={{
                            backgroundColor: "#2F2F2F",
                            border: "1px solid #474747",
                            borderRadius: "8px",
                            color: "#e5e7eb",
                          }}
                          labelStyle={{ color: "#CCCCCC" }}
                        />
                        <Line type="stepAfter" dataKey="amount" stroke="#50C878" strokeWidth={2} dot={false} name="Income" />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* ==================== Category detail modal ==================== */}
        {selectedCategory && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50"
            onClick={() => setSelectedCategory(null)}
            role="dialog"
            aria-modal="true"
            aria-labelledby="budget-modal-title"
          >
            <div
              className="rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden flex flex-col w-full max-w-lg max-h-[80vh] shadow-xl"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Modal header */}
              <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark flex items-center justify-between gap-3 shrink-0">
                <h2 id="budget-modal-title" className="text-white font-semibold truncate">
                  {selectedCategory}
                  <span className="ml-2 font-medium text-gray-300">
                    &mdash; Spent: {fmtDollars(expenseData.find((d) => d.category === selectedCategory)?.total ?? 0)}
                    {(budgetGoals[selectedCategory] ?? 0) > 0 && (
                      <> / Budget: {fmtDollars(budgetGoals[selectedCategory])}</>
                    )}
                  </span>
                </h2>
                <button
                  type="button"
                  onClick={() => setSelectedCategory(null)}
                  className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-charcoal transition-colors shrink-0"
                  aria-label="Close"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="p-4 flex-1 min-h-0 overflow-y-auto">
                {/* Budget edit row (only for single months, not "Full Year") */}
                {selectedMonth !== "full" && (
                  <div className="flex items-center gap-2 mb-4 pb-4 border-b border-charcoal-dark">
                    <label htmlFor="modal-budget-input" className="text-sm text-gray-300 shrink-0">
                      Monthly budget:
                    </label>
                    <div className="flex items-center gap-2 flex-1 min-w-0">
                      <span className="text-gray-400">$</span>
                      <input
                        id="modal-budget-input"
                        type="text"
                        inputMode="decimal"
                        value={editBudgetValue}
                        onChange={(e) => setEditBudgetValue(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") handleSaveBudget(); }}
                        className="flex-1 min-w-0 px-3 py-1.5 rounded-lg bg-charcoal border border-charcoal-dark text-gray-200 focus:border-accent focus:ring-1 focus:ring-accent outline-none text-sm"
                      />
                      <button
                        type="button"
                        onClick={handleSaveBudget}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent text-white text-sm font-medium hover:bg-accent-dark transition-colors shrink-0"
                      >
                        <Save className="w-3.5 h-3.5" />
                        Save
                      </button>
                    </div>
                  </div>
                )}

                {/* Transactions list */}
                <div className="text-sm -mx-2">
                  <h3 className="text-gray-400 text-xs font-medium uppercase tracking-wide px-2 mb-2">
                    Transactions
                  </h3>
                  {categoryTransactions.length === 0 ? (
                    <p className="text-gray-400 px-2 py-2">No transactions in this category for this period.</p>
                  ) : (
                    categoryTransactions.map((row, index) => (
                      <div
                        key={`${row.timestamp ?? index}-${row.amount}-${row.description}`}
                        className={`flex justify-between items-baseline gap-3 text-white px-2 py-1.5 ${
                          index % 2 === 0 ? "bg-[#2C2C2C]" : "bg-[#252525]"
                        }`}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="text-gray-200">{row.description.trim() || "\u2014"}</span>
                          <span className="text-gray-500 text-xs ml-2 shrink-0">{formatDateMMDDYY(row.timestamp)}</span>
                        </span>
                        <span className="text-right shrink-0">{fmtDollars(row.amount)}</span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
