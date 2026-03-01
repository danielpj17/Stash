"use client";

import { useEffect, useState, useMemo } from "react";
import Link from "next/link";
import { PlusCircle } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";
import { useMonth } from "@/contexts/MonthContext";
import { useRefresh } from "@/contexts/RefreshContext";
import { getExpenses } from "@/services/sheetsApi";
import type { SheetRow } from "@/services/sheetsApi";
import { EXPENSE_CATEGORIES, PIE_COLORS, CATEGORY_COLORS } from "@/lib/constants";
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

function buildIncomeLineItems(rows: SheetRow[]): { description: string; amount: number }[] {
  const income = rows.filter((r) => r.expenseType === "Income");
  if (income.length === 0) return [];
  const byDesc: Record<string, number> = {};
  income.forEach((r) => {
    const key = r.description.trim() || "Income";
    byDesc[key] = (byDesc[key] ?? 0) + r.amount;
  });
  return Object.entries(byDesc).map(([description, amount]) => ({ description, amount }));
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

/** Get days 1..lastDay for the selected month (or 1..today if current month). Year matches app (2026). */
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

/** Turn per-period amounts into cumulative running total (step-up chart). */
function toCumulative(points: DailyPoint[]): DailyPoint[] {
  let sum = 0;
  return points.map(({ label, amount }) => {
    sum += amount;
    return { label, amount: sum };
  });
}

const chartMargin = { top: 6, right: 6, bottom: 6, left: 2 };
const gridStroke = "rgba(255,255,255,0.06)";
const axisStroke = "#9ca3af";

export default function ExpensesPage() {
  const { selectedMonth, selectedLabel } = useMonth();
  const { refreshKey } = useRefresh();
  const [rows, setRows] = useState<SheetRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expensesTab, setExpensesTab] = useState<"expenses" | "total">("expenses");
  const [activePieIndex, setActivePieIndex] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getExpenses(selectedMonth)
      .then((data) => {
        if (!cancelled) setRows(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedMonth, refreshKey]);

  const expenseData = useMemo(() => buildExpenseTotals(rows), [rows]);
  const pieData = useMemo(
    () => expenseData.filter((d) => d.total > 0),
    [expenseData]
  );
  const expenseTotal = expenseData.reduce((sum, r) => sum + r.total, 0);
  const incomeItems = useMemo(() => buildIncomeLineItems(rows), [rows]);
  const incomeTotal = incomeItems.reduce((sum, r) => sum + r.amount, 0);

  const dailyExpenses = useMemo(
    () => toCumulative(buildDailyExpenses(rows, selectedMonth)),
    [rows, selectedMonth]
  );
  const dailyIncome = useMemo(
    () => toCumulative(buildDailyIncome(rows, selectedMonth)),
    [rows, selectedMonth]
  );

  const expenseDataWithPct = useMemo(() => {
    if (expenseTotal <= 0) return expenseData.map((d) => ({ ...d, pct: 0 }));
    return expenseData.map((d) => ({
      ...d,
      pct: (d.total / expenseTotal) * 100,
    }));
  }, [expenseData, expenseTotal]);

  if (loading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center min-h-[40vh] text-gray-400">
          Loading…
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-xl font-semibold text-white">Expenses</h1>
          <Link
            href="/new-expense"
            className="p-2 rounded-lg text-gray-400 hover:text-[#50C878] hover:bg-charcoal transition-colors"
            aria-label="New expense"
          >
            <PlusCircle className="w-6 h-6" />
          </Link>
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
          {/* Left column: Expenses on top of Income */}
          <div className="flex flex-col gap-4">
            <div className="rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden flex flex-col">
              <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark flex items-center justify-between gap-3">
                <button
                  type="button"
                  onClick={() => setExpensesTab("expenses")}
                  className="text-sm font-semibold text-white transition-colors hover:opacity-90"
                >
                  Expenses
                </button>
                <button
                  type="button"
                  onClick={() => setExpensesTab("total")}
                  className="text-sm font-semibold text-white transition-colors whitespace-nowrap hover:opacity-90"
                >
                  Total: ${expenseTotal.toLocaleString("en-US", { minimumFractionDigits: 2 })}
                </button>
              </div>
              <div className="p-4 flex-1 min-h-0 bg-[#252525]">
                {expensesTab === "expenses" ? (
                  <div className="text-sm -mx-2">
                    {expenseData.map((row, index) => (
                      <div
                        key={row.category}
                        className={`flex justify-between text-white px-2 py-1.5 ${index % 2 === 0 ? "bg-[#2C2C2C]" : "bg-[#252525]"}`}
                      >
                        <span className="text-gray-300">{row.category}</span>
                        <span className="text-right">
                          ${row.total.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="flex items-center justify-center py-6">
                    <span className="text-2xl font-semibold text-white">
                      ${expenseTotal.toLocaleString("en-US", { minimumFractionDigits: 2 })}
                    </span>
                  </div>
                )}
              </div>
            </div>

            <div className="rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden flex flex-col">
              <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark flex items-center justify-between gap-3">
                <h2 className="text-white font-semibold">Income</h2>
                <span className="text-sm font-semibold text-white whitespace-nowrap">
                  Total: ${incomeTotal.toLocaleString("en-US", { minimumFractionDigits: 2 })}
                </span>
              </div>
              <div className="p-4 flex-1 min-h-0 bg-[#252525]">
                <div className="min-h-[180px] text-sm -mx-2">
                  {incomeItems.length === 0 ? (
                    <p className="text-gray-400 px-2 py-2">No income entries for this period.</p>
                  ) : (
                    incomeItems.map((row, index) => (
                      <div
                        key={row.description}
                        className={`flex justify-between text-white px-2 py-1.5 ${index % 2 === 0 ? "bg-[#2C2C2C]" : "bg-[#252525]"}`}
                      >
                        <span className="text-gray-300">{row.description}</span>
                        <span className="text-right">
                          ${row.amount.toLocaleString("en-US", { minimumFractionDigits: 2 })}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Middle column: Expense Distribution pie */}
          <div className="flex flex-col gap-4">
            <div className="rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden flex flex-col">
              <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark">
                <h2 className="text-white font-semibold">
                  Expense Distribution — {selectedLabel}
                </h2>
              </div>
              <div className="p-4 flex-1 min-h-0 bg-[#252525]">
                <div className="h-56 w-full p-2 expense-pie-chart">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart margin={{ top: 8, right: 80, bottom: 8, left: 80 }}>
                      <Pie
                        data={pieData}
                        dataKey="total"
                        nameKey="category"
                        cx="50%"
                        cy="50%"
                        innerRadius={44}
                        outerRadius={66}
                        paddingAngle={2}
                        activeIndex={activePieIndex ?? undefined}
                        onMouseEnter={(_data, index) => setActivePieIndex(index)}
                        onMouseLeave={() => setActivePieIndex(null)}
                        style={{ outline: "none" }}
                        activeShape={(props: unknown) => {
                          const p = props as React.ComponentProps<typeof Sector> & { style?: React.CSSProperties };
                          return <Sector {...p} stroke="none" style={{ ...p.style, outline: "none" }} />;
                        }}
                        inactiveShape={(props: unknown) => {
                          const p = props as React.ComponentProps<typeof Sector> & { style?: React.CSSProperties };
                          return <Sector {...p} style={{ ...p.style, opacity: 0.45 }} />;
                        }}
                      >
                        {pieData.map((row) => (
                          <Cell key={row.category} fill={CATEGORY_COLORS[row.category] ?? "#888"} style={{ outline: "none" }} />
                        ))}
                      </Pie>
                      <Tooltip
                        formatter={(value: number, name: string) => {
                          const pct = expenseTotal > 0 ? (value / expenseTotal) * 100 : 0;
                          return [`${name}: ${pct.toFixed(1)}%`, "Share"];
                        }}
                        contentStyle={{
                          backgroundColor: "#282828",
                          border: "1px solid #333333",
                          borderRadius: "8px",
                          color: "#e5e7eb",
                        }}
                        labelStyle={{ color: "#CCCCCC" }}
                        itemStyle={{ color: "#e5e7eb" }}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div className="mt-3 overflow-x-auto -mx-2">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-gray-400 border-b border-charcoal-dark">
                        <th className="pb-1.5 pr-2 pl-2">Category</th>
                        <th className="pb-1.5 text-right pr-2">%</th>
                      </tr>
                    </thead>
                    <tbody className="text-white">
                      {[...expenseDataWithPct]
                        .sort((a, b) => b.pct - a.pct)
                        .map((row) => (
                        <tr key={row.category} className="border-b border-charcoal-dark/80 odd:bg-[#2C2C2C]">
                          <td className="py-1.5 pr-2 pl-2 text-gray-200">
                            <span
                              className="inline-block w-3 h-3 rounded-sm shrink-0 mr-2 align-middle"
                              style={{ backgroundColor: CATEGORY_COLORS[row.category] ?? "#888" }}
                              aria-hidden
                            />
                            {row.category}
                          </td>
                          <td className="py-1.5 text-right pr-2">
                            {row.pct.toFixed(1)}%
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
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
      </div>
    </DashboardLayout>
  );
}
