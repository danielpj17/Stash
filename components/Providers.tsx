"use client";

import { MonthProvider } from "@/contexts/MonthContext";
import { RefreshProvider } from "@/contexts/RefreshContext";
import { ExpensesDataProvider } from "@/contexts/ExpensesDataContext";

export default function Providers({ children }: { children: React.ReactNode }) {
  return (
    <MonthProvider>
      <RefreshProvider>
        <ExpensesDataProvider>{children}</ExpensesDataProvider>
      </RefreshProvider>
    </MonthProvider>
  );
}
