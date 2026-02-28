"use client";

import { Menu } from "lucide-react";
import MonthDropdown from "./MonthDropdown";
import { useSidebar } from "@/contexts/SidebarContext";

export default function Header() {
  const { toggleMobile } = useSidebar();

  return (
    <header className="sticky top-0 z-30 flex items-center justify-between gap-4 px-4 py-3 bg-[#3A3A3A] border-b border-charcoal-light shrink-0">
      <div className="flex items-center gap-2 text-gray-400">
        <button
          type="button"
          onClick={toggleMobile}
          className="lg:hidden p-2 -ml-2 rounded-lg text-gray-400 hover:text-[#59D58E] hover:bg-charcoal-dark transition-colors"
          aria-label="Open menu"
        >
          <Menu className="w-5 h-5" />
        </button>
        <span className="text-sm font-medium">Financial Dashboard</span>
      </div>
      <div className="flex items-center gap-3">
        <MonthDropdown />
      </div>
    </header>
  );
}
