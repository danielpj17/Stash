import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type UploadedFileRow = {
  account_name: string;
  file_name: string;
  created_at: string;
};

async function ensureUploadedFilesTable(sql: any) {
  await sql`
    CREATE TABLE IF NOT EXISTS reconciliation_uploaded_files (
      account_name TEXT NOT NULL,
      file_name TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT now(),
      PRIMARY KEY (account_name, file_name)
    )
  `;
}

export async function GET() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    return NextResponse.json({ filesByAccount: {} as Record<string, string[]> });
  }

  try {
    const sql = neon(connectionString);
    await ensureUploadedFilesTable(sql);
    const rows = (await sql`
      SELECT account_name, file_name, created_at
      FROM reconciliation_uploaded_files
      ORDER BY created_at DESC
    `) as UploadedFileRow[];

    const filesByAccount: Record<string, string[]> = {};
    for (const row of rows) {
      const account = String(row.account_name ?? "").trim();
      const file = String(row.file_name ?? "").trim();
      if (!account || !file) continue;
      if (!filesByAccount[account]) filesByAccount[account] = [];
      if (!filesByAccount[account].includes(file)) {
        filesByAccount[account].push(file);
      }
    }

    return NextResponse.json({ filesByAccount });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to fetch uploaded files" },
      { status: 502 },
    );
  }
}

export async function POST(request: NextRequest) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    return NextResponse.json({ error: "DATABASE_URL not configured" }, { status: 503 });
  }

  let body: { accountName?: unknown; fileName?: unknown };
  try {
    body = (await request.json()) as { accountName?: unknown; fileName?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const accountName = typeof body.accountName === "string" ? body.accountName.trim() : "";
  const fileName = typeof body.fileName === "string" ? body.fileName.trim() : "";

  if (!accountName) {
    return NextResponse.json({ error: "accountName is required" }, { status: 400 });
  }
  if (!fileName) {
    return NextResponse.json({ error: "fileName is required" }, { status: 400 });
  }

  try {
    const sql = neon(connectionString);
    await ensureUploadedFilesTable(sql);
    await sql`
      INSERT INTO reconciliation_uploaded_files (account_name, file_name)
      VALUES (${accountName}, ${fileName})
      ON CONFLICT (account_name, file_name) DO NOTHING
    `;
    return NextResponse.json({ success: true, accountName, fileName });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to save uploaded file" },
      { status: 502 },
    );
  }
}
