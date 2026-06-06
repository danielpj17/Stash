# Stash – Complete Reconstruction Handoff

This document gives Claude Code everything it needs to recreate the Stash personal finance dashboard from scratch. It includes all verbatim source files, detailed specs for large files, manual setup steps the user must complete, and architectural notes.

---

## What Stash Is

A **Next.js 14** personal finance PWA with:
- **Budget dashboard** — pie chart, category progress bars, income/transfer cards, cumulative expense chart, account balances
- **Net Worth page** — manual assets/liabilities CRUD, investment widget, SnapTrade brokerage integration, income breakdown pie, history chart
- **Reconcile page** — upload bank CSV statements, match against Google Sheets transactions, dismiss irrelevant rows, set account anchors, undo via activity log
- **Investment Calculator** — life-stage compound interest planner, fully client-side
- **New Expense form** — add transactions directly to Google Sheets

**Tech stack:** Next.js 14, React 18, TypeScript (strict), Tailwind CSS, Recharts, Neon PostgreSQL (`@neondatabase/serverless`), Google Apps Script Web App, SnapTrade SDK, `@ducanh2912/next-pwa` (PWA support)

---

## PART 1: Manual Setup — Human Must Do These First

These steps cannot be automated. Complete them before running `npm install`.

### Step 1: Create the Google Spreadsheet

