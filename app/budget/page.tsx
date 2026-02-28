"use client";

import { useState, useEffect } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { EXPENSE_CATEGORIES, BUDGET_STORAGE_KEY } from "@/lib/constants";
import { Save } from "lucide-react";

type BudgetGoals = Record<string, string>;

function loadBudgetGoals(): BudgetGoals {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(BUDGET_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: BudgetGoals = {};
    EXPENSE_CATEGORIES.forEach((cat) => {
      const v = parsed[cat];
      out[cat] = typeof v === "number" ? String(v) : typeof v === "string" ? v : "";
    });
    return out;
  } catch {
    return {};
  }
}

function saveBudgetGoals(goals: BudgetGoals) {
  if (typeof window === "undefined") return;
  const toSave: Record<string, number> = {};
  EXPENSE_CATEGORIES.forEach((cat) => {
    const v = goals[cat];
    const num = v === "" ? 0 : parseFloat(String(v).replace(/,/g, ""));
    if (!Number.isNaN(num)) toSave[cat] = num;
  });
  localStorage.setItem(BUDGET_STORAGE_KEY, JSON.stringify(toSave));
}

export default function BudgetPage() {
  const [goals, setGoals] = useState<BudgetGoals>({});
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setGoals(loadBudgetGoals());
  }, []);

  const handleChange = (category: string, value: string) => {
    setGoals((prev) => ({ ...prev, [category]: value }));
    setSaved(false);
  };

  const handleSave = () => {
    saveBudgetGoals(goals);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <h1 className="text-xl font-semibold text-white">Budget</h1>
          <button
            type="button"
            onClick={handleSave}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-accent text-white font-medium hover:bg-accent-dark transition-colors"
          >
            <Save className="w-4 h-4" />
            {saved ? "Saved" : "Save goals"}
          </button>
        </div>

        <div className="rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden">
          <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark">
            <h2 className="text-white font-medium">Monthly budget goals by category</h2>
          </div>
          <div className="p-4">
            <p className="text-gray-400 text-sm mb-4">
              Enter your target amount for each category. Values are stored in this browser only.
            </p>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {EXPENSE_CATEGORIES.map((cat) => (
                <div key={cat} className="flex flex-col gap-1">
                  <label
                    htmlFor={`budget-${cat}`}
                    className="text-sm font-medium text-gray-300"
                  >
                    {cat}
                  </label>
                  <input
                    id={`budget-${cat}`}
                    type="text"
                    inputMode="decimal"
                    value={goals[cat] ?? ""}
                    onChange={(e) => handleChange(cat, e.target.value)}
                    placeholder="0"
                    className="px-3 py-2 rounded-lg bg-charcoal border border-charcoal-dark text-gray-200 focus:border-accent focus:ring-1 focus:ring-accent outline-none"
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
