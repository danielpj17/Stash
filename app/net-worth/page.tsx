import DashboardLayout from "@/components/DashboardLayout";

export default function NetWorthPage() {
  return (
    <DashboardLayout>
      <div className="space-y-6">
        <h1 className="text-xl font-semibold text-white">Net Worth</h1>
        <div className="rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden">
          <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark">
            <h2 className="text-white font-medium">Overview</h2>
          </div>
          <div className="p-6">
            <p className="text-gray-400 text-sm">
              Assets, liabilities, and net worth trend will appear here.
            </p>
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
