"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  PlusCircle,
  Wallet,
  PiggyBank,
  TrendingUp,
  ClipboardCheck,
  Menu,
} from "lucide-react";
import { useSidebar } from "@/contexts/SidebarContext";
import StashLogo from "./StashLogo";

const navItems = [
  { href: "/new-expense", label: "New Expense", icon: PlusCircle },
  { href: "/", label: "Expenses", icon: Wallet },
  { href: "/budget", label: "Budget", icon: PiggyBank },
  { href: "/net-worth", label: "Net Worth", icon: TrendingUp },
  { href: "/reconcile", label: "Reconcile", icon: ClipboardCheck },
];

export default function Sidebar() {
  const pathname = usePathname();
  const { collapsed, toggleCollapsed, mobileOpen, closeMobile } = useSidebar();

  return (
    <>
      {/* Mobile backdrop */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/50 lg:hidden"
          onClick={closeMobile}
          aria-hidden
        />
      )}
      <aside
        className={`
          fixed left-0 top-0 z-40 h-screen bg-[#3A3A3A] border-r border-charcoal-dark
          transition-all duration-300 ease-in-out
          flex flex-col
          w-64
          lg:translate-x-0
          ${collapsed ? "lg:w-[72px]" : "lg:w-64"}
          ${mobileOpen ? "max-lg:translate-x-0" : "max-lg:-translate-x-full"}
        `}
      >
        {/* Top: Logo + Stash + hamburger (stacked when collapsed to avoid overlap) */}
        <div
          className={`
            flex border-b border-charcoal-dark shrink-0 min-h-[4rem]
            ${collapsed ? "flex-col items-center justify-center gap-2 py-3 px-2" : "flex-row items-center justify-between gap-2 py-4 px-4"}
          `}
        >
          <div className={`flex items-center min-w-0 ${collapsed ? "justify-center" : "gap-3 flex-1"}`}>
            <span
              className="flex items-center justify-center shrink-0 text-accent overflow-visible"
              style={{ width: "1.75rem", height: "1.75rem", minWidth: "1.75rem", minHeight: "1.75rem" }}
            >
              <StashLogo />
            </span>
            {!collapsed && (
              <span className="font-semibold text-white text-xl tracking-tight truncate leading-none">
                Stash
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={toggleCollapsed}
            className="hidden lg:flex p-2 rounded-lg text-gray-400 hover:text-[#50C878] hover:bg-charcoal transition-colors shrink-0"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            <Menu className="w-5 h-5" />
          </button>
        </div>

      {/* Nav */}
      <nav className="flex-1 p-3 space-y-1 overflow-y-auto scrollbar-thin">
        <p
          className={`px-3 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wider ${
            collapsed ? "sr-only" : ""
          }`}
        >
          Navigation
        </p>
        {navItems.map(({ href, label, icon: Icon }) => {
          const isActive =
            (href === "/" && pathname === "/") ||
            (href !== "/" && pathname.startsWith(href));
          return (
            <Link
              key={href}
              href={href}
              onClick={closeMobile}
              className={`
                flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors
                ${
                  isActive
                    ? "bg-[#50C878] text-white"
                    : "text-gray-300 hover:bg-charcoal hover:text-white"
                }
                ${collapsed ? "justify-center px-2" : ""}
              `}
            >
              <Icon className="w-5 h-5 shrink-0" />
              {!collapsed && <span>{label}</span>}
            </Link>
          );
        })}
      </nav>

      {/* Optional bottom area */}
      <div className="p-3 border-t border-charcoal-dark shrink-0">
        {!collapsed && (
          <p className="text-xs text-gray-500 px-3">Stash v1</p>
        )}
      </div>
    </aside>
    </>
  );
}