1. Go to [Google Sheets](https://sheets.google.com) and create a new spreadsheet.
2. Create two tabs named exactly **`Expenses`** and **`Transfers`**.
3. In the **Expenses** tab, add these headers in row 1 (exact column names matter):
   ```
   Timestamp | Expense Type | Amount | Description | Month | Row ID
   ```
   - `Month` column: use a formula like `=IF(B2="","",TEXT(B2,"M"))` referencing the Timestamp column, or leave it blank and let the Apps Script fill it in.
4. In the **Transfers** tab, add these headers in row 1:
   ```
   Timestamp | Transfer from | Transfer To | Transfer Amount | Month | Transfer Row ID
   ```
5. Note the **Spreadsheet ID** from the URL: `https://docs.google.com/spreadsheets/d/THIS_IS_THE_ID/edit`

### Step 2: Deploy the Google Apps Script

1. In the spreadsheet, go to **Extensions → Apps Script**.
2. Delete any existing code and paste the entire contents of `docs/google-apps-script-sample.js` (provided in full below).
3. Replace `YOUR_SPREADSHEET_ID_HERE` with your actual Spreadsheet ID.
4. Click **Deploy → New deployment**.
5. Set type to **Web app**, execute as **Me**, access to **Anyone**.
6. Click **Deploy** and copy the URL (it ends in `/exec`). This is your `NEXT_PUBLIC_GOOGLE_APPS_SCRIPT_URL`.
7. **Important:** Use the `/exec` URL, not the `/dev` URL. The `/dev` URL does not accept POST requests from external callers.

### Step 3: Create Neon PostgreSQL Database

1. Go to [neon.tech](https://neon.tech) and create a free account + project.
2. In the Neon dashboard, copy the **pooled connection string** (Transaction mode). It looks like:
   `postgresql://user:pass@ep-something.us-east-2.aws.neon.tech/neondb?sslmode=require`
3. In Neon Dashboard → **SQL Editor**, paste and run `docs/neon-budget-setup.sql` (full SQL below).
4. Then paste and run `docs/neon-manual-assets-liabilities.sql` (full SQL below).
5. This is your `DATABASE_URL`.

### Step 4: SnapTrade (Optional — for live brokerage balances)

SnapTrade connects to Fidelity, Robinhood, Charles Schwab, etc. to fetch live balances. Without it, balances fall back to the computed values from Google Sheets transactions.

1. Sign up at [snaptrade.com](https://snaptrade.com) for a developer account.
2. Get: `SNAPTRADE_CLIENT_ID`, `SNAPTRADE_CONSUMER_KEY`
3. Register a user and get: `SNAPTRADE_USER_ID`, `SNAPTRADE_USER_SECRET`
4. Connect your brokerage accounts through the SnapTrade OAuth flow.

### Step 5: Create `.env.local`

Create `.env.local` in the project root (never commit this file):

```env
NEXT_PUBLIC_GOOGLE_APPS_SCRIPT_URL=https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec
DATABASE_URL=postgresql://user:pass@host/dbname?sslmode=require
SNAPTRADE_CLIENT_ID=
SNAPTRADE_CONSUMER_KEY=
SNAPTRADE_USER_ID=
SNAPTRADE_USER_SECRET=
```

### Step 6: PWA Icons

The PWA needs two icon files in `public/icons/`:
- `public/icons/icon-192.png` (192×192 PNG)
- `public/icons/icon-512.png` (512×512 PNG)
- `public/favicon.svg` (any SVG, used as favicon)

You can generate these from any image using `npm run generate-icons` (requires `scripts/generate-icons.mjs` which calls `sharp`) or just place PNG files manually.

### Step 7: Deploy to Vercel (Optional)

1. Push repo to GitHub.
2. Import project at [vercel.com](https://vercel.com).
3. Add all `.env.local` variables in the Vercel dashboard under Settings → Environment Variables.
4. Vercel auto-detects Next.js. Deploy.

---

## PART 2: Project Initialization

```bash
npx create-next-app@14.2.18 stash --typescript --tailwind --eslint --app --no-src-dir --import-alias "@/*"
cd stash
npm install @ducanh2912/next-pwa @neondatabase/serverless lucide-react papaparse react-dropzone recharts sharp snaptrade-typescript-sdk
npm install -D @types/papaparse
```

---

## PART 3: All Configuration Files (verbatim)

### `package.json`

```json
{
  "name": "financial-dashboard",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "next lint",
    "generate-icons": "node scripts/generate-icons.mjs"
  },
  "dependencies": {
    "@ducanh2912/next-pwa": "^10.2.9",
    "@neondatabase/serverless": "^0.10.0",
    "lucide-react": "^0.460.0",
    "next": "14.2.18",
    "papaparse": "^5.5.3",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-dropzone": "^15.0.0",
    "recharts": "^2.13.3",
    "sharp": "^0.34.5",
    "snaptrade-typescript-sdk": "^9.0.173"
  },
  "devDependencies": {
    "@types/node": "^20",
    "@types/papaparse": "^5.5.2",
    "@types/react": "^18",
    "@types/react-dom": "^18",
    "autoprefixer": "^10.4.20",
    "eslint": "^8",
    "eslint-config-next": "14.2.18",
    "postcss": "^8",
    "tailwindcss": "^3.4.14",
    "typescript": "^5"
  }
}
```

### `next.config.js`

```js
const withPWA = require("@ducanh2912/next-pwa").default({
  dest: "public",
  cacheOnFrontEndNav: true,
  reloadOnOnline: true,
  disable: process.env.NODE_ENV === "development",
});

/** @type {import('next').NextConfig} */
const nextConfig = {};

module.exports = withPWA(nextConfig);
```

### `tailwind.config.ts`

```ts
import type { Config } from "tailwindcss";
import plugin from "tailwindcss/plugin";

const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        charcoal: {
          DEFAULT: "#1A1A1A",
          light: "#282828",
          dark: "#333333",
        },
        tileRowAlt: "#2C2C2C",
        accent: {
          DEFAULT: "#50C878",
          light: "#6DD493",
          dark: "#3DB368",
        },
      },
    },
  },
  plugins: [
    plugin(({ addVariant }) => {
      addVariant("standalone", "@media (display-mode: standalone)");
    }),
  ],
};

export default config;
```

### `tsconfig.json`

```json
{
  "compilerOptions": {
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./*"] },
    "target": "ES2017"
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

### `.env.example`

```env
# Google Apps Script Web App URL (deploy > Web app > Anyone, URL ends in /exec)
NEXT_PUBLIC_GOOGLE_APPS_SCRIPT_URL=

# Neon Postgres connection string (pooled/Transaction mode)
DATABASE_URL=

# SnapTrade (server-side only). Leave blank to disable live brokerage balances.
SNAPTRADE_CLIENT_ID=
SNAPTRADE_CONSUMER_KEY=
SNAPTRADE_USER_ID=
SNAPTRADE_USER_SECRET=
```

### `vercel.json`

```json
{
  "framework": "nextjs"
}
```

---

## PART 4: CSS

### `app/globals.css`

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

:root {
  --charcoal: #161616;
  --charcoal-light: #282828;
  --charcoal-dark: #333333;
  --accent: #50C878;
  --accent-light: #6DD493;
  --accent-dark: #3DB368;
}

body {
  @apply bg-charcoal text-gray-100 antialiased;
}

/* Remove focus/selection outline on pie chart tap (Recharts internal focus ring) */
.expense-pie-chart *:focus {
  outline: none;
}

/* Cross-browser range input styling for investment calculator sliders */
input[type="range"] {
  @apply appearance-none h-2 rounded-full cursor-pointer;
  accent-color: #50C878;
}
input[type="range"]::-webkit-slider-runnable-track {
  @apply h-2 rounded-full bg-charcoal-dark;
}
input[type="range"]::-moz-range-track {
  @apply h-2 rounded-full;
  background-color: #333333;
}

@layer utilities {
  .scrollbar-thin {
    scrollbar-width: thin;
    scrollbar-color: var(--charcoal-light) var(--charcoal);
  }

  .scrollbar-glass {
    scrollbar-width: thin;
    scrollbar-color: rgba(255, 255, 255, 0.35) transparent;
  }

  .scrollbar-glass::-webkit-scrollbar {
    width: 6px;
  }

  .scrollbar-glass::-webkit-scrollbar-track {
    background: transparent;
  }

  .scrollbar-glass::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.22);
    border-radius: 3px;
  }
}
```

---

## PART 5: Database SQL

### `docs/neon-budget-setup.sql` — Run First

```sql
-- Safe to re-run: every CREATE uses IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS budget_store (
  id integer primary key default 1,
  data jsonb not null default '{}'
);

INSERT INTO budget_store (id, data) VALUES (1, '{}')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS processed_transactions (
  hash TEXT PRIMARY KEY,
  account_name TEXT,
  processed_at TIMESTAMP DEFAULT now()
);

CREATE TABLE IF NOT EXISTS account_anchors (
  account_name TEXT PRIMARY KEY,
  confirmed_balance NUMERIC,
  as_of_date DATE
);

CREATE TABLE IF NOT EXISTS reconciliation_claim_links (
  bank_hash TEXT NOT NULL,
  account_name TEXT,
  sheet_name TEXT NOT NULL DEFAULT 'Expenses',
  sheet_row_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  created_at TIMESTAMP DEFAULT now(),
  PRIMARY KEY (bank_hash, sheet_name, sheet_row_id),
  UNIQUE (sheet_name, sheet_row_id)
);

CREATE TABLE IF NOT EXISTS reconciliation_transfer_claim_links (
  transfer_sheet_row_id TEXT NOT NULL,
  bank_hash TEXT NOT NULL,
  bank_account_name TEXT,
  bank_amount_cents INTEGER NOT NULL,
  expected_legs INTEGER NOT NULL DEFAULT 2 CHECK (expected_legs IN (1, 2)),
  created_at TIMESTAMP DEFAULT now(),
  PRIMARY KEY (transfer_sheet_row_id, bank_hash),
  UNIQUE (bank_hash)
);

CREATE TABLE IF NOT EXISTS reconciliation_statement_dismissals (
  hash TEXT NOT NULL,
  account_name TEXT NOT NULL,
  note TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT now(),
  PRIMARY KEY (hash, account_name)
);

CREATE TABLE IF NOT EXISTS reconciliation_merchant_memory (
  fingerprint TEXT NOT NULL,
  bank_account_name TEXT NOT NULL,
  sheet_category TEXT,
  sheet_account TEXT,
  confirmed_count INTEGER NOT NULL DEFAULT 1,
  last_confirmed_at TIMESTAMP DEFAULT now(),
  PRIMARY KEY (fingerprint, bank_account_name)
);

CREATE TABLE IF NOT EXISTS reconciliation_activity_log (
  id UUID PRIMARY KEY,
  occurred_at TIMESTAMP NOT NULL DEFAULT now(),
  action_type TEXT NOT NULL,
  actor TEXT NOT NULL,
  csv_upload_id UUID,
  bulk_action_id UUID,
  parent_action_id UUID,
  payload JSONB NOT NULL,
  reverted_at TIMESTAMP,
  reverted_by_action_id UUID
);
CREATE INDEX IF NOT EXISTS idx_activity_log_occurred
  ON reconciliation_activity_log(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_log_csv
  ON reconciliation_activity_log(csv_upload_id);
```

### `docs/neon-manual-assets-liabilities.sql` — Run Second

```sql
CREATE TABLE IF NOT EXISTS manual_assets (
  id text PRIMARY KEY,
  name text NOT NULL,
  value numeric(14, 2) NOT NULL,
  category text NOT NULL,
  acquisition_date date,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS manual_liabilities (
  id text PRIMARY KEY,
  name text NOT NULL,
  value numeric(14, 2) NOT NULL,
  category text NOT NULL,
  acquisition_date date,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE manual_assets ADD COLUMN IF NOT EXISTS acquisition_date date;
ALTER TABLE manual_assets ADD COLUMN IF NOT EXISTS details jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE manual_liabilities ADD COLUMN IF NOT EXISTS acquisition_date date;
ALTER TABLE manual_liabilities ADD COLUMN IF NOT EXISTS details jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS snaptrade_balance_snapshots (
  id bigserial PRIMARY KEY,
  fetched_at timestamptz NOT NULL,
  balances jsonb NOT NULL,
  account_count integer NOT NULL,
  matched_accounts integer NOT NULL,
  detail_failures integer NOT NULL,
  fidelity_total numeric(14, 2) NOT NULL DEFAULT 0,
  fidelity_brokerage numeric(14, 2) NOT NULL DEFAULT 0,
  fidelity_roth_ira numeric(14, 2) NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_snaptrade_balance_snapshots_fetched_at
ON snaptrade_balance_snapshots (fetched_at DESC);
```

---

## PART 6: Google Apps Script

### `docs/google-apps-script-sample.js`

Paste this entire file into Google Apps Script editor, replacing `YOUR_SPREADSHEET_ID_HERE`:

```js
const SPREADSHEET_ID = "YOUR_SPREADSHEET_ID_HERE";
const EXPENSE_SHEET_NAME = "Expenses";
const TRANSFERS_SHEET_NAME = "Transfers";

function getSheet(name) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  return ss.getSheetByName(name);
}

function appendByHeaders(sheet, valuesByHeader) {
  const lastCol = Math.max(sheet.getLastColumn(), 1);
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const row = headers.map((header) => valuesByHeader[header] != null ? valuesByHeader[header] : "");
  sheet.appendRow(row);
}

function parseNumber(value) {
  const raw = String(value == null ? "" : value).replace(/[$,]/g, "").trim();
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function firstNonEmpty(obj, keys, fallback) {
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
    const value = obj[key];
    if (value == null) continue;
    const s = String(value).trim();
    if (s) return value;
  }
  return fallback;
}

function getIncomingBody(e) {
  const params = (e && e.parameter) ? e.parameter : {};
  let jsonBody = {};
  const raw = e && e.postData && typeof e.postData.contents === "string"
    ? e.postData.contents.trim() : "";
  if (raw) {
    try { jsonBody = JSON.parse(raw); } catch (_) {}
  }
  const merged = Object.assign({}, params, jsonBody);
  return {
    sheet: String(firstNonEmpty(merged, ["sheet", "Sheet"], EXPENSE_SHEET_NAME)),
    expenseType: String(firstNonEmpty(merged, ["expenseType", "Expense Type", "expense_type", "type"], "")),
    amount: parseNumber(firstNonEmpty(merged, ["amount", "Amount", "transferAmount", "Transfer Amount"], "")),
    description: String(firstNonEmpty(merged, ["description", "Description", "notes", "note"], "")),
    transferFrom: String(firstNonEmpty(merged, ["transferFrom", "Transfer from", "Transfer From"], "")),
    transferTo: String(firstNonEmpty(merged, ["transferTo", "Transfer To"], "")),
  };
}

function doGet(e) {
  const sheetName = (e && e.parameter && e.parameter.sheet) || EXPENSE_SHEET_NAME;
  const sheet = getSheet(sheetName);
  if (!sheet) {
    return ContentService.createTextOutput(JSON.stringify({ error: "Sheet not found: " + sheetName }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const monthParam = (e && e.parameter) ? e.parameter.month : undefined;
  const rows = [];
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (row.every(c => c === "" || c === null)) continue;
    const obj = {};
    headers.forEach((header, j) => { obj[header] = row[j]; });
    if (!obj["Row ID"] && sheetName === EXPENSE_SHEET_NAME) obj["Row ID"] = "";
    if (!obj["Transfer Row ID"] && sheetName === TRANSFERS_SHEET_NAME) obj["Transfer Row ID"] = "";
    if (monthParam && monthParam !== "full") {
      const rowMonth = String((obj["Month"] != null ? obj["Month"] : "")).trim();
      if (rowMonth !== monthParam) continue;
    }
    rows.push(obj);
  }
  return ContentService.createTextOutput(JSON.stringify(rows)).setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  try {
    const body = getIncomingBody(e);
    const sheetName = body.sheet || EXPENSE_SHEET_NAME;
    const sheet = getSheet(sheetName);
    if (!sheet) {
      return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "Sheet not found: " + sheetName }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    const timestamp = new Date();
    const rowId = Utilities.getUuid();
    const transferRowId = Utilities.getUuid();
    if (sheetName === TRANSFERS_SHEET_NAME) {
      if (!Number.isFinite(body.amount) || body.amount <= 0) {
        return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "Transfer amount must be a positive number." }))
          .setMimeType(ContentService.MimeType.JSON);
      }
      appendByHeaders(sheet, {
        "Timestamp": timestamp,
        "Transfer from": body.transferFrom || "",
        "Transfer From": body.transferFrom || "",
        "Transfer To": body.transferTo || "",
        "Transfer Amount": body.amount,
        "Transfer Row ID": transferRowId,
      });
    } else {
      if (!body.expenseType) {
        return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "Expense Type is required." }))
          .setMimeType(ContentService.MimeType.JSON);
      }
      if (!Number.isFinite(body.amount) || body.amount <= 0) {
        return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "Amount must be a positive number." }))
          .setMimeType(ContentService.MimeType.JSON);
      }
      appendByHeaders(sheet, {
        "Timestamp": timestamp,
        "Expense Type": body.expenseType || "",
        "Amount": body.amount,
        "Description": body.description || "",
        "Row ID": rowId,
      });
    }
    return ContentService.createTextOutput(JSON.stringify({ status: "success" })).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ status: "error", message: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
```

---

## PART 7: App Entry Points

### `app/layout.tsx`

```tsx
import type { Metadata, Viewport } from "next";
import "./globals.css";
import Providers from "@/components/Providers";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
};

export const metadata: Metadata = {
  title: "Stash",
  description: "Track expenses, budget, and net worth",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Stash",
  },
  icons: {
    icon: { url: "/favicon.svg", type: "image/svg+xml" },
    apple: "/icons/apple-touch-icon.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-charcoal">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
```

### `app/manifest.ts`

```ts
import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Stash",
    short_name: "Stash",
    description: "Track expenses, budget, and net worth",
    start_url: "/",
    display: "standalone",
    background_color: "#282828",
    theme_color: "#282828",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
```

### `app/budget/page.tsx`

```tsx
import { redirect } from "next/navigation";
export default function BudgetPage() {
  redirect("/");
}
```

### `app/contact/layout.tsx`

```tsx
export default function ContactLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
```

### `app/contact/page.tsx`

```tsx
export default function ContactPage() {
  return (
    <div className="min-h-screen bg-charcoal flex items-center justify-center p-6">
      <div className="rounded-xl bg-[#252525] border border-charcoal-dark p-8 max-w-sm w-full">
        <h1 className="text-xl font-semibold text-white mb-4">Contact</h1>
        <a href="mailto:your@email.com" className="text-accent hover:text-accent-light">
          your@email.com
        </a>
      </div>
    </div>
  );
}
```

---

## PART 8: Lib Files

### `lib/constants.ts`

```ts
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

export const LEGACY_EXPENSE_CATEGORY_ALIASES: Record<string, string> = {
  Beauty: "Personal Care",
};

export function normalizeExpenseCategoryType(expenseType: string): string {
  return LEGACY_EXPENSE_CATEGORY_ALIASES[expenseType] ?? expenseType;
}

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

export const CATEGORY_COLORS: Record<string, string> = {};
EXPENSE_CATEGORIES.forEach((cat, i) => {
  CATEGORY_COLORS[cat] = PIE_COLORS[i % PIE_COLORS.length];
});

export const BUDGET_STORAGE_KEY = "financial-dashboard-budget-goals";

export const ASSET_CATEGORIES = ["Real Estate", "Vehicle", "Personal"] as const;

export const LIABILITY_CATEGORIES = ["Credit Card", "Loan", "Mortgage"] as const;
```

### `lib/budgetCategoryMigration.ts`

```ts
import { LEGACY_EXPENSE_CATEGORY_ALIASES } from "./constants";

export type MonthlyBudgets = Record<string, Record<string, number>>;

export function migrateBudgetCategoryKeys(data: MonthlyBudgets): MonthlyBudgets {
  let changed = false;
  const out: MonthlyBudgets = {};
  for (const [monthKey, monthMap] of Object.entries(data)) {
    const next: Record<string, number> = { ...monthMap };
    for (const [oldName, newName] of Object.entries(LEGACY_EXPENSE_CATEGORY_ALIASES)) {
      if (oldName in next) {
        const v = next[oldName]!;
        next[newName] = (next[newName] ?? 0) + v;
        delete next[oldName];
        changed = true;
      }
    }
    out[monthKey] = next;
  }
  return changed ? out : data;
}
```

### `lib/merchantFingerprint.ts`

```ts
export function generateMerchantFingerprint(description: string, amount: number): string {
  let normalized = String(description ?? "").toLowerCase();
  normalized = normalized.replace(/\d{4}[-/]\d{1,2}[-/]\d{1,2}/g, " ");
  normalized = normalized.replace(/\d{1,2}[-/]\d{1,2}(?:[-/]\d{2,4})?/g, " ");
  normalized = normalized.replace(/\d{5,}/g, " ");
  normalized = normalized.replace(/\b(ref|id|txn|auth|seq)#?\s*\w+\b/g, " ");
  normalized = normalized.replace(/[^a-z0-9 ]+/g, " ");
  normalized = normalized.replace(/\s+/g, " ").trim();
  const dollarBucket = Math.round(Math.abs(Number(amount) || 0));
  return `${dollarBucket}|${normalized}`;
}
```

### `lib/activityLog.ts`

Defines activity log action types and Neon insert helpers for the reconciliation audit trail:

```ts
import { neon } from "@neondatabase/serverless";

export type ActivityActionType =
  | "claim_create"
  | "claim_delete"
  | "dismiss_create"
  | "dismiss_delete"
  | "anchor_create"
  | "anchor_delete"
  | "transfer_claim_create"
  | "transfer_claim_delete"
  | "user_dismiss_create"
  | "user_dismiss_delete";

export type ActivityActor = "user" | "auto";

export type ActivityPayload = Record<string, unknown>;

export async function insertActivityLog(
  sql: ReturnType<typeof neon>,
  params: {
    id: string;
    action_type: ActivityActionType;
    actor: ActivityActor;
    csv_upload_id?: string | null;
    bulk_action_id?: string | null;
    parent_action_id?: string | null;
    payload: ActivityPayload;
  }
): Promise<void> {
  await sql`
    INSERT INTO reconciliation_activity_log
      (id, action_type, actor, csv_upload_id, bulk_action_id, parent_action_id, payload)
    VALUES
      (${params.id}::uuid,
       ${params.action_type},
       ${params.actor},
       ${params.csv_upload_id ?? null}::uuid,
       ${params.bulk_action_id ?? null}::uuid,
       ${params.parent_action_id ?? null}::uuid,
       ${params.payload})
  `;
}
```

---

## PART 9: Context Files

### `contexts/MonthContext.tsx`

```tsx
"use client";
import { createContext, useContext, useState, type ReactNode } from "react";

export const MONTH_OPTIONS = [
  ...["January","February","March","April","May","June","July","August","September","October","November","December"]
    .map((m, i) => ({ value: `${i + 1}`, label: `${m} 2026` })),
  { value: "full", label: "Full Year 2026" },
];

type MonthContextType = {
  selectedMonth: string;
  setSelectedMonth: (value: string) => void;
  selectedLabel: string;
};

const MonthContext = createContext<MonthContextType | null>(null);

function getCurrentMonthValue(): string {
  return String(new Date().getMonth() + 1);
}

export function MonthProvider({ children }: { children: ReactNode }) {
  const [selectedMonth, setSelectedMonth] = useState(getCurrentMonthValue);
  const selectedLabel = MONTH_OPTIONS.find((o) => o.value === selectedMonth)?.label ?? "Full Year 2026";
  return (
    <MonthContext.Provider value={{ selectedMonth, setSelectedMonth, selectedLabel }}>
      {children}
    </MonthContext.Provider>
  );
}

export function useMonth() {
  const ctx = useContext(MonthContext);
  if (!ctx) throw new Error("useMonth must be used within MonthProvider");
  return ctx;
}
```

**Note:** The year `2026` is hardcoded in `MONTH_OPTIONS`. Update to the current year when recreating, or make it dynamic with `new Date().getFullYear()`.

### `contexts/RefreshContext.tsx`

```tsx
"use client";
import { createContext, useContext, useState, useCallback, type ReactNode } from "react";

type RefreshContextType = {
  refreshKey: number;
  triggerRefresh: () => void;
};

const RefreshContext = createContext<RefreshContextType | null>(null);

export function RefreshProvider({ children }: { children: ReactNode }) {
  const [refreshKey, setRefreshKey] = useState(0);
  const triggerRefresh = useCallback(() => setRefreshKey((k) => k + 1), []);
  return (
    <RefreshContext.Provider value={{ refreshKey, triggerRefresh }}>
      {children}
    </RefreshContext.Provider>
  );
}

export function useRefresh() {
  const ctx = useContext(RefreshContext);
  if (!ctx) throw new Error("useRefresh must be used within RefreshProvider");
  return ctx;
}
```

### `contexts/SidebarContext.tsx`

```tsx
"use client";
import { createContext, useContext, useState, useCallback, type ReactNode } from "react";

type SidebarContextType = {
  collapsed: boolean;
  mobileOpen: boolean;
  toggleCollapsed: () => void;
  toggleMobile: () => void;
  closeMobile: () => void;
};

const SidebarContext = createContext<SidebarContextType | null>(null);

export function SidebarProvider({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const toggleCollapsed = useCallback(() => setCollapsed((c) => !c), []);
  const toggleMobile = useCallback(() => setMobileOpen((o) => !o), []);
  const closeMobile = useCallback(() => setMobileOpen(false), []);
  return (
    <SidebarContext.Provider value={{ collapsed, mobileOpen, toggleCollapsed, toggleMobile, closeMobile }}>
      {children}
    </SidebarContext.Provider>
  );
}

export function useSidebar() {
  const ctx = useContext(SidebarContext);
  if (!ctx) throw new Error("useSidebar must be used within SidebarProvider");
  return ctx;
}
```

### `contexts/ExpensesDataContext.tsx`

```tsx
"use client";
import { createContext, useContext, useState, useEffect, type ReactNode } from "react";
import { useRefresh } from "@/contexts/RefreshContext";
import { getExpenses, getTransfers } from "@/services/sheetsApi";
import type { SheetRow, TransferRow } from "@/services/sheetsApi";

type ExpensesDataContextType = {
  allRows: SheetRow[];
  allTransfers: TransferRow[];
  loading: boolean;
  error: string | null;
};

const ExpensesDataContext = createContext<ExpensesDataContextType | null>(null);
const CACHE_KEY = "stash_expenses_v1";

type CachedData = { allRows: SheetRow[]; allTransfers: TransferRow[] };

function readCache(): CachedData | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as CachedData;
  } catch { return null; }
}

function writeCache(allRows: SheetRow[], allTransfers: TransferRow[]) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ allRows, allTransfers })); } catch {}
}

export function ExpensesDataProvider({ children }: { children: ReactNode }) {
  const { refreshKey } = useRefresh();
  const [allRows, setAllRows] = useState<SheetRow[]>(() =>
    typeof window === "undefined" ? [] : (readCache()?.allRows ?? [])
  );
  const [allTransfers, setAllTransfers] = useState<TransferRow[]>(() =>
    typeof window === "undefined" ? [] : (readCache()?.allTransfers ?? [])
  );
  const [loading, setLoading] = useState(() =>
    typeof window === "undefined" ? true : readCache() === null
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    Promise.all([getExpenses(), getTransfers()])
      .then(([rows, transfers]) => {
        if (!cancelled) {
          setAllRows(rows);
          setAllTransfers(transfers);
          writeCache(rows, transfers);
          setError(null);
        }
      })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [refreshKey]);

  return (
    <ExpensesDataContext.Provider value={{ allRows, allTransfers, loading, error }}>
      {children}
    </ExpensesDataContext.Provider>
  );
}

export function useExpensesData() {
  const ctx = useContext(ExpensesDataContext);
  if (!ctx) throw new Error("useExpensesData must be used within ExpensesDataProvider");
  return ctx;
}
```

---

## PART 10: Services

### `services/sheetsApi.ts`

```ts
const SHEETS_API = "/api/sheets";

export type SheetRow = {
  timestamp?: string;
  date?: string;
  expenseType: string;
  amount: number;
  description: string;
  month: string;
  account?: string;
  rowId?: string;
};

function getRawValue(raw: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (raw[key] !== undefined) return raw[key];
  }
  const normalized = new Map<string, unknown>();
  for (const [k, v] of Object.entries(raw)) normalized.set(k.trim().toLowerCase(), v);
  for (const key of keys) {
    const value = normalized.get(key.trim().toLowerCase());
    if (value !== undefined) return value;
  }
  return undefined;
}

function normalizeRow(raw: Record<string, unknown>): SheetRow {
  const account = String(getRawValue(raw, ["Account", "account"]) ?? "");
  const rowIdRaw = getRawValue(raw, ["Row ID", "row id", "rowId", "row_id", "Row Id"]);
  const rowId = typeof rowIdRaw === "string" ? rowIdRaw.trim() : "";
  const dateRaw = getRawValue(raw, ["Date", "date"]);
  const dateStr = typeof dateRaw === "string" ? dateRaw.trim() : "";
  return {
    timestamp: (getRawValue(raw, ["Timestamp", "timestamp"]) as string | undefined),
    date: dateStr || undefined,
    expenseType: String(getRawValue(raw, ["Expense Type", "expenseType", "expense type"]) ?? ""),
    amount: Number(getRawValue(raw, ["Amount", "amount"]) ?? 0),
    description: String(getRawValue(raw, ["Description", "description"]) ?? ""),
    month: String(getRawValue(raw, ["Month", "month"]) ?? ""),
    account: account.trim() || undefined,
    rowId: rowId || undefined,
  };
}

function monthNameFromNumber(month: number): string {
  return ["january","february","march","april","may","june","july","august","september","october","november","december"][month - 1] ?? "";
}

export function rowMatchesMonth(row: SheetRow, selectedMonth?: string): boolean {
  if (!selectedMonth || selectedMonth === "full") return true;
  const monthNum = Number(selectedMonth);
  if (!Number.isFinite(monthNum) || monthNum < 1 || monthNum > 12) return true;
  const rawMonth = String(row.month ?? "").trim().toLowerCase();
  if (rawMonth) {
    const monthName = monthNameFromNumber(monthNum);
    const normalizedNumeric = String(parseInt(rawMonth, 10));
    if (rawMonth === String(monthNum) || rawMonth === monthName ||
        rawMonth === `${monthName} 2026` || normalizedNumeric === String(monthNum)) return true;
  }
  if (row.timestamp) {
    const d = new Date(row.timestamp);
    if (!Number.isNaN(d.getTime()) && d.getMonth() + 1 === monthNum) return true;
  }
  return false;
}

export async function getExpenses(month?: string): Promise<SheetRow[]> {
  const url = month ? `${SHEETS_API}?month=${encodeURIComponent(month)}` : SHEETS_API;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `Failed to fetch expenses: ${res.status}`);
  }
  const data = await res.json();
  const rows: Record<string, unknown>[] = Array.isArray(data) ? data : (data.rows ?? data.data ?? []);
  return rows.map(normalizeRow).filter((row) => rowMatchesMonth(row, month));
}

export async function submitExpense(payload: {
  expenseType: string;
  amount: number;
  description: string;
  date?: string;
}): Promise<void> {
  const res = await fetch(SHEETS_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `Failed to submit: ${res.status}`);
  }
}

export async function updateSheetEntryDate(payload: {
  sheet: "Expenses" | "Transfers";
  rowId: string;
  date: string;
}): Promise<void> {
  const res = await fetch(SHEETS_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "update", ...payload }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `Failed to update: ${res.status}`);
  }
}

export type TransferRow = {
  timestamp?: string;
  date?: string;
  transferFrom: string;
  transferTo: string;
  amount: number;
  transferRowId?: string;
  description?: string;
  month: string;
};

function normalizeTransferRow(raw: Record<string, unknown>): TransferRow {
  const transferTo = String(getRawValue(raw, ["Transfer To", "transferTo", "transfer to"]) ?? "");
  const transferRowIdRaw = getRawValue(raw, ["Transfer Row ID","transfer row id","transferRowId","transfer_row_id","Transfer Row Id"]);
  const transferRowId = typeof transferRowIdRaw === "string" ? transferRowIdRaw.trim() : "";
  const dateRaw = getRawValue(raw, ["Date", "date"]);
  const dateStr = typeof dateRaw === "string" ? dateRaw.trim() : "";
  return {
    timestamp: (getRawValue(raw, ["Timestamp", "timestamp"]) as string | undefined),
    date: dateStr || undefined,
    transferFrom: String(getRawValue(raw, ["Transfer from","Transfer From","transferFrom","transfer from"]) ?? ""),
    transferTo,
    amount: Number(getRawValue(raw, ["Transfer Amount","transfer amount","amount"]) ?? 0),
    transferRowId: transferRowId || undefined,
    description: (() => {
      const d = getRawValue(raw, ["Transfer Description","Transfer Descriptior","transfer description","description"]);
      const s = typeof d === "string" ? d.trim() : "";
      return s || undefined;
    })(),
    month: String(getRawValue(raw, ["Month", "month"]) ?? ""),
  };
}

export function transferMatchesMonth(row: TransferRow, selectedMonth?: string): boolean {
  if (!selectedMonth || selectedMonth === "full") return true;
  const monthNum = Number(selectedMonth);
  if (!Number.isFinite(monthNum) || monthNum < 1 || monthNum > 12) return true;
  const rawMonth = String(row.month ?? "").trim().toLowerCase();
  if (rawMonth) {
    const monthName = monthNameFromNumber(monthNum);
    const normalizedNumeric = String(parseInt(rawMonth, 10));
    if (rawMonth === String(monthNum) || rawMonth === monthName ||
        rawMonth === `${monthName} 2026` || normalizedNumeric === String(monthNum)) return true;
  }
  if (row.timestamp) {
    const d = new Date(row.timestamp);
    if (!Number.isNaN(d.getTime()) && d.getMonth() + 1 === monthNum) return true;
  }
  return false;
}

export async function getTransfers(month?: string): Promise<TransferRow[]> {
  const params = new URLSearchParams({ sheet: "Transfers" });
  if (month) params.set("month", month);
  const res = await fetch(`${SHEETS_API}?${params.toString()}`, { cache: "no-store" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `Failed to fetch transfers: ${res.status}`);
  }
  const data = await res.json();
  const rows: Record<string, unknown>[] = Array.isArray(data) ? data : (data.rows ?? data.data ?? []);
  return rows.map(normalizeTransferRow).filter((row) => transferMatchesMonth(row, month));
}

export async function submitTransfer(payload: {
  transferFrom: string;
  transferTo: string;
  amount: number;
}): Promise<void> {
  const res = await fetch(SHEETS_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sheet: "Transfers", ...payload }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `Failed to submit transfer: ${res.status}`);
  }
}
```

### `services/accountBalancesService.ts`

This service computes running account balances from base amounts + all transfers + expense/income rows, then overrides investment accounts with live SnapTrade values.

**Key concept:** When an account has an `AccountAnchor` (a confirmed balance as of a specific date), the balance starts from that confirmed value and only transactions *after* the anchor date are applied. This lets the user periodically "anchor" their account to a known-correct balance.

```ts
import type { SheetRow, TransferRow } from "@/services/sheetsApi";
import type { SupportedBroker } from "@/services/snaptradeApi";

export const TRANSFER_LABEL_TO_BALANCE_KEY: Record<string, string> = {
  "WF Checking": "Wells Fargo Checking",
  "WF Savings": "Wells Fargo Savings",
  "Venmo - Daniel": "Venmo - Daniel",
  "Venmo - Katie": "Venmo - Katie",
  Venmo: "Venmo - Daniel",
  Fidelity: "Fidelity",
  Robinhood: "Robinhood",
  My529: "My529",
  "Charles Schwab": "Charles Schwab",
  Ally: "Ally",
  "Capital One": "Capital One",
  "America First": "America First",
  Discover: "Discover",
};

// IMPORTANT: These base balances are calibrated to a specific historical date.
// When recreating, set these to your actual account balances on the date your
// Google Sheets history begins, OR set all to 0 and use anchors for each account.
export const BASE_ACCOUNT_BALANCES: Record<string, number> = {
  "Wells Fargo Checking": 427.1,
  "Wells Fargo Savings": 1061.13,
  "Venmo - Daniel": 28.24,
  "Venmo - Katie": 28.23,
  Fidelity: 10597.43,
  Robinhood: 711.39,
  My529: 0,
  "Charles Schwab": 0,
  Ally: 0,
  "Capital One": 0,
  "America First": 0,
  Discover: 0,
};

const LIVE_BROKER_ACCOUNT_KEYS: SupportedBroker[] = ["Fidelity", "Robinhood", "Charles Schwab"];

export type AccountAnchor = {
  accountName: string;
  confirmedBalance: number;
  asOfDate: string;
};

function toDateKey(value?: string): string {
  if (!value) return "";
  const raw = String(value).trim();
  if (!raw) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return "";
  const y = parsed.getUTCFullYear();
  const m = String(parsed.getUTCMonth() + 1).padStart(2, "0");
  const d = String(parsed.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function mapAccountNameToBalanceKey(raw: string): string {
  const name = raw.trim();
  if (!name) return name;
  const lower = name.toLowerCase();
  if (lower === "wf checking" || lower === "wells fargo" || lower === "wells fargo checking") return "Wells Fargo Checking";
  if (lower === "wf savings" || lower === "wells fargo savings") return "Wells Fargo Savings";
  if (lower === "venmo - daniel") return "Venmo - Daniel";
  if (lower === "venmo - katie") return "Venmo - Katie";
  if (lower === "venmo") return "Venmo - Daniel";
  return name;
}

function shouldApplyByAnchor(accountKey: string, transactionDate: string, anchorByAccount: Map<string, AccountAnchor>): boolean {
  const anchor = anchorByAccount.get(accountKey);
  if (!anchor) return true;
  const txDate = toDateKey(transactionDate);
  const anchorDate = toDateKey(anchor.asOfDate);
  if (!anchorDate) return true;
  if (!txDate) return false;
  return txDate > anchorDate;
}

function buildAnchorMap(anchors: AccountAnchor[]): Map<string, AccountAnchor> {
  const map = new Map<string, AccountAnchor>();
  for (const anchor of anchors) {
    if (!Number.isFinite(anchor.confirmedBalance)) continue;
    const key = mapAccountNameToBalanceKey(anchor.accountName);
    map.set(key, { accountName: key, confirmedBalance: Number(anchor.confirmedBalance), asOfDate: toDateKey(anchor.asOfDate) });
  }
  return map;
}

function accountKeyForSheetRow(row: SheetRow): string {
  const fromSheet = mapAccountNameToBalanceKey(String(row.account ?? "").trim());
  if (fromSheet) return fromSheet;
  return "Wells Fargo Checking";
}

export async function getAccountAnchors(): Promise<AccountAnchor[]> {
  const res = await fetch("/api/reconciliation/anchors", { cache: "no-store" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `Failed to fetch account anchors: ${res.status}`);
  }
  const data = (await res.json()) as { anchors?: Array<Partial<AccountAnchor>> };
  const anchors = Array.isArray(data.anchors) ? data.anchors : [];
  return anchors
    .map((row) => ({
      accountName: String(row.accountName ?? ""),
      confirmedBalance: Number(row.confirmedBalance ?? 0),
      asOfDate: String(row.asOfDate ?? ""),
    }))
    .filter((row) => row.accountName.trim() !== "" && Number.isFinite(row.confirmedBalance));
}

export function computeAccountBalances(
  allRows: SheetRow[],
  allTransfers: TransferRow[],
  liveBrokerBalances: Partial<Record<SupportedBroker, number>>,
  accountAnchors: AccountAnchor[] = [],
): Record<string, number> {
  const anchorByAccount = buildAnchorMap(accountAnchors);
  const balances: Record<string, number> = { ...BASE_ACCOUNT_BALANCES };

  for (const [accountKey, anchor] of anchorByAccount.entries()) {
    balances[accountKey] = anchor.confirmedBalance;
  }

  for (const t of allTransfers) {
    const amt = Number(t.amount);
    if (!Number.isFinite(amt) || amt === 0) continue;
    const txDate = toDateKey(t.timestamp);
    const fromLabel = t.transferFrom.trim();
    const toLabel = t.transferTo.trim();
    const fromKey = mapAccountNameToBalanceKey(TRANSFER_LABEL_TO_BALANCE_KEY[fromLabel] ?? "");
    const toKey = mapAccountNameToBalanceKey(TRANSFER_LABEL_TO_BALANCE_KEY[toLabel] ?? "");
    if (fromKey && balances[fromKey] !== undefined && shouldApplyByAnchor(fromKey, txDate, anchorByAccount)) {
      balances[fromKey] -= amt;
    }
    if (toLabel !== "Misc." && toKey && balances[toKey] !== undefined && shouldApplyByAnchor(toKey, txDate, anchorByAccount)) {
      balances[toKey] += amt;
    }
  }

  for (const row of allRows) {
    const amount = Number(row.amount || 0);
    if (!Number.isFinite(amount) || amount === 0) continue;
    const accountKey = accountKeyForSheetRow(row);
    if (balances[accountKey] === undefined) continue;
    if (!shouldApplyByAnchor(accountKey, toDateKey(row.timestamp), anchorByAccount)) continue;
    if (row.expenseType === "Income") balances[accountKey] += amount;
    else balances[accountKey] -= amount;
  }

  const merged = { ...balances };
  for (const key of LIVE_BROKER_ACCOUNT_KEYS) {
    const liveValue = liveBrokerBalances[key];
    if (typeof liveValue === "number" && Number.isFinite(liveValue)) merged[key] = liveValue;
  }
  return merged;
}
```

### `services/snaptradeApi.ts` — Spec (rebuild from scratch)

This service wraps the `snaptrade-typescript-sdk` for server-side calls. Build it as a module exporting:

```ts
export type SupportedBroker = "Fidelity" | "Robinhood" | "Charles Schwab";

// fetchSnapTradeBrokerBalances(): calls SnapTrade SDK to list all user accounts
// and their balances, returns Record<SupportedBroker, number>. Server-side only.
// Uses env vars: SNAPTRADE_CLIENT_ID, SNAPTRADE_CONSUMER_KEY, SNAPTRADE_USER_ID, SNAPTRADE_USER_SECRET.
// Match brokerage names by checking if account.brokerage_name includes the broker string.

// fetchSnapTradeHistory(): returns array of { fetched_at, fidelity_total, fidelity_brokerage, fidelity_roth_ira }
// from the snaptrade_balance_snapshots Neon table.

// fetchSnapTradeInvestments(): returns { brokerage: number, rothIra: number }
// where brokerage = sum of non-Roth Fidelity accounts, rothIra = Roth IRA accounts.
```

### `services/netWorthService.ts` — Spec (rebuild from scratch)

Computes net worth summary from expenses, transfers, assets, liabilities:

```ts
// computeNetWorthSummary(allRows, allTransfers, assets, liabilities, liveBrokerBalances):
//   Returns:
//   - totalNetWorth: sum(asset values) - sum(liability values) + broker balances
//   - liquidNetWorth: checking + savings + venmo balances (exclude illiquid assets)
//   - totalIncome: sum of Income rows for period
//   - totalExpenses: sum of non-Income rows for period
//   - savingsRate: (income - expenses) / income
//   - runwayMonths: liquid / (expenses / period_months)
```

---

## PART 11: Components

### `components/Providers.tsx`

```tsx
"use client";
import { MonthProvider } from "@/contexts/MonthContext";
import { RefreshProvider } from "@/contexts/RefreshContext";
import { ExpensesDataProvider } from "@/contexts/ExpensesDataContext";

export default function Providers({ children }: { children: React.ReactNode }) {
  return (
    <MonthProvider>
      <RefreshProvider>
        <ExpensesDataProvider>{children}</ExpensesDataProvider>
      </RefreshProvider>
    </MonthProvider>
  );
}
```

### `components/StashLogo.tsx`

The logo is an SVG circle keyhole shape. Use as `<StashLogo className="text-accent" />` with the wrapper sized at `1.75rem × 1.75rem`.

```tsx
const VIEWBOX = "0 0 1887.9435 1889.0012";

// The path data is a complex keyhole-in-circle SVG shape.
// For recreation, use any SVG keyhole/safe icon as a placeholder, or
// copy the full path from the original StashLogo.tsx file.
const CIRCLE_KEYHOLE_PATH = "..."; // paste full path from original file

export default function StashLogo({ className }: { className?: string }) {
  return (
    <svg
      viewBox={VIEWBOX}
      preserveAspectRatio="xMidYMid meet"
      className={className}
      fill="currentColor"
      aria-hidden
      overflow="visible"
      style={{ display: "block", width: "100%", height: "100%" }}
    >
      <path d={CIRCLE_KEYHOLE_PATH} />
    </svg>
  );
}
```

### `components/DashboardLayout.tsx`

```tsx
"use client";
import { Menu } from "lucide-react";
import Sidebar from "./Sidebar";
import BottomNav from "./BottomNav";
import { SidebarProvider, useSidebar } from "@/contexts/SidebarContext";

function DashboardContent({ children }: { children: React.ReactNode }) {
  const { collapsed, toggleMobile } = useSidebar();
  return (
    <div className="min-h-screen flex">
      <Sidebar />
      <main
        className={`flex-1 flex flex-col min-w-0 pl-0 ${collapsed ? "lg:pl-[72px]" : "lg:pl-64"} standalone:!pl-0`}
        style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
      >
        <div className="lg:hidden standalone:hidden flex items-center p-2 border-b border-charcoal-dark shrink-0">
          <button
            type="button"
            onClick={toggleMobile}
            className="p-2 rounded-lg text-gray-400 hover:text-[#50C878] hover:bg-charcoal transition-colors"
            aria-label="Open menu"
          >
            <Menu className="w-5 h-5" />
          </button>
        </div>
        <div className="flex-1 p-4 md:p-6 overflow-auto standalone:pb-24">{children}</div>
      </main>
      <BottomNav />
    </div>
  );
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <SidebarProvider>
      <DashboardContent>{children}</DashboardContent>
    </SidebarProvider>
  );
}
```

### `components/Sidebar.tsx`

```tsx
"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { PlusCircle, PiggyBank, TrendingUp, ClipboardCheck, Menu, BarChart2 } from "lucide-react";
import { useSidebar } from "@/contexts/SidebarContext";
import StashLogo from "./StashLogo";

const navItems = [
  { href: "/new-expense", label: "New Expense", icon: PlusCircle },
  { href: "/", label: "Budget", icon: PiggyBank },
  { href: "/net-worth", label: "Net Worth", icon: TrendingUp },
  { href: "/reconcile", label: "Reconcile", icon: ClipboardCheck },
  { href: "/investment-calculator", label: "Life-Stage Planner", icon: BarChart2 },
];

export default function Sidebar() {
  const pathname = usePathname();
  const { collapsed, toggleCollapsed, mobileOpen, closeMobile } = useSidebar();

  return (
    <>
      {mobileOpen && (
        <div className="fixed inset-0 z-30 bg-black/50 lg:hidden" onClick={closeMobile} aria-hidden />
      )}
      <aside className={`
        fixed left-0 top-0 z-40 h-screen bg-[#3A3A3A] border-r border-charcoal-dark
        transition-all duration-300 ease-in-out flex flex-col w-64
        lg:translate-x-0 standalone:hidden
        ${collapsed ? "lg:w-[72px]" : "lg:w-64"}
        ${mobileOpen ? "max-lg:translate-x-0" : "max-lg:-translate-x-full"}
      `}>
        <div className={`flex border-b border-charcoal-dark shrink-0 min-h-[4rem]
          ${collapsed ? "flex-col items-center justify-center gap-2 py-3 px-2" : "flex-row items-center justify-between gap-2 py-4 px-4"}`}>
          <div className={`flex items-center min-w-0 ${collapsed ? "justify-center" : "gap-3 flex-1"}`}>
            <span className="flex items-center justify-center shrink-0 text-accent overflow-visible"
              style={{ width: "1.75rem", height: "1.75rem", minWidth: "1.75rem", minHeight: "1.75rem" }}>
              <StashLogo />
            </span>
            {!collapsed && <span className="font-semibold text-white text-xl tracking-tight truncate leading-none">Stash</span>}
          </div>
          <button type="button" onClick={toggleCollapsed}
            className="hidden lg:flex p-2 rounded-lg text-gray-400 hover:text-[#50C878] hover:bg-charcoal transition-colors shrink-0"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}>
            <Menu className="w-5 h-5" />
          </button>
        </div>
        <nav className="flex-1 p-3 space-y-1 overflow-y-auto scrollbar-thin">
          <p className={`px-3 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wider ${collapsed ? "sr-only" : ""}`}>
            Navigation
          </p>
          {navItems.map(({ href, label, icon: Icon }) => {
            const isActive = (href === "/" && pathname === "/") || (href !== "/" && pathname.startsWith(href));
            return (
              <Link key={href} href={href} onClick={closeMobile}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors
                  ${isActive ? "bg-[#50C878] text-white" : "text-gray-300 hover:bg-charcoal hover:text-white"}
                  ${collapsed ? "justify-center px-2" : ""}`}>
                <Icon className="w-5 h-5 shrink-0" />
                {!collapsed && <span>{label}</span>}
              </Link>
            );
          })}
        </nav>
        <div className="p-3 border-t border-charcoal-dark shrink-0">
          {!collapsed && <p className="text-xs text-gray-500 px-3">Stash v1</p>}
        </div>
      </aside>
    </>
  );
}
```

### `components/BottomNav.tsx`

Shows only in PWA standalone mode (`display-mode: standalone`). Positioned fixed at the bottom.

```tsx
"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { PlusCircle, ClipboardCheck, PiggyBank, TrendingUp, BarChart2 } from "lucide-react";

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
    <nav className="hidden standalone:flex fixed bottom-0 left-0 right-0 z-50 bg-[#3A3A3A] border-t border-charcoal-dark items-center justify-around"
      style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}>
      {navItems.map(({ href, icon: Icon, label }) => {
        const isActive = (href === "/" && pathname === "/") || (href !== "/" && pathname.startsWith(href));
        return (
          <Link key={href} href={href} aria-label={label}
            className={`flex items-center justify-center p-4 transition-colors ${isActive ? "text-[#50C878]" : "text-gray-400 hover:text-gray-200"}`}>
            <Icon className="w-7 h-7" />
          </Link>
        );
      })}
    </nav>
  );
}
```

### `components/GlassDropdown.tsx`

Portal-rendered dropdown with glass-morphism panel. Used throughout the app.

```tsx
"use client";
import { useState, useRef, useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronDown } from "lucide-react";

