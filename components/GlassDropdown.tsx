"use client";

import { useState, useRef, useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronDown } from "lucide-react";

export type GlassDropdownOption = { value: string; label: string };

export type GlassDropdownProps = {
  value: string;
  onChange: (value: string) => void;
  options: GlassDropdownOption[];
  /** Shown when `value` is empty or not in `options`. */
  placeholder?: string;
  className?: string;
  /** Extra classes for the panel (e.g. `min-w-[200px]`). */
  panelClassName?: string;
  "aria-label"?: string;
  id?: string;
  disabled?: boolean;
  leadingIcon?: ReactNode;
};

export default function GlassDropdown({
  value,
  onChange,
  options,
  placeholder = "",
  className = "",
  panelClassName,
  "aria-label": ariaLabel,
  id,
  disabled = false,
  leadingIcon,
}: GlassDropdownProps) {
  const [open, setOpen] = useState(false);
  const [panelStyle, setPanelStyle] = useState<React.CSSProperties>({});
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function handleEscape(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, []);

  useEffect(() => {
    if (!open || !buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    setPanelStyle({
      position: "fixed",
      top: rect.bottom + 4,
      left: rect.left,
      width: rect.width,
      zIndex: 9999,
    });
  }, [open]);

  const selected = options.find((o) => o.value === value);
  const displayLabel = selected?.label ?? (value ? value : placeholder);
  const showPlaceholder = !selected && (!value || value === "");

  return (
    <div className={`relative ${className}`} ref={ref}>
      <button
        id={id}
        ref={buttonRef}
        type="button"
        disabled={disabled}
        onClick={() => !disabled && setOpen((o) => !o)}
        className="
          w-full flex items-center gap-2 justify-between min-w-0
          px-2.5 py-1.5 rounded-lg
          bg-charcoal/95 border border-charcoal-dark
          text-gray-200 text-sm text-left
          hover:border-[#50C878]/40 hover:text-white
          focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent
          disabled:opacity-50 disabled:pointer-events-none
          transition-colors
        "
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
      >
        <span className="flex items-center gap-2 min-w-0 flex-1">
          {leadingIcon}
          <span
            className={`truncate ${showPlaceholder ? "text-gray-500" : "text-gray-200"}`}
          >
            {displayLabel}
          </span>
        </span>
        <ChevronDown
          className={`w-4 h-4 shrink-0 text-gray-400 transition-transform ${open ? "rotate-180" : ""}`}
          aria-hidden
        />
      </button>

      {open && typeof document !== "undefined" && createPortal(
        <ul
          role="listbox"
          style={panelStyle}
          className={`
            max-h-[min(320px,70vh)] overflow-y-auto scrollbar-glass
            rounded-2xl border border-white/10 bg-neutral-900/75 backdrop-blur-xl
            shadow-[0_16px_48px_rgba(0,0,0,0.45)]
            divide-y divide-white/[0.08]
            ${panelClassName ?? ""}
          `}
        >
          {options.map((opt) => {
            const isSelected = value === opt.value;
            return (
              <li key={opt.value} role="option" aria-selected={isSelected}>
                <button
                  type="button"
                  onClick={() => {
                    onChange(opt.value);
                    setOpen(false);
                  }}
                  className={`
                    w-full text-left px-4 py-3 text-sm transition-colors
                    ${isSelected ? "bg-[#50C878]/15 text-[#50C878]" : "text-white/95 hover:bg-white/5"}
                  `}
                >
                  {opt.label}
                </button>
              </li>
            );
          })}
        </ul>,
        document.body
      )}
    </div>
  );
}
