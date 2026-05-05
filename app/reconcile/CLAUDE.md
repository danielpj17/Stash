# Reconciliation System — CLAUDE.md

## Purpose

The reconcile page matches bank CSV statement rows against user-inputted expense and transfer entries from Google Sheets. The goal is to confirm every bank transaction has a corresponding user entry, and every user entry has a corresponding bank transaction.

**Two sources of truth:**
- **Google Sheets** — user-inputted expenses and transfers (what the user recorded)
- **Bank CSV** — raw bank statements (what actually happened)

Reconciliation produces a claim: a persistent link between a bank transaction hash and a sheet row ID.

---

## Key Files

| File | Role |
|------|------|
| `app/reconcile/page.tsx` | Main UI (~5018 lines) — all state, handlers, view logic |
| `services/reconciliationService.ts` | Match algorithm, bank CSV parsing, hash generation |
| `app/api/reconciliation/match/route.ts` | CSV rows → BankTransaction[] → MatchResult[] |
| `app/api/reconciliation/claims/route.ts` | Expense claim links CRUD |
| `app/api/reconciliation/transfer-claims/route.ts` | Transfer claim links CRUD |
| `app/api/reconciliation/processed/route.ts` | Processed hash CRUD |
| `app/api/reconciliation/dismissals/route.ts` | Bank transaction dismissal CRUD |
| `app/api/reconciliation/user-dismissals/route.ts` | Sheet row dismissal CRUD |
| `app/api/reconciliation/anchors/route.ts` | Account balance anchor CRUD |
| `app/api/reconciliation/match-cache/route.ts` | Persist/restore MatchResult[] per account |
| `app/api/reconciliation/csv-rows/route.ts` | Persist raw CSV rows per account |
| `app/api/reconciliation/uploaded-files/route.ts` | File upload history per account |
| `app/api/reconciliation/reset/route.ts` | Wipe all reconciliation state from Neon |

---

## Core TypeScript Types

### `services/reconciliationService.ts`

```typescript
type BankProfile = {
  dateIndex: number | null;
  amountIndex: number | null;
  descriptionIndex: number | null;
  debitIndex?: number | null;
  creditIndex?: number | null;
};

type BankTransaction = {
  accountName: string;
  date: string;           // YYYY-MM-DD
  amount: number;         // negative = debit
  description: string;
  hash: string;           // SHA256 of date|amount|description (normalized)
  raw?: string[];         // original CSV row
};

type MatchType =
  | "exact_match"             // auto-matched or manually claimed
  | "processed"               // hash in Neon, no current sheet row linked
  | "questionable_match_fuzzy" // multiple same-amount candidates, needs manual review
  | "suggested_match"         // amount matches, confidence below auto-threshold
  | "transfer"                // matches a sheet transfer row
  | "unmatched";              // no match found

type MatchResult = {
  bankTransaction: BankTransaction;
  matchType: MatchType;
  reason: string;
  matchedSheetExpense?: SheetExpenseLike;
  matchedSheetIndex?: number;
  matchedSheetTransfer?: SheetTransferLike;
  matchedSheetTransferIndex?: number;
  transferCounterparty?: BankTransaction;  // other leg of cross-account transfer
  matchedByNeonHash?: boolean;             // true if match was restored from Neon claim
  confidenceScore?: number;
  candidateCount?: number;
  isAmbiguousCluster?: boolean;
};

type SheetExpenseLike = {
  amount: number;
  timestamp?: string;
  date?: string;
  description?: string;
  expenseType?: string;
  account?: string;
  rowId?: string;
};

type SheetTransferLike = {
  amount: number;
  timestamp?: string;
  date?: string;
  transferFrom?: string;
  transferTo?: string;
  description?: string;
  transferRowId?: string;
};
```

### Modal and UI state types (`page.tsx`)

```typescript
type TransferClaimModalState = {
  open: boolean;
  rowId: string | null;
  expectedLegs: 1 | 2;
  submitting: boolean;
  error: string;
};

type UserStatementClaimModalState = {
  open: boolean;
  entry: UserInputtedEntry | null;
  selectedBankRowId: string | null;
  searchQuery: string;
  accountFilter: AccountOption | typeof ALL_ACCOUNTS_OPTION;
  transferExpectedLegs: 1 | 2;
  submitting: boolean;
  error: string;
};

type DismissModalState = {
  open: boolean;
  match: MatchResult | null;
  note: string;
  submitting: boolean;
  error: string;
};

type AnchorModalState = {
  open: boolean;
  date: string;
  balance: string;
  loading: boolean;
  saving: boolean;
  error: string;
};
```

