import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type AnchorRow = {
  account_name: string;
  confirmed_balance: string | number;
  as_of_date: string;
};

export async function GET() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    return NextResponse.json({ anchors: [] as Array<{
      accountName: string;
      confirmedBalance: number;
      asOfDate: string;
    }> });
  }

  try {
    const sql = neon(connectionString);
    const rows = (await sql`
      SELECT account_name, confirmed_balance, as_of_date
      FROM account_anchors
      ORDER BY as_of_date DESC
    `) as AnchorRow[];
    return NextResponse.json({
      anchors: rows.map((row) => ({
        accountName: row.account_name,
        confirmedBalance: Number(row.confirmed_balance ?? 0),
        asOfDate: row.as_of_date,
      })),
    });
  } catch (err) {
    console.error("Account anchors GET error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to fetch account anchors" },
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

  const accountName = typeof (body as { accountName?: unknown })?.accountName === "string"
    ? (body as { accountName: string }).accountName.trim()
    : "";
  const confirmedBalance = Number((body as { confirmedBalance?: unknown })?.confirmedBalance);
  const asOfDate = typeof (body as { asOfDate?: unknown })?.asOfDate === "string"
    ? (body as { asOfDate: string }).asOfDate.trim()
    : "";

  if (!accountName) {
    return NextResponse.json({ error: "accountName is required" }, { status: 400 });
  }
  if (!Number.isFinite(confirmedBalance)) {
    return NextResponse.json({ error: "confirmedBalance must be numeric" }, { status: 400 });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) {
    return NextResponse.json({ error: "asOfDate must be YYYY-MM-DD" }, { status: 400 });
  }

  try {
    const sql = neon(connectionString);
    await sql`
      INSERT INTO account_anchors (account_name, confirmed_balance, as_of_date)
      VALUES (${accountName}, ${confirmedBalance}, ${asOfDate})
      ON CONFLICT (account_name) DO UPDATE
      SET confirmed_balance = EXCLUDED.confirmed_balance,
          as_of_date = EXCLUDED.as_of_date
    `;
    return NextResponse.json({
      success: true,
      anchor: {
        accountName,
        confirmedBalance,
        asOfDate,
      },
    });
  } catch (err) {
    console.error("Account anchors POST error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to save account anchor" },
      { status: 502 },
    );
  }
}
