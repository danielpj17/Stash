import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import { ensureActivityLogTable } from "@/lib/activityLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ActivityRow = {
  id: string;
  occurred_at: string;
  action_type: string;
  actor: string;
  csv_upload_id: string | null;
  bulk_action_id: string | null;
  parent_action_id: string | null;
  payload: unknown;
  reverted_at: string | null;
  reverted_by_action_id: string | null;
};

const DEFAULT_SINCE_DAYS = 30;

function defaultSinceDate(): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - DEFAULT_SINCE_DAYS);
  return d.toISOString().slice(0, 10);
}

function parseSinceParam(value: string | null): string {
  if (!value) return defaultSinceDate();
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return defaultSinceDate();
  const d = new Date(`${trimmed}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return defaultSinceDate();
  return trimmed;
}

export async function GET(request: NextRequest) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    return NextResponse.json({ entries: [], since: defaultSinceDate() });
  }

  const since = parseSinceParam(request.nextUrl.searchParams.get("since"));

  try {
    const sql = neon(connectionString);
    await ensureActivityLogTable(sql);

    const rows = (await sql`
      SELECT
        id,
        occurred_at,
        action_type,
        actor,
        csv_upload_id,
        bulk_action_id,
        parent_action_id,
        payload,
        reverted_at,
        reverted_by_action_id
      FROM reconciliation_activity_log
      WHERE occurred_at >= ${since}::timestamp
      ORDER BY occurred_at DESC
      LIMIT 500
    `) as ActivityRow[];

    return NextResponse.json({
      since,
      entries: rows.map((row) => ({
        id: row.id,
        occurredAt: row.occurred_at,
        actionType: row.action_type,
        actor: row.actor,
        csvUploadId: row.csv_upload_id,
        bulkActionId: row.bulk_action_id,
        parentActionId: row.parent_action_id,
        payload: row.payload,
        revertedAt: row.reverted_at,
        revertedByActionId: row.reverted_by_action_id,
      })),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to fetch activity log" },
      { status: 502 },
    );
  }
}
