import { NextRequest, NextResponse } from "next/server";

const BASE_URL = process.env.NEXT_PUBLIC_GOOGLE_APPS_SCRIPT_URL ?? "";

/** Use redirect: 'manual' so we don't follow Google's redirect to the login page (which returns HTML). */
const FETCH_OPTS: RequestInit = { cache: "no-store", redirect: "manual" };

/** If Google returns an HTML error page (e.g. Access Denied), return a clear message instead of raw HTML. */
function cleanErrorResponse(text: string, status: number): string {
  if (typeof text !== "string") return "Request failed";
  const isHtml = text.trimStart().toLowerCase().startsWith("<!doctype") || text.includes("</html>");
  if (isHtml && (text.includes("Access Denied") || text.includes("You need access"))) {
    return "Google Apps Script returned 'Access Denied'. Use the URL from Deploy > Manage deployments (the Web app row, not Test deployments). It must end in /exec. Create a new deployment (Deploy > New deployment > Web app > Anyone) and paste the new URL into .env.local.";
  }
  if (isHtml) return "Google Apps Script returned an unexpected page. Use the deployment URL that ends in /exec from Deploy > Manage deployments.";
  if (text.length > 200) return text.slice(0, 200) + "...";
  return text || `Request failed (${status})`;
}

function isRedirect(status: number) {
  return status >= 300 && status < 400;
}

export async function GET(request: NextRequest) {
  if (!BASE_URL) {
    return NextResponse.json([], { status: 200 });
  }
  const { searchParams } = new URL(request.url);
  const month = searchParams.get("month");
  const sheet = searchParams.get("sheet");
  const params = new URLSearchParams();
  if (month) params.set("month", month);
  if (sheet) params.set("sheet", sheet);
  const qs = params.toString();
  const url = qs ? `${BASE_URL}?${qs}` : BASE_URL;
  try {
    // GET: follow redirects so that if Google does an internal redirect we still get JSON
    const res = await fetch(url, { cache: "no-store", redirect: "follow" });
    const text = await res.text();
    if (!res.ok) {
      return NextResponse.json(
        { error: cleanErrorResponse(text, res.status) },
        { status: res.status }
      );
    }
    try {
      const data = JSON.parse(text);
      return NextResponse.json(Array.isArray(data) ? data : data.rows ?? data.data ?? []);
    } catch {
      return NextResponse.json(
        { error: cleanErrorResponse(text, res.status) },
        { status: 502 }
      );
    }
  } catch (err) {
    console.error("Sheets GET error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to fetch" },
      { status: 502 }
    );
  }
}

export async function POST(request: NextRequest) {
  if (!BASE_URL) {
    return NextResponse.json(
      { error: "Google Apps Script URL not configured" },
      { status: 503 }
    );
  }
  if (BASE_URL.includes("/dev")) {
    return NextResponse.json(
      {
        error:
          "Use a Web app deployment URL ending in /exec, not the Test deployment URL (/dev). Deploy > New deployment > Web app > Anyone, then copy that URL to .env.local.",
      },
      { status: 400 }
    );
  }

  try {
    const body = await request.json();
    // Follow redirects (same as GET) so we get the actual response after Google's redirect
    const res = await fetch(BASE_URL, {
      cache: "no-store",
      redirect: "follow",
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      return NextResponse.json(
        { error: cleanErrorResponse(text, res.status) },
        { status: res.status }
      );
    }
    const isHtml = text.trimStart().toLowerCase().startsWith("<!doctype") || text.includes("</html>");
    if (isHtml) {
      return NextResponse.json(
        { error: cleanErrorResponse(text, res.status) },
        { status: 502 }
      );
    }
    try {
      return NextResponse.json(text ? JSON.parse(text) : { success: true });
    } catch {
      return NextResponse.json(
        { error: cleanErrorResponse(text, res.status) },
        { status: 502 }
      );
    }
  } catch (err) {
    console.error("Sheets POST error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to submit" },
      { status: 502 }
    );
  }
}
