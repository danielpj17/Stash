import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import {
  findMatches,
  mapBankRowsToTransactions,
  type SheetExpenseLike,
  type SheetTransferLike,
} from "@/services/reconciliationService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROFILE_BY_ACCOUNT: Record<string, string> = {
  "Wells Fargo": "Wells Fargo",
  "Venmo - Daniel": "Venmo",
  "Venmo - Katie": "Venmo",
  Venmo: "Venmo",
  "Capital One": "Capital One",
  "America First": "America First",
  Discover: "Discover",
};

type MatchRequestBody = {
  accountName?: unknown;
  rows?: unknown;
  sheetExpenses?: unknown;
  sheetTransfers?: unknown;
  processedHashes?: unknown;
};

function normalizeSheetExpenses(value: unknown): SheetExpenseLike[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((row) => row as Record<string, unknown>)
    .filter((row) => row && typeof row === "object")
    .map((row) => ({
      amount: Number(row.amount ?? 0),
      timestamp: typeof row.timestamp === "string" ? row.timestamp : undefined,
      date: typeof row.date === "string" ? row.date : undefined,
      description: typeof row.description === "string" ? row.description : undefined,
      expenseType: typeof row.expenseType === "string" ? row.expenseType : undefined,
      account: typeof row.account === "string" ? row.account : undefined,
      rowId:
        typeof row.rowId === "string"
          ? row.rowId
          : typeof row["Row ID"] === "string"
            ? (row["Row ID"] as string)
            : undefined,
    }))
    .filter((row) => Number.isFinite(row.amount));
}

function normalizeCsvRows(value: unknown): string[][] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((row) => Array.isArray(row))
    .map((row) =>
      (row as unknown[]).map((cell) => (cell === null || cell === undefined ? "" : String(cell))),
    );
}

function normalizeSheetTransfers(value: unknown): SheetTransferLike[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((row) => row as Record<string, unknown>)
    .filter((row) => row && typeof row === "object")
    .map((row) => ({
      amount: Number(row.amount ?? 0),
      timestamp: typeof row.timestamp === "string" ? row.timestamp : undefined,
      date: typeof row.date === "string" ? row.date : undefined,
      transferFrom: typeof row.transferFrom === "string" ? row.transferFrom : undefined,
      transferTo: typeof row.transferTo === "string" ? row.transferTo : undefined,
      description: typeof row.description === "string" ? row.description : undefined,
      transferRowId:
        typeof row.transferRowId === "string"
          ? row.transferRowId
          : typeof row["Transfer Row ID"] === "string"
            ? (row["Transfer Row ID"] as string)
            : undefined,
    }))
    .filter((row) => Number.isFinite(row.amount));
}

async function getClaimedExpenseRowIds(): Promise<Set<string>> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return new Set<string>();

  try {
    const sql = neon(connectionString);
    const rows = (await sql`
      SELECT sheet_row_id
      FROM reconciliation_claim_links
      WHERE sheet_name = 'Expenses'
    `) as Array<{ sheet_row_id: string }>;
    return new Set(rows.map((row) => String(row.sheet_row_id)));
  } catch {
    // If claim table does not exist yet, continue without filtering.
    return new Set<string>();
  }
}

type TransferClaimRow = {
  transfer_sheet_row_id: string;
  bank_amount_cents: number;
  expected_legs: number;
};

async function getTransferClaimStatusByRowId(): Promise<
  Record<
    string,
    {
      claimedCount: number;
      expectedLegs: number;
      isComplete: boolean;
      hasPositive: boolean;
      hasNegative: boolean;
    }
  >
> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return {};

  try {
    const sql = neon(connectionString);
    const rows = (await sql`
      SELECT transfer_sheet_row_id, bank_amount_cents, expected_legs
      FROM reconciliation_transfer_claim_links
    `) as TransferClaimRow[];

    const statusByRowId: Record<
      string,
      {
        claimedCount: number;
        expectedLegs: number;
        isComplete: boolean;
        hasPositive: boolean;
        hasNegative: boolean;
      }
    > = {};

    for (const row of rows) {
      const rowId = String(row.transfer_sheet_row_id ?? "").trim();
      if (!rowId) continue;
      const expectedLegs = Number(row.expected_legs ?? 2) === 1 ? 1 : 2;
      if (!statusByRowId[rowId]) {
        statusByRowId[rowId] = {
          claimedCount: 0,
          expectedLegs,
          isComplete: false,
          hasPositive: false,
          hasNegative: false,
        };
      }
      statusByRowId[rowId].claimedCount += 1;
      if (expectedLegs > statusByRowId[rowId].expectedLegs) {
        statusByRowId[rowId].expectedLegs = expectedLegs;
      }
      const amount = Number(row.bank_amount_cents ?? 0);
      if (amount > 0) statusByRowId[rowId].hasPositive = true;
      if (amount < 0) statusByRowId[rowId].hasNegative = true;
    }

    for (const rowId of Object.keys(statusByRowId)) {
      const entry = statusByRowId[rowId];
      entry.isComplete = entry.claimedCount >= entry.expectedLegs;
    }

    return statusByRowId;
  } catch {
    // If table does not exist yet, continue without transfer-claim filtering.
    return {};
  }
}

export async function POST(request: NextRequest) {
  let body: MatchRequestBody;
  try {
    body = (await request.json()) as MatchRequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const accountName = typeof body.accountName === "string" ? body.accountName.trim() : "";
  if (!accountName) {
    return NextResponse.json({ error: "accountName is required" }, { status: 400 });
  }

  const profileAccount = PROFILE_BY_ACCOUNT[accountName] ?? accountName;
  const rows = normalizeCsvRows(body.rows);
  const sheetExpenses = normalizeSheetExpenses(body.sheetExpenses);
  const sheetTransfers = normalizeSheetTransfers(body.sheetTransfers);
  const processedHashes = Array.isArray(body.processedHashes)
    ? body.processedHashes.map((h) => String(h))
    : undefined;

  const bankTransactions = mapBankRowsToTransactions(profileAccount, rows).map((tx) => ({
    ...tx,
    accountName,
  }));

  const claimedExpenseRowIds = await getClaimedExpenseRowIds();
  const transferClaimStatusByRowId = await getTransferClaimStatusByRowId();
  const unclaimedSheetExpenses = sheetExpenses.filter((row) => {
    const rowId = (row.rowId ?? "").trim();
    if (!rowId) return true;
    return !claimedExpenseRowIds.has(rowId);
  });
  const availableSheetTransfers = sheetTransfers.filter((row) => {
    const rowId = (row.transferRowId ?? "").trim();
    if (!rowId) return true;
    const claimStatus = transferClaimStatusByRowId[rowId];
    return !claimStatus?.isComplete;
  });

  const matches = await findMatches(bankTransactions, unclaimedSheetExpenses, {
    processedHashes,
    sheetTransfers: availableSheetTransfers,
    transferClaimStatusByRowId,
  });
  return NextResponse.json({ bankTransactions, matches });
}
