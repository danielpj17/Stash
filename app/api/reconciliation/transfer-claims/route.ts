import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type TransferClaimRow = {
  transfer_sheet_row_id: string;
  bank_hash: string;
  bank_account_name: string | null;
  bank_amount_cents: number;
  expected_legs: number;
  created_at: string;
};

type TransferClaimRequestBody = {
  transferRowId?: unknown;
  expectedLegs?: unknown;
  bankTransaction?: {
    hash?: unknown;
    accountName?: unknown;
    amount?: unknown;
  };
};

function toCents(value: number): number {
  return Math.round(Number(value) * 100);
}

function normalizeExpectedLegs(value: unknown): 1 | 2 {
  const parsed = Number(value);
  return parsed === 1 ? 1 : 2;
}

async function ensureTransferClaimsTable(sql: ReturnType<typeof neon>) {
  await sql`
    CREATE TABLE IF NOT EXISTS reconciliation_transfer_claim_links (
      transfer_sheet_row_id TEXT NOT NULL,
      bank_hash TEXT NOT NULL,
      bank_account_name TEXT,
      bank_amount_cents INTEGER NOT NULL,
      expected_legs INTEGER NOT NULL DEFAULT 2 CHECK (expected_legs IN (1, 2)),
      created_at TIMESTAMP DEFAULT now(),
      PRIMARY KEY (transfer_sheet_row_id, bank_hash),
      UNIQUE (bank_hash)
    )
  `;
}

export async function GET() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    return NextResponse.json({
      claims: [] as Array<{
        transferRowId: string;
        bankHash: string;
        bankAccountName?: string;
        bankAmountCents: number;
        expectedLegs: number;
        createdAt: string;
      }>,
      statusByRowId: {} as Record<
        string,
        { claimedCount: number; expectedLegs: number; isComplete: boolean }
      >,
    });
  }

  try {
    const sql = neon(connectionString);
    await ensureTransferClaimsTable(sql);
    const rows = (await sql`
      SELECT transfer_sheet_row_id, bank_hash, bank_account_name, bank_amount_cents, expected_legs, created_at
      FROM reconciliation_transfer_claim_links
      ORDER BY created_at DESC
    `) as TransferClaimRow[];

    const statusByRowId: Record<
      string,
      { claimedCount: number; expectedLegs: number; isComplete: boolean }
    > = {};
    for (const row of rows) {
      const rowId = String(row.transfer_sheet_row_id ?? "").trim();
      if (!rowId) continue;
      if (!statusByRowId[rowId]) {
        statusByRowId[rowId] = { claimedCount: 0, expectedLegs: 2, isComplete: false };
      }
      statusByRowId[rowId].claimedCount += 1;
      const expectedLegs = Number(row.expected_legs ?? 2) === 1 ? 1 : 2;
      if (expectedLegs > statusByRowId[rowId].expectedLegs) {
        statusByRowId[rowId].expectedLegs = expectedLegs;
      }
      statusByRowId[rowId].isComplete =
        statusByRowId[rowId].claimedCount >= statusByRowId[rowId].expectedLegs;
    }

    return NextResponse.json({
      claims: rows.map((row) => ({
        transferRowId: row.transfer_sheet_row_id,
        bankHash: row.bank_hash,
        bankAccountName: row.bank_account_name ?? undefined,
        bankAmountCents: Number(row.bank_amount_cents ?? 0),
        expectedLegs: Number(row.expected_legs ?? 2) === 1 ? 1 : 2,
        createdAt: row.created_at,
      })),
      statusByRowId,
    });
  } catch (err) {
    console.error("Transfer claims GET error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to fetch transfer claims" },
      { status: 502 },
    );
  }
}