---

## Neon Database Schema

```sql
-- Hash-based deduplication. One row per bank transaction.
CREATE TABLE processed_transactions (
  hash TEXT PRIMARY KEY,
  account_name TEXT,
  processed_at TIMESTAMP DEFAULT now()
);

-- Links a bank transaction to an expense sheet row.
-- UNIQUE(sheet_name, sheet_row_id) ensures one expense = one bank tx.
CREATE TABLE reconciliation_claim_links (
  bank_hash TEXT NOT NULL,
  account_name TEXT,
  sheet_name TEXT NOT NULL DEFAULT 'Expenses',
  sheet_row_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  created_at TIMESTAMP DEFAULT now(),
  PRIMARY KEY (bank_hash, sheet_name, sheet_row_id),
  UNIQUE (sheet_name, sheet_row_id)
);

-- Links a bank transaction to a transfer sheet row.
-- UNIQUE(bank_hash) ensures one bank tx = one transfer leg.
-- Same transfer_sheet_row_id can appear twice (one per leg of a 2-leg transfer).
CREATE TABLE reconciliation_transfer_claim_links (
  transfer_sheet_row_id TEXT NOT NULL,
  bank_hash TEXT NOT NULL,
  bank_account_name TEXT,
  bank_amount_cents INTEGER NOT NULL,  -- signed: negative for debit leg
  expected_legs INTEGER NOT NULL DEFAULT 2 CHECK (expected_legs IN (1, 2)),
  created_at TIMESTAMP DEFAULT now(),
  PRIMARY KEY (transfer_sheet_row_id, bank_hash),
  UNIQUE (bank_hash)
);

-- Bank transaction dismissed (no corresponding sheet entry needed).
CREATE TABLE reconciliation_statement_dismissals (
  hash TEXT NOT NULL,
  account_name TEXT NOT NULL,
  note TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT now(),
  PRIMARY KEY (hash, account_name)
);

-- User sheet row dismissed (no corresponding bank transaction needed).
CREATE TABLE reconciliation_user_sheet_dismissals (
  sheet_name TEXT NOT NULL,  -- 'Expenses' | 'Transfers'
  sheet_row_id TEXT NOT NULL,
  note TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT now(),
  PRIMARY KEY (sheet_name, sheet_row_id)
);

-- Cached MatchResult[] per account (avoids re-matching on page reload).
CREATE TABLE reconciliation_match_cache (
  account_name TEXT NOT NULL,
  bank_hash TEXT NOT NULL,
  match_data JSONB NOT NULL,
  updated_at TIMESTAMP DEFAULT now(),
  PRIMARY KEY (account_name, bank_hash)
);

-- Raw CSV rows per account (used for re-matching after transfer claims).
CREATE TABLE csv_storage (
  account_name TEXT PRIMARY KEY,
  rows JSONB NOT NULL,  -- string[][]
  updated_at TIMESTAMP DEFAULT now()
);

-- Statement ending balance anchors for account balance computation.
CREATE TABLE account_anchors (
  account_name TEXT PRIMARY KEY,
  confirmed_balance NUMERIC,
  as_of_date DATE
);
```

---

## Bank Profiles & CSV Parsing

### Supported Banks

| Account Name | Date Col | Amount Col | Notes |
|---|---|---|---|
| Wells Fargo | 0 | 1 | Embeds purchase date in description |
| Venmo | auto-detect | auto-detect | Header row scanned dynamically |
| Capital One | auto-detect | debit/credit cols | Two separate debit/credit columns |
| America First | 0 | 1 | Standard format |
| Discover | 0 | 3 | Standard format |

### Hash Generation (`generateTransactionHash`)

```
SHA256(YYYY-MM-DD | normalized_amount | trimmed_lowercase_description)
```

- Amount normalized to 2 decimal places
- Description trimmed and lowercased
- Hash is stable across multiple imports of the same statement

