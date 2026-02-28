"use client";

import DashboardLayout from "@/components/DashboardLayout";

export default function ExpenseFormPage() {
  return (
    <DashboardLayout>
      <div className="space-y-6">
        <h1 className="text-xl font-semibold text-white">Expense Form</h1>

        <div className="rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden">
          <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark">
            <h2 className="text-white font-medium">Submit Expense</h2>
            <p className="text-sm text-gray-300 mt-1">
              Fill out the form below to add a new expense entry.
            </p>
          </div>

          <div className="p-4 md:p-6 bg-[#252525]">
            <div className="rounded-lg bg-[#252525] border border-charcoal-dark overflow-hidden">
              <iframe
                src="https://docs.google.com/forms/d/e/1FAIpQLSe7NdmYgVzGlddFkLe4PLzmLesf61nACSbNvwAizWOP-L5IWQ/viewform?embedded=true"
                title="Expense Form"
                width="100%"
                height="1123"
                frameBorder="0"
                marginHeight={0}
                marginWidth={0}
                className="w-full"
              >
                Loading…
              </iframe>
            </div>
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
