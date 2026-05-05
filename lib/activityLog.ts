import { randomUUID } from "crypto";

export type ActivityActionType =
  | "claim_create"
  | "claim_delete"
  | "transfer_claim_create"
  | "transfer_claim_delete"
  | "dismiss_create"
  | "dismiss_delete"
  | "user_dismiss_create"
  | "user_dismiss_delete"
  | "processed_mark"
  | "processed_unmark"
  | "memory_create"
  | "memory_increment"
  | "memory_delete"
  | "csv_upload"
  | "bulk_approve"
  | "quick_log";

export type ActivityActor = "user" | "auto_match" | "memory_match";

export type ActivityLogParams = {
  actionType: ActivityActionType;
  actor: ActivityActor;
  payload: Record<string, unknown>;
  csvUploadId?: string | null;
  bulkActionId?: string | null;
  parentActionId?: string | null;
};

export async function ensureActivityLogTable(sql: any): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS reconciliation_activity_log (
      id UUID PRIMARY KEY,
      occurred_at TIMESTAMP NOT NULL DEFAULT now(),
      action_type TEXT NOT NULL,
      actor TEXT NOT NULL,
      csv_upload_id UUID,
      bulk_action_id UUID,
      parent_action_id UUID,
      payload JSONB NOT NULL,
      reverted_at TIMESTAMP,
      reverted_by_action_id UUID
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_activity_log_occurred
    ON reconciliation_activity_log(occurred_at DESC)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_activity_log_csv
    ON reconciliation_activity_log(csv_upload_id)
  `;
}

function normalizeUuid(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  // Accept any UUID-shaped string. Postgres will reject bad values.
  if (!/^[0-9a-fA-F-]{32,36}$/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Build an INSERT statement for the activity log that can be passed into
 * sql.transaction([...]) alongside the underlying mutation, so the audit row
 * commits atomically with the change it describes.
 *
 * Returns the new id so the caller can include it in the API response.
 */
export function buildActivityLogInsert(
  sql: any,
  params: ActivityLogParams,
): { id: string; query: any } {
  const id = randomUUID();
  const csvUploadId = normalizeUuid(params.csvUploadId);
  const bulkActionId = normalizeUuid(params.bulkActionId);
  const parentActionId = normalizeUuid(params.parentActionId);
  const payloadJson = JSON.stringify(params.payload ?? {});

  const query = sql`
    INSERT INTO reconciliation_activity_log (
      id,
      action_type,
      actor,
      csv_upload_id,
      bulk_action_id,
      parent_action_id,
      payload
    )
    VALUES (
      ${id}::uuid,
      ${params.actionType},
      ${params.actor},
      ${csvUploadId}::uuid,
      ${bulkActionId}::uuid,
      ${parentActionId}::uuid,
      ${payloadJson}::jsonb
    )
  `;

  return { id, query };
}

/**
 * Standalone insert — best-effort. Used when the caller cannot easily wrap
 * the underlying mutation in a transaction. Failures are non-fatal but
 * logged to the server console because losing audit rows is a real concern.
 */
export async function logActivity(
  sql: any,
  params: ActivityLogParams,
): Promise<string | null> {
  try {
    await ensureActivityLogTable(sql);
    const { id, query } = buildActivityLogInsert(sql, params);
    await query;
    return id;
  } catch (err) {
    console.error("activity log insert failed", err);
    return null;
  }
}

/**
 * Helper for routes — parses optional grouping IDs out of a request body.
 * Returns sanitized values (null for missing/invalid).
 */
export function parseActivityGroupingIds(body: unknown): {
  csvUploadId: string | null;
  bulkActionId: string | null;
  parentActionId: string | null;
} {
  const obj = (body ?? {}) as Record<string, unknown>;
  return {
    csvUploadId: normalizeUuid(obj.csvUploadId),
    bulkActionId: normalizeUuid(obj.bulkActionId),
    parentActionId: normalizeUuid(obj.parentActionId),
  };
}