**Never change the hash inputs** — existing Neon claims and processed records are keyed to these hashes.

### Wells Fargo Date Derivation

Wells Fargo posts transactions with a posting date, but embeds the actual purchase date in the description as `PURCHASE AUTHORIZED ON MM/DD`. The parser extracts this date to reduce date-lag mismatches during matching. Year is inferred from context (handles Jan/Dec boundary).

### Description Cleaning

Removes noise before matching:
- `PURCHASE AUTHORIZED ON MM/DD` prefix
- Card numbers (4-digit sequences after spaces)
- ATM IDs and transaction refs
- Trailing whitespace

---

## Match Algorithm (`findMatches` in `reconciliationService.ts`)

Runs in priority order. Once a bank transaction is matched at a step, later steps are skipped. Sheet rows are "consumed" (removed from the pool) as they are matched to prevent double-matching.

### Step 1 — Exact Match (Sheet Expense)
- Bank amount and date match a sheet expense row exactly
- Sheet row consumed from pool
- `matchType: "exact_match"`

### Step 2 — Processed Hash (Neon)
- Hash exists in `processed_transactions` but no sheet row is currently linked
- Indicates the transaction was handled in a prior session
- `matchType: "processed"`, `matchedByNeonHash: true`

### Step 3 — Transfer Matching
- Looks for sheet transfer rows where:
  - Amount matches (within 31-day window)
  - Description contains transfer keywords (transfer, venmo, zelle, payment, etc.)
  - Jaccard description similarity >= 0.12
  - Transfer claim is not already complete (claimedCount < expectedLegs)
- Single candidate → `matchType: "transfer"`
- Multiple candidates → `matchType: "questionable_match_fuzzy"` (manual review required)
- Also handles cross-account transfers: negative amount in account A matched against positive in account B (same day)

### Step 4 — Confidence-Scored Expense Matching

Finds all sheet expenses with matching amount, then scores each:

| Factor | Score |
|---|---|
| Same day | +1.0 |
| 1 day apart | +0.9 |
| 3 days apart | +0.7 |
| 7 days apart | +0.5 |
| 14 days apart | +0.3 |
| 30 days apart | +0.1 |
| > 30 days | +0.0 |
| Description Jaccard similarity | +0.0–1.0 scaled |
| Account name match | +0.2 |

**Auto-match threshold** (all conditions must hold):
- Top score >= 1.0
- Gap between top and second score >= 0.3
- Transaction is NOT in an ambiguous cluster
- Sheet row is not already claimed

Below threshold → `matchType: "suggested_match"` (needs user approval)

### Step 5 — Ambiguous Cluster Detection

A bank transaction is part of an ambiguous cluster if:
- Same account has another transaction with same amount
- Description similarity between the two >= 0.3
- Transactions are within 1 day of each other

Clustered transactions **never auto-match** regardless of confidence score. This prevents swap errors (e.g., two $50 Starbucks charges in one day).

### Step 6 — Unmatched

No amount match found anywhere. `matchType: "unmatched"`.

### Description Similarity (Jaccard)

```
tokens_a = { words with 3+ chars, not in stop-word list }
tokens_b = { same }
similarity = |tokens_a ∩ tokens_b| / max(|tokens_a|, |tokens_b|)
```

Stop words: purchase, authorized, transfer, payment, to, from, ref, pos, debit, credit, card, on, at, with, for, the, and, via.

---

## API Routes

### `POST /api/reconciliation/match`
- **In:** `{ accountName, rows: string[][], sheetExpenses, sheetTransfers, processedHashes? }`
- **Out:** `{ bankTransactions: BankTransaction[], matches: MatchResult[] }`
- Parses CSV, restores existing Neon claim links as `exact_match`, runs `findMatches()` on remainder

### `GET /api/reconciliation/claims`
- **Out:** `{ claims: ClaimRow[], claimedRowIds: string[] }` — claimedRowIds in `"sheetName:sheetRowId"` format

### `POST /api/reconciliation/claims`
- **In:** `{ bankTransaction: { hash, accountName, amount, date, description }, links: [{ sheetName, sheetRowId, amount }] }`
- Validates amounts sum to bank transaction amount; inserts into claim_links + processed_transactions
- Returns 409 if sheet row already claimed by a different bank hash

