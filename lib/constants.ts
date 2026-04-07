// Expense categories for charts/tables (excludes Income)
export const EXPENSE_CATEGORIES = [
  "Clothing",
  "Dates",
  "Donation",
  "Eating Out",
  "Education",
  "Entertainment",
  "Gas",
  "Groceries",
  "Misc.",
  "Rent",
  "Tithing",
  "Investments",
  "Gifts",
  "Personal Care",
  "Subscriptions",
] as const;

/** Old sheet/category names → current EXPENSE_CATEGORIES keys (budget migration). */
export const LEGACY_EXPENSE_CATEGORY_ALIASES: Record<string, string> = {
  Beauty: "Personal Care",
};

/** Map legacy sheet "Expense Type" values to current category names for totals and filters. */
export function normalizeExpenseCategoryType(expenseType: string): string {
  return LEGACY_EXPENSE_CATEGORY_ALIASES[expenseType] ?? expenseType;
}

// Expense Type dropdown: categories + Income
export const EXPENSE_TYPE_OPTIONS = [...EXPENSE_CATEGORIES, "Income"] as const;

export const PIE_COLORS = [
  "#F9B43B", // orange
  "#50C878", // green
  "#9D59D5", // purple
  "#FF5C5C", // red
  "#3BDBB4", // teal
  "#c1e998", // light green
  "#ffdb99", // peach
  "#ff8000", // dark orange
  "#c0aedc", // lavender
  "#663399", // purple
  "#ffffcc", // light yellow
  "#4EA8FF", // blue (Investments)
  "#E91E63", // pink (Gifts)
  "#00ACC1", // cyan (Personal Care)
  "#A1887F", // warm gray-brown (Subscriptions)
];

/** Fixed color per category — same in pie chart and table, consistent month to month */
export const CATEGORY_COLORS: Record<string, string> = {};
EXPENSE_CATEGORIES.forEach((cat, i) => {
  CATEGORY_COLORS[cat] = PIE_COLORS[i % PIE_COLORS.length];
});

export const BUDGET_STORAGE_KEY = "financial-dashboard-budget-goals";

export const ASSET_CATEGORIES = ["Real Estate", "Vehicle", "Personal"] as const;

export const LIABILITY_CATEGORIES = ["Credit Card", "Loan", "Mortgage"] as const;
