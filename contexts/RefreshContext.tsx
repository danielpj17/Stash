"use client";

import { createContext, useContext, useState, useCallback, ReactNode } from "react";

type RefreshContextType = {
  refreshKey: number;
  triggerRefresh: () => void;
};

const RefreshContext = createContext<RefreshContextType | null>(null);

export function RefreshProvider({ children }: { children: ReactNode }) {
  const [refreshKey, setRefreshKey] = useState(0);
  const triggerRefresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  return (
    <RefreshContext.Provider value={{ refreshKey, triggerRefresh }}>
      {children}
    </RefreshContext.Provider>
  );
}

export function useRefresh() {
  const ctx = useContext(RefreshContext);
  if (!ctx) throw new Error("useRefresh must be used within RefreshProvider");
  return ctx;
}
