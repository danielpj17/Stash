"use client";

import { Calendar } from "lucide-react";
import { useMonth } from "@/contexts/MonthContext";
import { MONTH_OPTIONS } from "@/contexts/MonthContext";
import GlassDropdown from "@/components/GlassDropdown";

export default function MonthDropdown() {
  const { selectedMonth, setSelectedMonth } = useMonth();

  return (
    <GlassDropdown
      value={selectedMonth}
      onChange={setSelectedMonth}
      options={MONTH_OPTIONS}
      className="min-w-[200px]"
      aria-label="Select month"
      leadingIcon={<Calendar className="w-4 h-4 text-[#50C878] shrink-0" />}
    />
  );
}