### `GET /api/reconciliation/transfer-claims`
- **Out:** `{ claims: TransferClaimRow[], statusByRowId: Record<transferRowId, { claimedCount, expectedLegs, isComplete }> }`

### `POST /api/reconciliation/transfer-claims`
- **In:** `{ transferRowId, expectedLegs: 1|2, bankTransaction: { hash, accountName, amount } }`
- Validates: new leg must have opposite sign if 2-leg transfer
- Returns 409 if transfer already complete

### `GET|POST|DELETE /api/reconciliation/processed`
- GET: `{ hashes: string[] }`
- POST: `{ hash, accountName? }` — mark processed
- DELETE: `{ hash, accountName? }` — unmark processed

### `GET|POST /api/reconciliation/dismissals`
- POST: `{ hash, accountName, note }` — dismisses bank transaction + marks processed (rolls back on error)

### `GET|POST /api/reconciliation/user-dismissals`
- POST: `{ sheetName, sheetRowId, note }`

### `GET|POST /api/reconciliation/anchors`
- POST: `{ accountName, confirmedBalance, asOfDate }`

### `POST /api/reconciliation/match-cache`
- **In:** `{ accountName, matches: MatchResult[], replace?: boolean }`
- If `replace: true`, deletes all existing cache rows for account first

### `POST /api/reconciliation/csv-rows`
- **In:** `{ accountName, rows: string[][] }`
- Stores raw CSV for re-matching after transfer claims

### `POST /api/reconciliation/reset`
- Truncates all reconciliation tables (used from reset modal)

---

## Page State Architecture (`page.tsx`)

### View Modes
- `"home"` — 3-column dashboard: incomplete user entries | matched entries | account summaries
- `"accountDetail"` — CSV upload zone + 3 tabs (review, auto-matched, completed) for one account

### State Groups

**Core match state**
```typescript
matchesByAccount: Record<string, MatchResult[]>
selectedAccount: AccountOption
activeTab: string
```

**Sheet data**
```typescript
sheetExpenses: SheetRow[]
sheetTransfers: TransferRow[]
claimedRowKeys: Set<string>           // "sheetName:sheetRowId"
```

**Bank/Neon state**
```typescript
processedHashes: Set<string>
dismissalNotesById: Record<string, string>
bankHashesWithNeonClaim: Set<string>
transferClaimStatusByRowId: TransferClaimStatusByRowId
```

**User dismissals**
```typescript
userDismissedRowKeys: Set<string>
userDismissalNotesByEntryId: Record<string, string>
```

**In-memory CSV (ref, not state)**
```typescript
statementCsvRowsByAccountRef.current: Record<string, string[][]>
```
Used by `rematchAllStoredAccounts()` — survives across re-renders without triggering them.

### Key `useMemo` Values

**`userInputtedEntries`** — combines expenses + transfers, marks each as "completed" if:
- Claimed to a bank hash, OR
- Auto-matched by exact match, OR
- Transfer is auto-completed, OR
- User-dismissed

**`statementReviewRowsByAccount`** — bank transactions needing manual review (unmatched, suggested, questionable, transfer). Excludes `processed` unless disconnected.

**`statementAutoMatchedRowsByAccount`** — `exact_match` rows with linked sheet entries.

**`homeFilteredIncompleteRows`** — user entries without a matched bank transaction (left column of home view).

**`homeFilteredMatchedRows`** — user entries with a linked bank transaction (middle column).

---

## Key Handler Functions

### `handleApprove(match, userEntry?)`
- With `userEntry`: Links a specific sheet entry to a bank transaction
  - Validates amount match
  - POST `/claims` or `/transfer-claims`
  - POST `/processed`
- Without `userEntry`: Auto-approves a suggested match
  - Opens transfer claim modal if match is a transfer
  - Creates claim link if match is an expense

### `handleDisconnectSheetLink(match)`
1. DELETE `/claims` and `/transfer-claims` for this bank hash
2. DELETE `/processed` for this bank hash
3. Call `rematchAllStoredAccounts()` to regenerate matches from stored CSV
4. Falls back to patching `matchType` to `"unmatched"` if no stored CSV available