export type GlassDropdownOption = { value: string; label: string };
export type GlassDropdownProps = {
  value: string;
  onChange: (value: string) => void;
  options: GlassDropdownOption[];
  placeholder?: string;
  className?: string;
  panelClassName?: string;
  "aria-label"?: string;
  id?: string;
  disabled?: boolean;
  leadingIcon?: ReactNode;
};

export default function GlassDropdown({ value, onChange, options, placeholder = "", className = "", panelClassName, "aria-label": ariaLabel, id, disabled = false, leadingIcon }: GlassDropdownProps) {
  const [open, setOpen] = useState(false);
  const [panelStyle, setPanelStyle] = useState<React.CSSProperties>({});
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node) && panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false);
    }
    function handleEscape(e: KeyboardEvent) { if (e.key === "Escape") setOpen(false); }
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => { document.removeEventListener("mousedown", handleClickOutside); document.removeEventListener("keydown", handleEscape); };
  }, []);

  useEffect(() => {
    if (!open || !buttonRef.current) return;
    function recalculate() {
      const rect = buttonRef.current!.getBoundingClientRect();
      setPanelStyle({ position: "fixed", top: rect.bottom + 4, left: rect.left, width: rect.width, maxHeight: Math.max(80, window.innerHeight - rect.bottom - 8), zIndex: 9999 });
    }
    recalculate();
    window.addEventListener("scroll", recalculate, { passive: true, capture: true });
    window.addEventListener("resize", recalculate, { passive: true });
    return () => { window.removeEventListener("scroll", recalculate, { capture: true }); window.removeEventListener("resize", recalculate); };
  }, [open]);

  const selected = options.find((o) => o.value === value);
  const displayLabel = selected?.label ?? (value ? value : placeholder);
  const showPlaceholder = !selected && (!value || value === "");

  return (
    <div className={`relative ${className}`} ref={ref}>
      <button id={id} ref={buttonRef} type="button" disabled={disabled} onClick={() => !disabled && setOpen((o) => !o)}
        className="w-full flex items-center gap-2 justify-between min-w-0 px-2.5 py-1.5 rounded-lg bg-charcoal/95 border border-charcoal-dark text-gray-200 text-sm text-left hover:border-[#50C878]/40 hover:text-white focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent disabled:opacity-50 disabled:pointer-events-none transition-colors"
        aria-haspopup="listbox" aria-expanded={open} aria-label={ariaLabel}>
        <span className="flex items-center gap-2 min-w-0 flex-1">
          {leadingIcon}
          <span className={`truncate ${showPlaceholder ? "text-gray-500" : "text-gray-200"}`}>{displayLabel}</span>
        </span>
        <ChevronDown className={`w-4 h-4 shrink-0 text-gray-400 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
      </button>
      {open && typeof document !== "undefined" && createPortal(
        <ul ref={panelRef} role="listbox" style={panelStyle}
          className={`overflow-y-auto scrollbar-glass rounded-2xl border border-white/10 bg-neutral-900/75 backdrop-blur-xl shadow-[0_16px_48px_rgba(0,0,0,0.45)] divide-y divide-white/[0.08] ${panelClassName ?? ""}`}>
          {options.map((opt) => {
            const isSelected = value === opt.value;
            return (
              <li key={opt.value} role="option" aria-selected={isSelected}>
                <button type="button" onClick={() => { onChange(opt.value); setOpen(false); }}
                  className={`w-full text-left px-4 py-3 text-sm transition-colors ${isSelected ? "bg-[#50C878]/15 text-[#50C878]" : "text-white/95 hover:bg-white/5"}`}>
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
```

### `components/MonthDropdown.tsx`

```tsx
"use client";
import { Calendar } from "lucide-react";
import { useMonth, MONTH_OPTIONS } from "@/contexts/MonthContext";
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
```

---

## PART 12: API Routes (verbatim)

### `app/api/sheets/route.ts`

```ts
import { NextRequest, NextResponse } from "next/server";

const BASE_URL = process.env.NEXT_PUBLIC_GOOGLE_APPS_SCRIPT_URL ?? "";

function cleanErrorResponse(text: string, status: number): string {
  if (typeof text !== "string") return "Request failed";
  const isHtml = text.trimStart().toLowerCase().startsWith("<!doctype") || text.includes("</html>");
  if (isHtml && (text.includes("Access Denied") || text.includes("You need access"))) {
    return "Google Apps Script returned 'Access Denied'. Use the URL from Deploy > Manage deployments (the Web app row, not Test deployments). It must end in /exec. Create a new deployment (Deploy > New deployment > Web app > Anyone) and paste the new URL into .env.local.";
  }
  if (isHtml) return "Google Apps Script returned an unexpected page. Use the deployment URL that ends in /exec from Deploy > Manage deployments.";
  if (text.length > 200) return text.slice(0, 200) + "...";
  return text || `Request failed (${status})`;
}

export async function GET(request: NextRequest) {
  if (!BASE_URL) return NextResponse.json([], { status: 200 });
  const { searchParams } = new URL(request.url);
  const month = searchParams.get("month");
  const sheet = searchParams.get("sheet");
  const params = new URLSearchParams();
  if (month) params.set("month", month);
  if (sheet) params.set("sheet", sheet);
  const qs = params.toString();
  const url = qs ? `${BASE_URL}?${qs}` : BASE_URL;
  try {
    const res = await fetch(url, { cache: "no-store", redirect: "follow" });
    const text = await res.text();
    if (!res.ok) return NextResponse.json({ error: cleanErrorResponse(text, res.status) }, { status: res.status });
    try {
      const data = JSON.parse(text);
      return NextResponse.json(Array.isArray(data) ? data : data.rows ?? data.data ?? []);
    } catch {
      return NextResponse.json({ error: cleanErrorResponse(text, res.status) }, { status: 502 });
    }
  } catch (err) {
    console.error("Sheets GET error:", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to fetch" }, { status: 502 });
  }
}

export async function POST(request: NextRequest) {
  if (!BASE_URL) return NextResponse.json({ error: "Google Apps Script URL not configured" }, { status: 503 });
  if (BASE_URL.includes("/dev")) {
    return NextResponse.json({ error: "Use a Web app deployment URL ending in /exec, not the Test deployment URL (/dev)." }, { status: 400 });
  }
  try {
    const body = await request.json();
    const res = await fetch(BASE_URL, { cache: "no-store", redirect: "follow", method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const text = await res.text();
    if (!res.ok) return NextResponse.json({ error: cleanErrorResponse(text, res.status) }, { status: res.status });
    const isHtml = text.trimStart().toLowerCase().startsWith("<!doctype") || text.includes("</html>");
    if (isHtml) return NextResponse.json({ error: cleanErrorResponse(text, res.status) }, { status: 502 });
    try {
      const parsed = text ? JSON.parse(text) : { success: true };
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && String((parsed as { status?: unknown }).status ?? "").toLowerCase() === "error") {
        const message = String((parsed as { message?: unknown; error?: unknown }).message ?? (parsed as { message?: unknown; error?: unknown }).error ?? "Google Apps Script reported an error");
        return NextResponse.json({ error: message }, { status: 400 });
      }
      return NextResponse.json(parsed);
    } catch {
      return NextResponse.json({ error: cleanErrorResponse(text, res.status) }, { status: 502 });
    }
  } catch (err) {
    console.error("Sheets POST error:", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to submit" }, { status: 502 });
  }
}
```

### `app/api/budget/route.ts`

```ts
import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import { migrateBudgetCategoryKeys, type MonthlyBudgets } from "@/lib/budgetCategoryMigration";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isValidMonthKey(k: string): boolean {
  const n = parseInt(k, 10);
  return Number.isFinite(n) && n >= 1 && n <= 12;
}

function normalizeBody(raw: unknown): MonthlyBudgets | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: MonthlyBudgets = {};
  for (const [key, val] of Object.entries(raw)) {
    if (!isValidMonthKey(key)) continue;
    if (val === null || typeof val !== "object" || Array.isArray(val)) continue;
    const categoryMap: Record<string, number> = {};
    for (const [cat, amount] of Object.entries(val)) {
      if (typeof cat !== "string") continue;
      const n = typeof amount === "number" && Number.isFinite(amount) ? amount : Number(amount);
      if (Number.isFinite(n)) categoryMap[cat] = n;
    }
    out[key] = categoryMap;
  }
  return out;
}

export async function GET() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return NextResponse.json({});
  try {
    const sql = neon(connectionString);
    const rows = await sql`SELECT data FROM budget_store WHERE id = 1`;
    const raw = rows[0]?.data ?? {};
    const base = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as MonthlyBudgets) : {};
    const data = migrateBudgetCategoryKeys(base);
    if (data !== base) {
      await sql`INSERT INTO budget_store (id, data) VALUES (1, ${data}) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`;
    }
    return NextResponse.json(data);
  } catch (err) {
    console.error("Budget GET error:", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to load budget" }, { status: 502 });
  }
}

export async function PUT(request: NextRequest) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return NextResponse.json({ error: "DATABASE_URL not configured" }, { status: 503 });
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
  const normalized = normalizeBody(body);
  if (normalized === null) return NextResponse.json({ error: "Invalid budget data" }, { status: 400 });
  const data = migrateBudgetCategoryKeys(normalized);
  try {
    const sql = neon(connectionString);
    await sql`INSERT INTO budget_store (id, data) VALUES (1, ${data}) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`;
    return NextResponse.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Budget PUT error:", err);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
```

### `app/api/assets/route.ts` and `app/api/liabilities/route.ts`

Both follow identical structure — GET returns all rows, POST upserts by ID. The only difference is the table name (`manual_assets` vs `manual_liabilities`) and the `ensureTable` helper name.

Each item shape:
```ts
type ManualItem = {
  id: string;          // UUID generated by crypto.randomUUID() if not provided
  name: string;
  value: number;
  category: string;   // ASSET_CATEGORIES or LIABILITY_CATEGORIES from constants.ts
  acquisition_date?: string | null;  // YYYY-MM-DD
  details?: Record<string, unknown>; // category-specific fields stored as JSONB
  updated_at?: string;
};
```

Both routes call `ensureTable` (with `IF NOT EXISTS` + `ALTER TABLE ADD COLUMN IF NOT EXISTS`) on every request so they self-migrate without needing explicit migration steps.

### `app/api/reconciliation/anchors/route.ts` — Spec

GET: `SELECT account_name, confirmed_balance, as_of_date FROM account_anchors`
→ returns `{ anchors: [{ accountName, confirmedBalance, asOfDate }] }`

POST: `INSERT INTO account_anchors ... ON CONFLICT (account_name) DO UPDATE SET confirmed_balance = ..., as_of_date = ...`
Body: `{ accountName: string, confirmedBalance: number, asOfDate: string }`

DELETE: `DELETE FROM account_anchors WHERE account_name = $1`

### `app/api/reconciliation/claims/route.ts` — Spec

GET: `SELECT bank_hash, account_name, sheet_name, sheet_row_id, amount_cents FROM reconciliation_claim_links`
→ returns `{ claims: [...] }`

POST: `INSERT INTO reconciliation_claim_links (bank_hash, account_name, sheet_name, sheet_row_id, amount_cents) VALUES (...) ON CONFLICT DO NOTHING`
Also logs to `reconciliation_activity_log` with `action_type = 'claim_create'`
Also upserts merchant fingerprint memory in `reconciliation_merchant_memory`

DELETE: Deletes by `bank_hash + sheet_row_id`, logs `claim_delete` to activity log

### `app/api/reconciliation/transfer-claims/route.ts` — Spec

POST: `INSERT INTO reconciliation_transfer_claim_links (transfer_sheet_row_id, bank_hash, bank_account_name, bank_amount_cents, expected_legs)`
Logs `transfer_claim_create` to activity log.

DELETE: Deletes by `transfer_sheet_row_id + bank_hash`, logs `transfer_claim_delete`

### Other reconciliation routes — Spec

- `/api/reconciliation/dismissals` — GET/POST/DELETE `reconciliation_statement_dismissals` (auto-dismissal rules by fingerprint + account)
- `/api/reconciliation/user-dismissals` — GET/POST/DELETE user-marked dismissals (stored as a dismissal with note "user")
- `/api/reconciliation/processed` — GET/POST `processed_transactions` hashes
- `/api/reconciliation/memory` — GET `reconciliation_merchant_memory` (fingerprint → suggested category/account)
- `/api/reconciliation/activity` — GET `reconciliation_activity_log ORDER BY occurred_at DESC`
- `/api/reconciliation/activity/[id]/undo` — POST: looks up the action by ID, reverses it (e.g. claim_create → delete the claim), marks `reverted_at` and `reverted_by_action_id`
- `/api/reconciliation/reset` — POST: TRUNCATE `reconciliation_claim_links, reconciliation_transfer_claim_links, reconciliation_statement_dismissals, reconciliation_merchant_memory, reconciliation_activity_log`
- `/api/reconciliation/uploaded-files` — GET: returns distinct `csv_upload_id` + `occurred_at` from activity log (used to list past uploads)
- `/api/reconciliation/csv-rows` — GET/POST: if you store CSV rows in DB. The app stores uploaded CSV in state only (not persisted to DB); this route may be a stub.
- `/api/reconciliation/match-cache` — GET: returns cached match results (stub or in-memory; the app recomputes matches client-side)
- `/api/snaptrade/refresh-balances` — POST: calls SnapTrade SDK to fetch live balances, saves snapshot to `snaptrade_balance_snapshots`, returns `{ balances: Record<SupportedBroker, number> }`
- `/api/snaptrade/history` — GET: `SELECT * FROM snaptrade_balance_snapshots ORDER BY fetched_at DESC LIMIT 60`
- `/api/snaptrade/investments` — GET: latest snapshot from `snaptrade_balance_snapshots`, returns `{ brokerage, rothIra }`

---

## PART 13: Pages (Detailed Specs for Large Files)

### `app/new-expense/page.tsx` (138 lines — full verbatim)

```tsx
"use client";
import { useState } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import GlassDropdown from "@/components/GlassDropdown";
import { useRefresh } from "@/contexts/RefreshContext";
import { submitExpense } from "@/services/sheetsApi";
import { EXPENSE_TYPE_OPTIONS } from "@/lib/constants";
import { Loader2 } from "lucide-react";
import Link from "next/link";

export default function NewExpensePage() {
  const { triggerRefresh } = useRefresh();
  const [expenseType, setExpenseType] = useState("");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "success" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const num = parseFloat(amount);
    if (!expenseType || Number.isNaN(num) || num <= 0) {
      setStatus("error");
      setErrorMessage("Please select a type and enter a valid amount.");
      return;
    }
    setStatus("submitting");
    setErrorMessage("");
    try {
      await submitExpense({ expenseType, amount: num, description: description.trim() });
      triggerRefresh();
      setStatus("success");
      setAmount("");
      setDescription("");
      setExpenseType("");
    } catch (err) {
      setStatus("error");
      setErrorMessage(err instanceof Error ? err.message : "Failed to submit.");
    }
  };

  return (
    <DashboardLayout>
      <div className="space-y-6 max-w-2xl">
        <h1 className="text-xl font-semibold text-white">New Expense</h1>
        <div className="rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden">
          <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark">
            <h2 className="text-white font-medium">Add transaction</h2>
          </div>
          <form onSubmit={handleSubmit} className="p-6 space-y-4">
            <div>
              <label htmlFor="expenseType" className="block text-sm font-medium text-gray-300 mb-1">Expense Type</label>
              <GlassDropdown id="expenseType" value={expenseType} onChange={setExpenseType}
                options={EXPENSE_TYPE_OPTIONS.map((opt) => ({ value: opt, label: opt }))}
                placeholder="Select type" className="w-full" aria-label="Expense type" />
            </div>
            <div>
              <label htmlFor="amount" className="block text-sm font-medium text-gray-300 mb-1">Amount</label>
              <input id="amount" type="number" step="0.01" min="0" required value={amount}
                onChange={(e) => setAmount(e.target.value)} placeholder="0.00"
                className="w-full px-3 py-2 rounded-lg bg-charcoal border border-charcoal-dark text-gray-200 focus:border-accent focus:ring-1 focus:ring-accent outline-none" />
            </div>
            <div>
              <label htmlFor="description" className="block text-sm font-medium text-gray-300 mb-1">Description</label>
              <input id="description" type="text" value={description} onChange={(e) => setDescription(e.target.value)}
                placeholder="Optional notes"
                className="w-full px-3 py-2 rounded-lg bg-charcoal border border-charcoal-dark text-gray-200 focus:border-accent focus:ring-1 focus:ring-accent outline-none" />
            </div>
            {status === "error" && <p className="text-sm text-red-400">{errorMessage}</p>}
            {status === "success" && <p className="text-sm text-accent">Saved. Dashboard will reflect the new transaction.</p>}
            <div className="flex gap-3 pt-2">
              <button type="submit" disabled={status === "submitting"}
                className="px-4 py-2 rounded-lg bg-accent text-white font-medium hover:bg-accent-dark disabled:opacity-50 flex items-center gap-2">
                {status === "submitting" ? (<><Loader2 className="w-4 h-4 animate-spin" />Saving…</>) : "Save"}
              </button>
              <Link href="/" className="px-4 py-2 rounded-lg bg-charcoal border border-charcoal-dark text-gray-300 hover:text-white hover:border-accent/50 transition-colors">
                View Budget
              </Link>
            </div>
          </form>
        </div>
      </div>
    </DashboardLayout>
  );
}
```

---

### `app/page.tsx` — Budget Dashboard (~1272 lines)

The main page. Wrap everything in `<DashboardLayout>`. This is a complex "use client" page.

**State:**
```ts
const { allRows, allTransfers, loading, error } = useExpensesData();
const { selectedMonth } = useMonth();
const { triggerRefresh } = useRefresh();

// Filtered by selectedMonth via useMemo
const rows = useMemo(() => allRows.filter(r => rowMatchesMonth(r, selectedMonth)), [allRows, selectedMonth]);
const transfers = useMemo(() => allTransfers.filter(t => transferMatchesMonth(t, selectedMonth)), [allTransfers, selectedMonth]);

// Budget from Neon
const [budgets, setBudgets] = useState<MonthlyBudgets>({});
// Account balances
const [accountBalances, setAccountBalances] = useState<Record<string, number>>({});
// Live broker balances from SnapTrade
const [liveBrokerBalances, setLiveBrokerBalances] = useState<Partial<Record<SupportedBroker, number>>>({});
// Category detail modal
const [activeCategory, setActiveCategory] = useState<string | null>(null);
// Budget edit modal
const [editingBudget, setEditingBudget] = useState(false);
// Chart toggle (cumulative vs. weekly)
const [chartMode, setChartMode] = useState<"daily" | "weekly">("daily");
```

**Budget logic:**
- Budget stored as `Record<monthKey, Record<category, amount>>` in Neon via `/api/budget` PUT/GET
- If selected month has no budget, inherit (carry-forward) from previous month recursively
- Full year: sum all 12 months' budgets

**Charts (Recharts):**
- `PieChart` with `Pie` — category spending breakdown. Each slice colored by `CATEGORY_COLORS`. Click a slice to open detail modal.
- `LineChart` — cumulative expense by day (or week for full year). X-axis = day of month, Y-axis = cumulative spend.
- `LineChart` — cumulative income over time.

**Category progress bars:**
- For each `EXPENSE_CATEGORIES` item: show spent vs. budget with a progress bar.
- Colors: green if < 70% of budget, orange if 70–90%, red if ≥ 90%.
- Click row to open category detail modal.

**Category detail modal:**
- Shows list of transactions for that category in the selected month.
- Input to edit budget amount for that category/month.
- Save writes to Neon via PUT `/api/budget`.

**Income card:** Lists `expenseType === "Income"` rows with date and amount.

**Transfers card:** Lists transfers for the month, showing "From → To" with amount.

**Account Balances card:**
- Fetches anchors via `getAccountAnchors()`.
- Calls `computeAccountBalances(allRows, allTransfers, liveBrokerBalances, anchors)`.
- Displays table of account → balance.
- "Refresh" button calls `/api/snaptrade/refresh-balances` POST.

**Header:** `<MonthDropdown />` for month switching.

---

### `app/net-worth/page.tsx` — Net Worth (~1215 lines)

**State:**
- `assets: ManualItem[]` from `/api/assets` GET
- `liabilities: ManualItem[]` from `/api/liabilities` GET
- `snapHistory` from `/api/snaptrade/history` GET
- `investments: { brokerage, rothIra }` from `/api/snaptrade/investments`
- `addingAsset / addingLiability`: boolean for showing the add form
- `editingItem: ManualItem | null`

**Summary cards at top:**
- Total Net Worth = sum(asset values) − sum(liability values) + broker balances
- Liquid Net Worth = checking + savings + Venmo balances
- Savings Rate (from `netWorthService`)

**Manual Assets table:** Cards per category (Real Estate, Vehicle, Personal).
- Add button opens form with fields: name, value, acquisition date, category-specific details
  - Vehicle: year, make, model, mileage, loan balance
  - Real Estate: property type, address, estimated value, mortgage balance
  - Personal: description
- Save calls POST `/api/assets`
- Delete removes from list and calls POST with value set to signal deletion (or separate DELETE endpoint)

**Manual Liabilities table:** Same pattern for Credit Card, Loan, Mortgage.

**Income breakdown pie:** Pie chart of income sources from Google Sheets.

**Net Worth History chart:** Line chart of historical Fidelity totals from `snaptrade_balance_snapshots`.

**Investments widget:**
- Shows current brokerage + Roth IRA values
- Table of connected account balances (from SnapTrade or computed)

---

### `app/reconcile/page.tsx` — Reconciliation (~5018 lines)

This is the most complex page. It's a multi-tab interface.

**Tabs:** "Upload & Match" | "Activity Log"

**Bank Profiles** (hardcoded, configurable per instance):
```ts
const BANK_PROFILES = {
  "Wells Fargo Checking": { dateCol: 0, amountCol: 1, descCol: 4, negativeIsExpense: true },
  "Wells Fargo Savings": { dateCol: 0, amountCol: 1, descCol: 4, negativeIsExpense: true },
  "Venmo - Daniel": { dateCol: 0, amountCol: 2, descCol: 1, negativeIsExpense: true },
  "Capital One": { dateCol: 0, amountCol: 5, descCol: 3, negativeIsExpense: false },
  "Discover": { dateCol: 0, amountCol: 2, descCol: 2, negativeIsExpense: false },
  "America First": { dateCol: 0, amountCol: 3, descCol: 1, negativeIsExpense: false },
};
```

**CSV Upload flow:**
1. User drags or selects a CSV file.
2. Select bank profile from dropdown.
3. Parse CSV with `papaparse`.
4. Each row becomes a `BankRow { date, amount, description, hash }` where hash = SHA-256 of normalized fields.
5. Run match algorithm against Google Sheets transactions.

**Match algorithm (in `services/reconciliationService.ts`):**
- **Exact match:** amount matches within $0.01 AND description/merchant is similar AND date within 7 days.
- **Fuzzy match:** amount matches, description partially overlaps.
- **Transfer match:** amount appears in both debit and credit legs across accounts.
- **Suggested match:** merchant fingerprint memory says "this fingerprint was previously claimed as X category."
- **Unmatched:** no match found.

**Row states per CSV row:**
- `claimed` — linked to a Sheets expense or transfer via `reconciliation_claim_links`
- `dismissed` — marked as irrelevant (auto by fingerprint rule, or user-dismissed)
- `unmatched` — shown with suggested matches or "Add to Sheets" option

**Account Anchors panel:**
- For each account, show current anchor (confirmed balance + date).
- Form to set a new anchor: balance field + date picker.
- Calls POST `/api/reconciliation/anchors`.

**Activity Log tab:**
- List of all actions (claim_create, dismiss_create, etc.) from `reconciliation_activity_log`.
- Each action has "Undo" button that calls POST `/api/reconciliation/activity/[id]/undo`.
- Group by `csv_upload_id` to show history per upload session.

**State management:**
- All reconciliation state loaded on mount: claims, dismissals, anchors, merchant memory.
- After each action (claim, dismiss, undo), refetch only the affected data.
- `csvUploadId` = a UUID generated when a CSV is first uploaded, used to group activity log entries.

---

### `app/investment-calculator/page.tsx` — Life-Stage Planner (~400 lines)

Fully client-side, persists to `localStorage` key `stash_investment_calculator_v1`.

**Inputs (persisted):**
```ts
type CalculatorState = {
  currentAge: number;       // 18–80
  retirementAge: number;    // currentAge+1 to 85
  startingPortfolio: number;
  annualReturn: number;     // e.g. 7 (%)
  inflationRate: number;    // e.g. 3 (%)
  stages: LifeStage[];
};

type LifeStage = {
  id: string;
  label: string;           // "Student", "Early Career", etc.
  startAge: number;
  endAge: number;
  monthlyContribution: number;
  color: string;           // for chart
};
```

**Calculation:**
- For each year from `currentAge` to `retirementAge`:
  - Find which stage the age falls in.
  - `portfolioValue = portfolioValue * (1 + annualReturn/100) + monthlyContribution * 12`
  - `realValue = nominalValue / ((1 + inflationRate/100) ^ (year - currentAge))`
- Chart: `LineChart` from Recharts, X = age, Y = portfolio value. Color changes per life stage.
- Summary metrics: Final Nominal Value, Final Real Value (inflation-adjusted), Total Contributed, Total Growth, Growth Multiplier.

**UI:**
- Sliders and number inputs for global params.
- "Add Stage" button → stage card with start/end age, monthly contribution, label, color picker.
- Stages sorted by startAge, validated to not overlap.

---

## PART 14: Reconciliation Service Spec

### `services/reconciliationService.ts`

**Important:** This module uses `node:crypto` for SHA-256 hashing. It is **server-side only**. Do not import it into client components. Use `lib/merchantFingerprint.ts` for client-side fingerprinting instead.

```ts
import crypto from "node:crypto";

export type BankRow = {
  date: string;          // YYYY-MM-DD
  amount: number;        // positive = debit, negative = credit
  description: string;
  hash: string;          // SHA-256 of normalized fields
  rawCsvLine: string;
  accountName: string;
};

export function hashBankRow(date: string, amount: number, description: string): string {
  const normalized = `${date}|${Math.abs(amount).toFixed(2)}|${description.trim().toLowerCase()}`;
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

export type MatchType = "exact" | "fuzzy" | "transfer" | "suggested" | "unmatched";

export type MatchResult = {
  bankRow: BankRow;
  matchType: MatchType;
  sheetRow?: SheetRow;         // for expense matches
  transferRow?: TransferRow;   // for transfer matches
  confidence: number;          // 0–1
  suggestedCategory?: string;  // from merchant memory
};

// Match a bank row against all sheet expenses and transfers
export function matchBankRow(
  bankRow: BankRow,
  sheetRows: SheetRow[],
  transferRows: TransferRow[],
  existingClaims: Set<string>,    // set of already-claimed sheet row IDs
  merchantMemory: Map<string, string>, // fingerprint → sheet_category
): MatchResult {
  // 1. Check exact match: amount within $0.01, date within 7 days, description similarity > 0.5
  // 2. Check transfer match: find a transfer where abs(amount) matches either leg
  // 3. Check fuzzy match: amount matches, description has >30% overlap
  // 4. Check merchant memory for suggested category
  // 5. Return unmatched
}
```

---

## PART 15: Styling Reference

### Color System

| Token | Hex | Usage |
|-------|-----|-------|
| `bg-charcoal` | `#1A1A1A` | Page background |
| `bg-charcoal-light` | `#282828` | Slightly lighter backgrounds |
| `bg-charcoal-dark` | `#333333` | Borders, dividers |
| `bg-[#252525]` | `#252525` | Card backgrounds |
| `bg-[#353535]` | `#353535` | Card headers |
| `bg-[#3A3A3A]` | `#3A3A3A` | Sidebar, BottomNav |
| `bg-tileRowAlt` | `#2C2C2C` | Alternating table rows |
| `text-accent` | `#50C878` | Primary green accent |
| `bg-accent` | `#50C878` | Primary buttons, active nav |
| `bg-accent-dark` | `#3DB368` | Button hover state |

### Card Pattern

Every section uses this card structure:
```tsx
<div className="rounded-xl bg-[#252525] border border-charcoal-dark overflow-hidden">
  <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark">
    <h2 className="text-white font-medium text-sm">Card Title</h2>
  </div>
  <div className="p-4">
    {/* content */}
  </div>
</div>
```

### Alternating Row Pattern
```tsx
rows.map((row, i) => (
  <div key={i} className={`px-4 py-2 ${i % 2 === 0 ? "bg-[#2C2C2C]" : "bg-[#252525]"}`}>
    ...
  </div>
))
```

### Input Pattern
```tsx
<input
  className="w-full px-3 py-2 rounded-lg bg-charcoal border border-charcoal-dark text-gray-200 focus:border-accent focus:ring-1 focus:ring-accent outline-none"
/>
```

### Button Patterns
```tsx
// Primary
<button className="px-4 py-2 rounded-lg bg-accent text-white font-medium hover:bg-accent-dark transition-colors" />

// Secondary
<button className="px-4 py-2 rounded-lg bg-charcoal border border-charcoal-dark text-gray-300 hover:text-white hover:border-accent/50 transition-colors" />

// Danger
<button className="px-3 py-1.5 rounded-lg bg-red-500/10 text-red-400 hover:bg-red-500/20 border border-red-500/20 transition-colors" />
```

---

## PART 16: Architecture Notes

### Full-Year Caching Pattern

The app fetches all expense/transfer data for the **full year** once on mount (in `ExpensesDataContext`), stores it in `localStorage`, and filters client-side by `selectedMonth`. This makes month switching instant with no network call. The `refreshKey` in `RefreshContext` triggers a new full-year fetch.

### Account Balance Computation

`BASE_ACCOUNT_BALANCES` in `accountBalancesService.ts` are hardcoded to a specific historical starting point. When recreating for a new user:
1. Set all base balances to `0`.
2. Set an account anchor for each account with the current confirmed balance.
3. Going forward, new transactions will be applied on top of the anchored values.

The `shouldApplyByAnchor` function ensures only transactions **after** an anchor date are applied, preventing double-counting when you set a new anchor.

### Budget Carry-Forward

If month N has no budget entry, the budget page looks up month N-1, then N-2, etc. This means you only need to set a budget once — it persists forward until overridden.

### Reconciliation State Machine

Each CSV row goes through: `parsed → matched/unmatched → claimed/dismissed → processed`

Claims are stored in Neon so they persist across sessions. Each action is logged to `reconciliation_activity_log` with enough payload data to reverse it. The Undo system reads `action_type` and `payload` to determine what to delete/recreate.

### SnapTrade Integration

SnapTrade is a brokerage aggregation API. Without it, investment account balances (Fidelity, Robinhood, etc.) display as computed values from Sheets transfers. With it, actual live balances from the brokerage override the computed values.

The app stores periodic balance snapshots in `snaptrade_balance_snapshots` to power the historical chart on the Net Worth page.

### PWA Behavior

- `@ducanh2912/next-pwa` wraps the Next.js config and registers a service worker.
- Disabled in development (`NODE_ENV === "development"`).
- The `standalone` Tailwind variant (`@media (display-mode: standalone)`) is used throughout to conditionally show/hide elements in PWA mode:
  - Sidebar: `standalone:hidden` (hidden in PWA)
  - BottomNav: `hidden standalone:flex` (only shown in PWA)
  - Content padding: `standalone:pb-24` (extra bottom padding for BottomNav)
  - Top padding: `paddingTop: env(safe-area-inset-top, 0px)` for iPhone notch

---

## PART 17: Post-Recreation Checklist

After recreating all files and running `npm install`:

1. `cp .env.example .env.local` and fill in all values
2. Run `npm run dev` and verify the app starts
3. Open `/` (Budget page) — should load without errors even with empty data
4. Test `/new-expense` — add a test transaction, verify it appears in Google Sheets
5. Verify `/` budget page shows the new transaction
6. Open `/net-worth` — add a test asset and liability
7. Open `/reconcile` — upload a sample bank CSV, verify rows appear
8. Test month switching — should be instant (no loading spinner)
9. Set a budget via the budget progress bar category click → edit budget input
10. Verify budget persists after page refresh (stored in Neon)
11. If using SnapTrade: click Refresh button in Account Balances section of budget page
12. Add the app to your home screen and verify PWA standalone mode shows BottomNav

---

## PART 18: Known Customization Points

When recreating for a different user:

1. **`MONTH_OPTIONS` year** in `contexts/MonthContext.tsx` — change `2026` to the current year
2. **`rowMatchesMonth`** month name comparison — includes `${monthName} 2026`, update the year
3. **`BASE_ACCOUNT_BALANCES`** in `services/accountBalancesService.ts` — set to your actual account balances or all zeros + use anchors
4. **`TRANSFER_LABEL_TO_BALANCE_KEY`** — update with your actual account names as they appear in your Google Sheets Transfers tab
5. **Bank profiles** in `app/reconcile/page.tsx` — update column indices and account names to match your actual bank CSVs
6. **`EXPENSE_CATEGORIES`** in `lib/constants.ts` — customize to your spending categories
7. **`LEGACY_EXPENSE_CATEGORY_ALIASES`** — for any old category names in your Sheets that have been renamed
