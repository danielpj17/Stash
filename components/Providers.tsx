"use client";

import { MonthProvider } from "@/contexts/MonthContext";
import { RefreshProvider } from "@/contexts/RefreshContext";

export default function Providers({ children }: { children: React.ReactNode }) {
  return (
    <MonthProvider>
      <RefreshProvider>{children}</RefreshProvider>
    </MonthProvider>
  );
}
