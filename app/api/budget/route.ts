import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";

/** Stored shape: { "1": { "Groceries": 500 }, ... } — only months that have been saved */
type MonthlyBudgets = Record<string, Record<string, number>>;

function isValidMonthKey(k: string): boolean {
  const n = parseInt(k, 10);
  return Number.isFinite(n) && n >= 1 && n <= 12;
}

function normalizeBody(raw: unknown): MonthlyBudgets | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: MonthlyBudgets = {};
  for (const [key, val] of Object.entries(raw)) {
    if (!isValidMonthKey(key)) continue;
    if (val === null || typeof val !== "object" || Array.isArray(val)) continue;
    const categoryMap: Record<string, number> = {};
    for (const [cat, amount] of Object.entries(val)) {
      if (typeof cat !== "string") continue;
      const n = typeof amount === "number" && Number.isFinite(amount) ? amount : Number(amount);
      if (Number.isFinite(n)) categoryMap[cat] = n;
    }
    out[key] = categoryMap;
  }
  return out;
}

export async function GET() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    return NextResponse.json({});
  }
  try {
    const sql = neon(connectionString);
    const rows = await sql`SELECT data FROM budget_store WHERE id = 1`;
    const data = rows[0]?.data ?? {};
    return NextResponse.json(typeof data === "object" && data !== null ? data : {});
  } catch (err) {
    console.error("Budget GET error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load budget" },
      { status: 502 }
    );
  }
}

export async function PUT(request: NextRequest) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    return NextResponse.json(
      { error: "DATABASE_URL not configured" },
      { status: 503 }
    );
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const data = normalizeBody(body);
  if (data === null) {
    return NextResponse.json({ error: "Invalid budget data" }, { status: 400 });
  }
  try {
    const sql = neon(connectionString);
    const json = JSON.stringify(data);
    await sql`
      INSERT INTO budget_store (id, data)
      VALUES (1, ${json}::jsonb)
      ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data
    `;
    return NextResponse.json(data);
  } catch (err) {
    console.error("Budget PUT error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to save budget" },
      { status: 502 }
    );
  }
}
