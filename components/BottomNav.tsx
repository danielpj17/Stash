"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  PlusCircle,
  ClipboardCheck,
  PiggyBank,
  TrendingUp,
  BarChart2,
} from "lucide-react";

const navItems = [
  { href: "/new-expense", icon: PlusCircle, label: "New Expense" },
  { href: "/reconcile", icon: ClipboardCheck, label: "Reconcile" },
  { href: "/", icon: PiggyBank, label: "Budget" },
  { href: "/net-worth", icon: TrendingUp, label: "Net Worth" },
  { href: "/investment-calculator", icon: BarChart2, label: "Planner" },
];

export default function BottomNav() {
  const pathname = usePathname();

  return (
    <nav
      className="hidden standalone:flex fixed bottom-0 left-0 right-0 z-50 bg-[#3A3A3A] border-t border-charcoal-dark items-center justify-around"
      style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
    >
      {navItems.map(({ href, icon: Icon, label }) => {
        const isActive =
          (href === "/" && pathname === "/") ||
          (href !== "/" && pathname.startsWith(href));
        return (
          <Link
            key={href}
            href={href}
            aria-label={label}
            className={`flex items-center justify-center p-4 transition-colors ${
              isActive ? "text-[#50C878]" : "text-gray-400 hover:text-gray-200"
            }`}
          >
            <Icon className="w-6 h-6" />
          </Link>
        );
      })}
    </nav>
  );
}
