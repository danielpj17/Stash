import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

type CsvRowRecord = {
  account_name: string;
  dedupe_key: string;
  cells: string[];
};

async function ensureCsvRowsTable(sql: any) {
  await sql`
    CREATE TABLE IF NOT EXISTS reconciliation_csv_rows (
      account_name TEXT NOT NULL,
      dedupe_key   TEXT NOT NULL,
      cells        JSONB NOT NULL,
      created_at   TIMESTAMP DEFAULT now(),
      PRIMARY KEY (account_name, dedupe_key)
    )
  `;
}

function csvRowDedupeKey(row: string[]): string {
  return row.map((c) => String(c).trim()).join("\t");
}

export async function GET() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    return NextResponse.json({ rowsByAccount: {} as Record<string, string[][]> });
  }

  try {
    const sql = neon(connectionString);
    await ensureCsvRowsTable(sql);
    const rows = (await sql`
      SELECT account_name, cells
      FROM reconciliation_csv_rows
      ORDER BY created_at ASC
    `) as CsvRowRecord[];

    const rowsByAccount: Record<string, string[][]> = {};
    for (const row of rows) {
      const account = String(row.account_name ?? "").trim();
      if (!account) continue;
      const cells = Array.isArray(row.cells)
        ? row.cells.map((c: unknown) => String(c ?? ""))
        : [];
      if (cells.length === 0) continue;
      if (!rowsByAccount[account]) rowsByAccount[account] = [];
      rowsByAccount[account].push(cells);
    }

    return NextResponse.json({ rowsByAccount });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to fetch CSV rows" },
      { status: 502 },
    );
  }
}

export async function POST(request: NextRequest) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    return NextResponse.json({ error: "DATABASE_URL not configured" }, { status: 503 });
  }

  let body: { accountName?: unknown; rows?: unknown };
  try {
    body = (await request.json()) as { accountName?: unknown; rows?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const accountName = typeof body.accountName === "string" ? body.accountName.trim() : "";
  if (!accountName) {
    return NextResponse.json({ error: "accountName is required" }, { status: 400 });
  }
  if (!Array.isArray(body.rows)) {
    return NextResponse.json({ error: "rows must be an array" }, { status: 400 });
  }

  const validRows: Array<{ key: string; cells: string[] }> = [];
  for (const row of body.rows) {
    if (!Array.isArray(row)) continue;
    const cells = row.map((c: unknown) => (c === null || c === undefined ? "" : String(c)));
    const key = csvRowDedupeKey(cells);
    if (key) validRows.push({ key, cells });
  }

  if (validRows.length === 0) {
    return NextResponse.json({ success: true, count: 0 });
  }

  try {
    const sql = neon(connectionString);
    await ensureCsvRowsTable(sql);

    const accountNames = validRows.map(() => accountName);
    const dedupeKeys = validRows.map((r) => r.key);
    const cellsJsonArray = validRows.map((r) => JSON.stringify(r.cells));

    await sql`
      INSERT INTO reconciliation_csv_rows (account_name, dedupe_key, cells)
      SELECT * FROM unnest(
        ${accountNames}::text[],
        ${dedupeKeys}::text[],
        ${cellsJsonArray}::jsonb[]
      )
      ON CONFLICT (account_name, dedupe_key)
      DO UPDATE SET cells = EXCLUDED.cells, created_at = now()
    `;

    return NextResponse.json({ success: true, count: validRows.length });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to save CSV rows" },
      { status: 502 },
    );
  }
}
