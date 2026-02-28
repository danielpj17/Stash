"use client";

import Sidebar from "./Sidebar";
import Header from "./Header";
import { SidebarProvider, useSidebar } from "@/contexts/SidebarContext";
function DashboardContent({ children }: { children: React.ReactNode }) {
  const { collapsed } = useSidebar();
  return (
    <div className="min-h-screen flex">
      <Sidebar />
      <main
        className={`flex-1 flex flex-col min-w-0 pl-0 ${collapsed ? "lg:pl-[72px]" : "lg:pl-64"}`}
      >
        <Header />
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
