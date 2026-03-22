import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ManualItem = {
  id: string;
  name: string;
  value: number;
  category: string;
  updated_at?: string;
};

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function normalizeItem(raw: unknown): ManualItem | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const candidate = raw as Record<string, unknown>;
  const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
  const category = typeof candidate.category === "string" ? candidate.category.trim() : "";
  const value = toNumber(candidate.value);
  const providedId = typeof candidate.id === "string" ? candidate.id.trim() : "";

  if (!name || !category || value === null) return null;

  return {
    id: providedId || crypto.randomUUID(),
    name,
    value,
    category,
  };
}

function normalizeBody(raw: unknown): ManualItem[] | null {
  if (Array.isArray(raw)) {
    const items = raw.map(normalizeItem);
    if (items.some((item) => item === null)) return null;
    return items as ManualItem[];
  }
  const single = normalizeItem(raw);
  return single ? [single] : null;
}

export async function GET() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    return NextResponse.json([]);
  }

  try {
    const sql = neon(connectionString);
    const rows = await sql`
      SELECT id, name, value, category, updated_at
      FROM manual_liabilities
      ORDER BY updated_at DESC, name ASC
    `;

    const data = rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      value: Number(row.value),
      category: String(row.category),
      updated_at: String(row.updated_at),
    }));

    return NextResponse.json(data);
  } catch (err) {
    console.error("Liabilities GET error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load liabilities" },
      { status: 502 }
    );
  }
}

export async function POST(request: NextRequest) {
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

  const items = normalizeBody(body);
  if (!items || items.length === 0) {
    return NextResponse.json({ error: "Invalid liability data" }, { status: 400 });
  }

  try {
    const sql = neon(connectionString);
    const saved: ManualItem[] = [];
    for (const item of items) {
      const rows = await sql`
        INSERT INTO manual_liabilities (id, name, value, category)
        VALUES (${item.id}, ${item.name}, ${item.value}, ${item.category})
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          value = EXCLUDED.value,
          category = EXCLUDED.category,
          updated_at = now()
        RETURNING id, name, value, category, updated_at
      `;
      const row = rows[0];
      saved.push({
        id: String(row.id),
        name: String(row.name),
        value: Number(row.value),
        category: String(row.category),
        updated_at: String(row.updated_at),
      });
    }

    return NextResponse.json(Array.isArray(body) ? saved : saved[0]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Liabilities POST error:", err);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
