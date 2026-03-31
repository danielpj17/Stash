import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type UserDismissalRow = {
  sheet_name: string;
  sheet_row_id: string;
  note: string;
  created_at: string;
};

async function ensureUserDismissalsTable(sql: any) {
  await sql`
    CREATE TABLE IF NOT EXISTS reconciliation_user_sheet_dismissals (
      sheet_name TEXT NOT NULL,
      sheet_row_id TEXT NOT NULL,
      note TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT now(),
      PRIMARY KEY (sheet_name, sheet_row_id)
    )
  `;
}

function claimKey(sheetName: string, sheetRowId: string): string {
  return `${sheetName}:${sheetRowId}`;
}

export async function GET() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    return NextResponse.json({ dismissedKeys: [] as string[] });
  }

  try {
    const sql = neon(connectionString);
    await ensureUserDismissalsTable(sql);
    const rows = (await sql`
      SELECT sheet_name, sheet_row_id, note, created_at
      FROM reconciliation_user_sheet_dismissals
      ORDER BY created_at DESC
    `) as UserDismissalRow[];

    return NextResponse.json({
      dismissedKeys: rows.map((r) => claimKey(r.sheet_name, r.sheet_row_id)),
      dismissals: rows.map((r) => ({
        sheetName: r.sheet_name,
        sheetRowId: r.sheet_row_id,
        note: r.note,
        createdAt: r.created_at,
      })),
    });
  } catch (err) {
    console.error("Reconciliation user-dismissals GET error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to fetch user dismissals" },
      { status: 502 },
    );
  }
}

export async function POST(request: NextRequest) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    return NextResponse.json({ error: "DATABASE_URL not configured" }, { status: 503 });
  }

  let body: { sheetName?: unknown; sheetRowId?: unknown; note?: unknown };
  try {
    body = (await request.json()) as { sheetName?: unknown; sheetRowId?: unknown; note?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const sheetName =
    typeof body.sheetName === "string" ? body.sheetName.trim() : "";
  const sheetRowId =
    typeof body.sheetRowId === "string" ? body.sheetRowId.trim() : "";
  const note = typeof body.note === "string" ? body.note.trim() : "";

  if (sheetName !== "Expenses" && sheetName !== "Transfers") {
    return NextResponse.json(
      { error: "sheetName must be Expenses or Transfers" },
      { status: 400 },
    );
  }
  if (!sheetRowId) {
    return NextResponse.json({ error: "sheetRowId is required" }, { status: 400 });
  }
  if (!note) {
    return NextResponse.json({ error: "note is required" }, { status: 400 });
  }

  const sql = neon(connectionString);
  try {
    await ensureUserDismissalsTable(sql);
    await sql`
      INSERT INTO reconciliation_user_sheet_dismissals (sheet_name, sheet_row_id, note)
      VALUES (${sheetName}, ${sheetRowId}, ${note})
      ON CONFLICT (sheet_name, sheet_row_id) DO UPDATE SET note = EXCLUDED.note
    `;
    return NextResponse.json({
      success: true,
      key: claimKey(sheetName, sheetRowId),
      sheetName,
      sheetRowId,
      note,
    });
  } catch (err) {
    console.error("Reconciliation user-dismissals POST error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to save user dismissal" },
      { status: 502 },
    );
  }
}