export async function POST(request: NextRequest) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    return NextResponse.json({ error: "DATABASE_URL not configured" }, { status: 503 });
  }

  let body: TransferClaimRequestBody;
  try {
    body = (await request.json()) as TransferClaimRequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const transferRowId = typeof body.transferRowId === "string" ? body.transferRowId.trim() : "";
  const bankHash = typeof body.bankTransaction?.hash === "string"
    ? body.bankTransaction.hash.trim()
    : "";
  const bankAccountName = typeof body.bankTransaction?.accountName === "string"
    ? body.bankTransaction.accountName.trim()
    : "";
  const bankAmount = Number(body.bankTransaction?.amount);
  const requestedExpectedLegs = normalizeExpectedLegs(body.expectedLegs);

  if (!transferRowId) {
    return NextResponse.json({ error: "transferRowId is required" }, { status: 400 });
  }
  if (!bankHash) {
    return NextResponse.json({ error: "bankTransaction.hash is required" }, { status: 400 });
  }
  if (!Number.isFinite(bankAmount) || toCents(bankAmount) === 0) {
    return NextResponse.json(
      { error: "bankTransaction.amount must be non-zero numeric" },
      { status: 400 },
    );
  }

  try {
    const sql = neon(connectionString);
    await ensureTransferClaimsTable(sql);

    const existing = (await sql`
      SELECT transfer_sheet_row_id, bank_hash, bank_account_name, bank_amount_cents, expected_legs, created_at
      FROM reconciliation_transfer_claim_links
      WHERE transfer_sheet_row_id = ${transferRowId}
      ORDER BY created_at ASC
    `) as TransferClaimRow[];

    const existingForHash = existing.find((row) => row.bank_hash === bankHash);
    if (existingForHash) {
      return NextResponse.json({
        success: true,
        transferRowId,
        alreadyClaimed: true,
        claimedCount: existing.length,
        expectedLegs: Number(existingForHash.expected_legs ?? 2) === 1 ? 1 : 2,
        isComplete:
          existing.length >= (Number(existingForHash.expected_legs ?? 2) === 1 ? 1 : 2),
      });
    }

    const effectiveExpectedLegs = existing.length > 0
      ? (Number(existing[0]?.expected_legs ?? 2) === 1 ? 1 : 2)
      : requestedExpectedLegs;

    if (existing.length >= effectiveExpectedLegs) {
      return NextResponse.json(
        { error: "Transfer row is already fully claimed." },
        { status: 409 },
      );
    }

    const newAmountCents = toCents(bankAmount);
    if (effectiveExpectedLegs === 2 && existing.length > 0) {
      const hasPositive = existing.some((row) => Number(row.bank_amount_cents) > 0);
      const hasNegative = existing.some((row) => Number(row.bank_amount_cents) < 0);
      if ((newAmountCents > 0 && hasPositive) || (newAmountCents < 0 && hasNegative)) {
        return NextResponse.json(
          { error: "Second leg must be opposite sign of existing claimed leg." },
          { status: 409 },
        );
      }
    }

    await sql`
      INSERT INTO reconciliation_transfer_claim_links (
        transfer_sheet_row_id,
        bank_hash,
        bank_account_name,
        bank_amount_cents,
        expected_legs
      )
      VALUES (
        ${transferRowId},
        ${bankHash},
        ${bankAccountName || null},
        ${newAmountCents},
        ${effectiveExpectedLegs}
      )
    `;

    await sql`
      INSERT INTO processed_transactions (hash, account_name)
      VALUES (${bankHash}, ${bankAccountName || null})
      ON CONFLICT (hash) DO UPDATE SET account_name = EXCLUDED.account_name
    `;

    const claimedCount = existing.length + 1;
    const isComplete = claimedCount >= effectiveExpectedLegs;
    return NextResponse.json({
      success: true,
      transferRowId,
      claimedCount,
      expectedLegs: effectiveExpectedLegs,
      isComplete,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to save transfer claim";
    const isConflict = message.toLowerCase().includes("unique");
    return NextResponse.json({ error: message }, { status: isConflict ? 409 : 502 });
  }
}
