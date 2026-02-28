"use client";

import { createContext, useContext, useState, useCallback, ReactNode } from "react";

export const MONTH_OPTIONS = [
  ...["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"].map(
    (m, i) => ({ value: `${i + 1}`, label: `${m} 2026` })
  ),
  { value: "full", label: "Full Year 2026" },
];

type MonthContextType = {
  selectedMonth: string;
  setSelectedMonth: (value: string) => void;
  selectedLabel: string;
};

const MonthContext = createContext<MonthContextType | null>(null);

export function MonthProvider({ children }: { children: ReactNode }) {
  const [selectedMonth, setSelectedMonth] = useState("2");
  const selectedLabel = MONTH_OPTIONS.find((o) => o.value === selectedMonth)?.label ?? "February 2026";

  return (
    <MonthContext.Provider value={{ selectedMonth, setSelectedMonth, selectedLabel }}>
      {children}
    </MonthContext.Provider>
  );
}

export function useMonth() {
  const ctx = useContext(MonthContext);
  if (!ctx) throw new Error("useMonth must be used within MonthProvider");
  return ctx;
}
