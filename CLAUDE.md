# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev      # Start dev server at http://localhost:3000
npm run build    # Production build
npm run start    # Run production build
npm run lint     # ESLint
```

No test suite — feature verification is manual via browser.

## Environment Setup

Copy `.env.example` to `.env.local` and populate:
- `NEXT_PUBLIC_GOOGLE_APPS_SCRIPT_URL` — deployed Google Apps Script web app URL
- `DATABASE_URL` — Neon Postgres connection string
- `SNAPTRADE_CLIENT_ID`, `SNAPTRADE_CONSUMER_KEY`, `SNAPTRADE_USER_ID`, `SNAPTRADE_USER_SECRET`

Neon DB schema is in `docs/neon-budget-setup.md`. Run the SQL in Neon's query editor before using budget sync.

## Architecture

**Stash** is a Next.js 14 personal finance dashboard. Data lives in two external systems:
1. **Google Sheets** (via a deployed Apps Script web app) — source of truth for all expense/transfer transactions
2. **Neon Postgres** — stores budget allocations, reconciliation state (anchors, claims, dismissals), and processed transaction hashes

### Data Flow

- All pages are client components that fetch via internal API routes (`/api/*`)
- `/api/sheets` proxies to Google Apps Script (GET = fetch expenses/transfers, POST = submit new transaction)
- `/api/budget` reads/writes monthly budgets to Neon as JSONB
- `/api/reconciliation/*` manages bank CSV matching state in Neon
- `/api/snaptrade/*` calls SnapTrade SDK server-side to fetch live brokerage balances

### State Management

Four React contexts (in `contexts/`):
- `ExpensesDataContext` — caches full-year expenses + transfers on mount; refetches when `refreshKey` changes
- `MonthContext` — selected month (1–12 or `"full"`)
- `RefreshContext` — provides `refreshKey` integer + `triggerRefresh()` to force data reload
- `SidebarContext` — sidebar collapsed/open state

Pages use `useMemo` to filter the cached full-year data by `selectedMonth` — month switching is instant with no network calls.

### Key Files

| File | Notes |
|------|-------|
| `app/budget/page.tsx` | Main dashboard: pie chart, line chart, budget progress bars, account balances (~1272 lines) |
| `app/reconcile/page.tsx` | Bank CSV upload and transaction matching UI (~5018 lines) |
| `app/net-worth/page.tsx` | Assets/liabilities + SnapTrade integration (~1215 lines) |
| `app/new-expense/page.tsx` | Form to add expenses/income/transfers to Google Sheets |
| `services/sheetsApi.ts` | All Google Sheets fetch/submit logic + type normalization |
| `services/accountBalancesService.ts` | Computes account balances from transactions + transfers + anchors + SnapTrade |
| `lib/constants.ts` | Expense categories, account names, transfer options |
| `lib/budgetCategoryMigration.ts` | Normalizes legacy category names during budget load |
| `components/GlassDropdown.tsx` | Reusable styled dropdown used across pages |
| `app/investment-calculator/page.tsx` | Life-stage compound-interest calculator — fully client-side, persists to localStorage, uses Recharts |

### Budget Logic

- Monthly budgets stored as `Record<monthNumber, Record<categoryName, amount>>` in Neon
- If a month has no budget, it inherits (carry-forward) from the previous month
- Full Year view aggregates all 12 months
- Budget category names are normalized through `budgetCategoryMigration.ts` to handle legacy data

### Reconciliation

The reconciliation workflow (`/reconcile`) matches uploaded bank CSV rows against Google Sheets transactions. State is persisted in Neon across four tables: `account_anchors`, `reconciliation_claim_links`, `reconciliation_transfer_claim_links`, `reconciliation_statement_dismissals`. The match algorithm is in `services/reconciliationService.ts`.

### Styling

Tailwind CSS with a custom dark theme — charcoal (`#1A1A1A`) background, green (`#50C878`) accent. Alternating tile rows use `#2C2C2C`. All custom tokens are in `tailwind.config.ts`.

### Neon DB Access Pattern

API routes use raw SQL via `@neondatabase/serverless`. No ORM. Bulk inserts use per-row transactions (chunked) to stay within Neon HTTP driver limits — see `NEON_SAVE_CHUNK_SIZE` in reconciliation routes.
