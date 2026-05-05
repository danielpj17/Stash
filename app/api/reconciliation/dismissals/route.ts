import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import {
  buildActivityLogInsert,
  ensureActivityLogTable,
  parseActivityGroupingIds,
  type ActivityActor,
} from "@/lib/activityLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type DismissalRow = {
  hash: string;
  account_name: string;
  note: string;
  created_at: string;
};

function normalizeActor(value: unknown): ActivityActor {
  if (value === "auto_match" || value === "memory_match") return value;
  return "user";
}

async function ensureDismissalsTable(sql: any) {
  await sql`
    CREATE TABLE IF NOT EXISTS reconciliation_statement_dismissals (
      hash TEXT NOT NULL,
      account_name TEXT NOT NULL,
      note TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT now(),
      PRIMARY KEY (hash, account_name)
    )
  `;
}

export async function GET() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    return NextResponse.json({ dismissals: [] as unknown[] });
  }

  try {
    const sql = neon(connectionString);
    await ensureDismissalsTable(sql);
    const rows = (await sql`
      SELECT hash, account_name, note, created_at
      FROM reconciliation_statement_dismissals
      ORDER BY created_at DESC
    `) as DismissalRow[];

    return NextResponse.json({
      dismissals: rows.map((r) => ({
        hash: r.hash,
        accountName: r.account_name ?? "",
        note: r.note,
        createdAt: r.created_at,
      })),
    });
  } catch (err) {
    console.error("Reconciliation dismissals GET error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to fetch dismissals" },
      { status: 502 },
    );
  }
}

export async function POST(request: NextRequest) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    return NextResponse.json({ error: "DATABASE_URL not configured" }, { status: 503 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const hash =
    typeof (body as { hash?: unknown })?.hash === "string"
      ? (body as { hash: string }).hash.trim()
      : "";
  const accountName =
    typeof (body as { accountName?: unknown })?.accountName === "string"
      ? (body as { accountName: string }).accountName.trim()
      : "";
  const note =
    typeof (body as { note?: unknown })?.note === "string"
      ? (body as { note: string }).note.trim()
      : "";

  if (!hash) {
    return NextResponse.json({ error: "hash is required" }, { status: 400 });
  }
  if (!accountName) {
    return NextResponse.json({ error: "accountName is required" }, { status: 400 });
  }
  if (!note) {
    return NextResponse.json({ error: "note is required" }, { status: 400 });
  }

  const actor = normalizeActor((body as { actor?: unknown }).actor);
  const grouping = parseActivityGroupingIds(body);

  const sql = neon(connectionString);
  try {
    await ensureDismissalsTable(sql);
    await ensureActivityLogTable(sql);

    const { id: actionId, query: logInsert } = buildActivityLogInsert(sql, {
      actionType: "dismiss_create",
      actor,
      payload: { hash, accountName, note },
      csvUploadId: grouping.csvUploadId,
      bulkActionId: grouping.bulkActionId,
      parentActionId: grouping.parentActionId,
    });

    await sql.transaction([
      sql`
        INSERT INTO reconciliation_statement_dismissals (hash, account_name, note)
        VALUES (${hash}, ${accountName}, ${note})
        ON CONFLICT (hash, account_name) DO UPDATE SET note = EXCLUDED.note
      `,
      sql`
        INSERT INTO processed_transactions (hash, account_name)
        VALUES (${hash}, ${accountName})
        ON CONFLICT (hash) DO UPDATE SET account_name = EXCLUDED.account_name
      `,
      logInsert,
    ]);
    return NextResponse.json({ success: true, hash, accountName, note, actionId });
  } catch (err) {
    console.error("Reconciliation dismissals POST error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to save dismissal" },
      { status: 502 },
    );
  }
}

export async function DELETE(request: NextRequest) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    return NextResponse.json({ error: "DATABASE_URL not configured" }, { status: 503 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const hash =
    typeof (body as { hash?: unknown })?.hash === "string"
      ? (body as { hash: string }).hash.trim()
      : "";
  const accountName =
    typeof (body as { accountName?: unknown })?.accountName === "string"
      ? (body as { accountName: string }).accountName.trim()
      : "";

  if (!hash) {
    return NextResponse.json({ error: "hash is required" }, { status: 400 });
  }

  const actor = normalizeActor((body as { actor?: unknown }).actor);
  const grouping = parseActivityGroupingIds(body);

  try {
    const sql = neon(connectionString);
    await ensureDismissalsTable(sql);
    await ensureActivityLogTable(sql);

    const existing = accountName
      ? ((await sql`
          SELECT hash, account_name, note
          FROM reconciliation_statement_dismissals
          WHERE hash = ${hash} AND account_name = ${accountName}
        `) as DismissalRow[])
      : ((await sql`
          SELECT hash, account_name, note
          FROM reconciliation_statement_dismissals
          WHERE hash = ${hash}
        `) as DismissalRow[]);

    const { id: actionId, query: logInsert } = buildActivityLogInsert(sql, {
      actionType: "dismiss_delete",
      actor,
      payload: {
        hash,
        accountName: accountName || null,
        deleted: existing.map((row) => ({
          hash: row.hash,
          accountName: row.account_name,
          note: row.note,
        })),
      },
      csvUploadId: grouping.csvUploadId,
      bulkActionId: grouping.bulkActionId,
      parentActionId: grouping.parentActionId,
    });

    const deleteQuery = accountName
      ? sql`
          DELETE FROM reconciliation_statement_dismissals
          WHERE hash = ${hash} AND account_name = ${accountName}
        `
      : sql`
          DELETE FROM reconciliation_statement_dismissals
          WHERE hash = ${hash}
        `;

    await sql.transaction([deleteQuery, logInsert]);

    return NextResponse.json({
      success: true,
      hash,
      deleted: existing.length,
      actionId,
    });
  } catch (err) {
    console.error("Reconciliation dismissals DELETE error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to delete dismissal" },
      { status: 502 },
    );
  }
}
