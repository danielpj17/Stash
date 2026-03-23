import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    return NextResponse.json({ hashes: [] as string[] });
  }

  try {
    const sql = neon(connectionString);
    const rows = (await sql`
      SELECT hash
      FROM processed_transactions
      ORDER BY processed_at DESC
    `) as { hash: string }[];
    return NextResponse.json({ hashes: rows.map((r) => r.hash) });
  } catch (err) {
    console.error("Processed transactions GET error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to fetch processed hashes" },
      { status: 502 },
    );
  }
}

export async function POST(request: NextRequest) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    return NextResponse.json(
      { error: "DATABASE_URL not configured" },
      { status: 503 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const hash = typeof (body as { hash?: unknown })?.hash === "string"
    ? (body as { hash: string }).hash.trim()
    : "";
  const accountName = typeof (body as { accountName?: unknown })?.accountName === "string"
    ? (body as { accountName: string }).accountName.trim()
    : "";

  if (!hash) {
    return NextResponse.json({ error: "hash is required" }, { status: 400 });
  }

  try {
    const sql = neon(connectionString);
    await sql`
      INSERT INTO processed_transactions (hash, account_name)
      VALUES (${hash}, ${accountName || null})
      ON CONFLICT (hash) DO UPDATE SET account_name = EXCLUDED.account_name
    `;
    return NextResponse.json({ success: true, hash });
  } catch (err) {
    console.error("Processed transactions POST error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to save processed hash" },
      { status: 502 },
    );
  }
}