### `handleSplitSubmit()`
- Links one bank transaction to multiple sheet rows
- Validates: all rows are same type (all expenses OR all transfers, not mixed)
- Validates: amounts sum to bank transaction amount
- Creates one claim link per row

### `handleTransferClaimSubmit()`
- Claims a bank transaction as one leg of a transfer
- Triggers `rematchAllStoredAccounts()` after (expensive — re-runs `/match` for every account)

### `rematchAllStoredAccounts()`
- Iterates `statementCsvRowsByAccountRef.current`
- POST `/match` for each account with current sheet data + processedHashes
- Auto-approves any new `exact_match` with linked entries
- POST `/match-cache` to persist updated results

### `onDrop(files)`
- Parses CSV with PapaParse
- Merges with existing stored CSV rows (newest rows win)
- POST `/match` → auto-approve → POST `/match-cache` + `/csv-rows`

---

## Key Workflows

### Standard Reconciliation
1. Upload bank CSV for account (drag-and-drop in account detail view)
2. High-confidence transactions auto-match (`exact_match`)
3. Review remaining rows in the "Unmatched/Suggested" tab
4. Approve suggested matches or manually claim from sheet entries
5. Dismiss bank transactions that need no sheet entry (fees, etc.)
6. All rows become processed and disappear from review

### Split Claim
1. One bank transaction covers multiple sheet expenses ($200 + $300 = $500)
2. Open split modal, select both expense rows
3. System validates totals match
4. Two claim links created under same bank hash

### Transfer Claim (2-leg)
1. User records a $1000 transfer from Checking → Savings in Sheets
2. Upload Checking CSV: `-$1000` bank row → matches transfer, claim leg 1 (`expectedLegs=2`)
3. `rematchAllStoredAccounts()` runs
4. Upload Savings CSV: `+$1000` bank row → matches same transfer, claim leg 2
5. Transfer status: `claimedCount=2`, `isComplete=true`

### Disconnect & Re-reconcile
1. Wrong claim exists on a bank row
2. Click disconnect (pencil/X icon on matched row)
3. System removes claim + unmarks processed
4. `rematchAllStoredAccounts()` re-runs all stored CSVs against current sheet state
5. Bank row reappears in review with updated candidates

---

## Important Invariants & Gotchas

- **Hash stability is critical.** All existing Neon records key off SHA256(date|amount|description). Never modify the normalization logic without migrating stored hashes.

- **One expense row per claim.** `UNIQUE(sheet_name, sheet_row_id)` on `reconciliation_claim_links`. Attempting to link the same sheet row to two bank hashes returns 409.

- **One bank hash per transfer leg.** `UNIQUE(bank_hash)` on `reconciliation_transfer_claim_links`. But the same `transfer_sheet_row_id` appears twice (two legs).

- **Transfer claim triggers full rematch.** `handleTransferClaimSubmit()` calls `rematchAllStoredAccounts()` which hits `/match` once per account. Keep stored account count in mind.

- **Ambiguous clusters never auto-match.** Two transactions with same amount, similar description, and within 1 day — both require manual review regardless of individual confidence.

- **`processedHashes` param prevents rematch loops.** When `rematchAllStoredAccounts()` calls `/match`, it passes current `processedHashes`. The match route skips processed hashes, preventing already-resolved transactions from re-entering the review queue.

- **localStorage fallback key:** `reconcile-page-state-v3`. On page load, if Neon data is available, localStorage state is migrated to Neon and localStorage is cleared.

- **Wells Fargo year boundary.** Date derivation from description handles Dec→Jan wraparound. A `PURCHASE AUTHORIZED ON 12/31` embedded in a January posting date is correctly assigned to the prior year.

- **Neon HTTP driver chunk limit.** Bulk inserts in reconciliation routes use `NEON_SAVE_CHUNK_SIZE` to split large arrays across multiple per-row transactions, working around the Neon serverless HTTP driver's payload limits.

- **Amount sign convention.** Bank transaction amounts are signed: negative = debit/outgoing, positive = credit/incoming. Sheet expense amounts are always positive. Transfer amounts are positive; directionality comes from `transferFrom`/`transferTo` fields.

- **CSV merge strategy.** When a new CSV is uploaded for an account that already has stored rows, rows are merged by shape (joining on row content). Newest version of a row wins. This handles re-uploads without duplicating rows.
