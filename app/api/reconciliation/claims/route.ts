import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ClaimRow = {
  bank_hash: string;
  account_name: string | null;
  sheet_name: string;
  sheet_row_id: string;
  amount_cents: number;
  created_at: string;
};

type ClaimRequestBody = {
  bankTransaction?: {
    hash?: unknown;
    accountName?: unknown;
    amount?: unknown;
    date?: unknown;
    description?: unknown;
  };
  links?: Array<{
    sheetName?: unknown;
    sheetRowId?: unknown;
    amount?: unknown;
  }>;
};

function toCents(value: number): number {
  return Math.round(value * 100);
}

async function ensureClaimsTable(sql: any) {
  await sql`
    CREATE TABLE IF NOT EXISTS reconciliation_claim_links (
      bank_hash TEXT NOT NULL,
      account_name TEXT,
      sheet_name TEXT NOT NULL DEFAULT 'Expenses',
      sheet_row_id TEXT NOT NULL,
      amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
      created_at TIMESTAMP DEFAULT now(),
      PRIMARY KEY (bank_hash, sheet_name, sheet_row_id),
      UNIQUE (sheet_name, sheet_row_id)
    )
  `;
}

export async function GET() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    return NextResponse.json({ claims: [], claimedRowIds: [] as string[] });
  }

  try {
    const sql = neon(connectionString);
    await ensureClaimsTable(sql);
    const rows = (await sql`
      SELECT bank_hash, account_name, sheet_name, sheet_row_id, amount_cents, created_at
      FROM reconciliation_claim_links
      ORDER BY created_at DESC
    `) as ClaimRow[];

    return NextResponse.json({
      claims: rows.map((row) => ({
        bankHash: row.bank_hash,
        accountName: row.account_name ?? undefined,
        sheetName: row.sheet_name,
        sheetRowId: row.sheet_row_id,
        amountCents: Number(row.amount_cents ?? 0),
        createdAt: row.created_at,
      })),
      claimedRowIds: rows.map((row) => `${row.sheet_name}:${row.sheet_row_id}`),
    });
  } catch (err) {
    console.error("Reconciliation claims GET error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to fetch reconciliation claims" },
      { status: 502 },
    );
  }
}

export async function POST(request: NextRequest) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    return NextResponse.json({ error: "DATABASE_URL not configured" }, { status: 503 });
  }

  let body: ClaimRequestBody;
  try {
    body = (await request.json()) as ClaimRequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const bankHash = typeof body.bankTransaction?.hash === "string"
    ? body.bankTransaction.hash.trim()
    : "";
  const accountName = typeof body.bankTransaction?.accountName === "string"
    ? body.bankTransaction.accountName.trim()
    : "";
  const bankAmount = Number(body.bankTransaction?.amount);
  const links = Array.isArray(body.links) ? body.links : [];

  if (!bankHash) {
    return NextResponse.json({ error: "bankTransaction.hash is required" }, { status: 400 });
  }
  if (!Number.isFinite(bankAmount)) {
    return NextResponse.json({ error: "bankTransaction.amount must be numeric" }, { status: 400 });
  }
  if (links.length === 0) {
    return NextResponse.json({ error: "At least one link is required" }, { status: 400 });
  }

  const normalizedLinks = links.map((link) => ({
    sheetName: typeof link.sheetName === "string" ? link.sheetName.trim() || "Expenses" : "Expenses",
    sheetRowId: typeof link.sheetRowId === "string" ? link.sheetRowId.trim() : "",
    amountCents: toCents(Math.abs(Number(link.amount))),
  }));

  const invalidLink = normalizedLinks.find((link) => !link.sheetRowId || link.amountCents <= 0);
  if (invalidLink) {
    return NextResponse.json(
      { error: "Each link must include sheetRowId and a positive amount" },
      { status: 400 },
    );
  }

  const uniqueKeySet = new Set(normalizedLinks.map((link) => `${link.sheetName}:${link.sheetRowId}`));
  if (uniqueKeySet.size !== normalizedLinks.length) {
    return NextResponse.json(
      { error: "Duplicate sheet row selected in request" },
      { status: 400 },
    );
  }

  const targetCents = toCents(Math.abs(bankAmount));
  const enteredCents = normalizedLinks.reduce((sum, link) => sum + link.amountCents, 0);
  if (targetCents !== enteredCents) {
    return NextResponse.json(
      { error: "Linked amounts must equal the absolute bank transaction amount" },
      { status: 422 },
    );
  }

  try {
    const sql = neon(connectionString);
    await ensureClaimsTable(sql);

    const sheetNames = normalizedLinks.map((link) => link.sheetName);
    const sheetRowIds = normalizedLinks.map((link) => link.sheetRowId);
    const amountCents = normalizedLinks.map((link) => link.amountCents);

    await sql`
      INSERT INTO reconciliation_claim_links (
        bank_hash,
        account_name,
        sheet_name,
        sheet_row_id,
        amount_cents
      )
      SELECT
        ${bankHash},
        ${accountName || null},
        links.sheet_name,
        links.sheet_row_id,
        links.amount_cents
      FROM unnest(
        ${sheetNames}::text[],
        ${sheetRowIds}::text[],
        ${amountCents}::integer[]
      ) AS links(sheet_name, sheet_row_id, amount_cents)
    `;

    await sql`
      INSERT INTO processed_transactions (hash, account_name)
      VALUES (${bankHash}, ${accountName || null})
      ON CONFLICT (hash) DO UPDATE SET account_name = EXCLUDED.account_name
    `;

    return NextResponse.json({
      success: true,
      bankHash,
      linkedCount: normalizedLinks.length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to save reconciliation claim";
    const isConflict = message.toLowerCase().includes("unique");
    return NextResponse.json({ error: message }, { status: isConflict ? 409 : 502 });
  }
}

export async function DELETE(request: NextRequest) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    return NextResponse.json({ error: "DATABASE_URL not configured" }, { status: 503 });
  }

  let body: {
    bankTransaction?: {
      hash?: unknown;
      accountName?: unknown;
    };
  };
  try {
    body = (await request.json()) as {
      bankTransaction?: {
        hash?: unknown;
        accountName?: unknown;
      };
    };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const bankHash = typeof body.bankTransaction?.hash === "string"
    ? body.bankTransaction.hash.trim()
    : "";
  const accountName = typeof body.bankTransaction?.accountName === "string"
    ? body.bankTransaction.accountName.trim()
    : "";

  if (!bankHash) {
    return NextResponse.json({ error: "bankTransaction.hash is required" }, { status: 400 });
  }

  try {
    const sql = neon(connectionString);
    await ensureClaimsTable(sql);
    const rows = accountName
      ? (await sql`
          DELETE FROM reconciliation_claim_links
          WHERE bank_hash = ${bankHash} AND account_name = ${accountName}
          RETURNING bank_hash
        `) as Array<{ bank_hash: string }>
      : (await sql`
          DELETE FROM reconciliation_claim_links
          WHERE bank_hash = ${bankHash}
          RETURNING bank_hash
        `) as Array<{ bank_hash: string }>;

    return NextResponse.json({
      success: true,
      bankHash,
      deleted: rows.length,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to remove reconciliation claim links" },
      { status: 502 },
    );
  }
}
