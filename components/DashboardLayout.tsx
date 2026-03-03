"use client";

import { Menu } from "lucide-react";
import Sidebar from "./Sidebar";
import { SidebarProvider, useSidebar } from "@/contexts/SidebarContext";
function DashboardContent({ children }: { children: React.ReactNode }) {
  const { collapsed, toggleMobile } = useSidebar();
  return (
    <div className="min-h-screen flex">
      <Sidebar />
      <main
        className={`flex-1 flex flex-col min-w-0 pl-0 ${collapsed ? "lg:pl-[72px]" : "lg:pl-64"}`}
      >
        <div className="lg:hidden flex items-center p-2 border-b border-charcoal-dark shrink-0">
          <button
            type="button"
            onClick={toggleMobile}
            className="p-2 rounded-lg text-gray-400 hover:text-[#50C878] hover:bg-charcoal transition-colors"
            aria-label="Open menu"
          >
            <Menu className="w-5 h-5" />
          </button>
        </div>
        <div className="flex-1 p-4 md:p-6 overflow-auto">{children}</div>
      </main>
    </div>
  );
}

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <SidebarProvider>
      <DashboardContent>{children}</DashboardContent>
    </SidebarProvider>
  );
}
