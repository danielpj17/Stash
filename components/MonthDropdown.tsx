"use client";

import { useState, useRef, useEffect } from "react";
import { Calendar, ChevronDown } from "lucide-react";
import { useMonth } from "@/contexts/MonthContext";
import { MONTH_OPTIONS } from "@/contexts/MonthContext";

export default function MonthDropdown() {
  const { selectedMonth, setSelectedMonth, selectedLabel } = useMonth();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="
          flex items-center gap-2 px-4 py-2 rounded-lg
          bg-[#353535] border border-charcoal-dark
          text-gray-200 hover:border-[#59D58E]/50 hover:text-white
          transition-colors min-w-[180px] justify-between
        "
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Select month"
      >
        <span className="flex items-center gap-2 truncate">
          <Calendar className="w-4 h-4 text-[#59D58E] shrink-0" />
          <span className="truncate">{selectedLabel}</span>
        </span>
        <ChevronDown
          className={`w-4 h-4 shrink-0 text-gray-400 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <ul
          role="listbox"
          className="
            absolute right-0 top-full mt-1 w-full min-w-[200px] max-h-[320px] overflow-y-auto
            bg-[#353535] border border-charcoal-dark rounded-lg shadow-xl
            py-1 z-50 scrollbar-thin
          "
        >
          {MONTH_OPTIONS.map((opt) => (
            <li key={opt.value} role="option" aria-selected={selectedMonth === opt.value}>
              <button
                type="button"
                onClick={() => {
                  setSelectedMonth(opt.value);
                  setOpen(false);
                }}
                className={`
                  w-full text-left px-4 py-2.5 text-sm transition-colors
                  ${selectedMonth === opt.value ? "bg-[#59D58E]/20 text-[#59D58E]" : "text-gray-300 hover:bg-charcoal hover:text-white"}
                `}
              >
                {opt.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
