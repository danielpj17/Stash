import { NextRequest, NextResponse } from "next/server";
import { findMatches, mapBankRowsToTransactions, type SheetExpenseLike } from "@/services/reconciliationService";

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
  const processedHashes = Array.isArray(body.processedHashes)
    ? body.processedHashes.map((h) => String(h))
    : undefined;

  const bankTransactions = mapBankRowsToTransactions(profileAccount, rows).map((tx) => ({
    ...tx,
    accountName,
  }));

  const matches = await findMatches(bankTransactions, sheetExpenses, { processedHashes });
  return NextResponse.json({ bankTransactions, matches });
}
