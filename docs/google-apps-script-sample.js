/**
 * Google Apps Script sample for the Financial Dashboard Web App backend.
 *
 * SETUP:
 * 1. Create a Google Sheet with headers in row 1: Timestamp | Expense Type | Amount | Description | Month
 * 2. Copy the Sheet ID from the URL: https://docs.google.com/spreadsheets/d/THIS_PART_IS_THE_SHEET_ID/edit
 * 3. Extensions > Apps Script, paste this code. Replace SPREADSHEET_ID below with your Sheet ID.
 * 4. Deploy > New deployment > Web app > Execute as: Me, Who has access: Anyone. Copy the /exec URL.
 * 5. Put that URL in .env.local as NEXT_PUBLIC_GOOGLE_APPS_SCRIPT_URL.
 *
 * When the Web App runs from a URL (not from the sheet), there is no "active" spreadsheet, so we must
 * open the sheet by ID. getActiveSpreadsheet() returns null and causes "Cannot read properties of null".
 */

const SPREADSHEET_ID = "YOUR_SHEET_ID_HERE"; // from the sheet URL: .../d/YOUR_SHEET_ID_HERE/edit
const SHEET_NAME = "Sheet1"; // tab name; change if you renamed it

function getSheet() {
  return SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SHEET_NAME);
}

function doGet(e) {
  const sheet = getSheet();
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const monthParam = e?.parameter?.month;

  let rows = [];
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (row.every(function (c) { return c === "" || c === null; })) continue;
    const obj = {};
    headers.forEach(function (h, j) {
      obj[h] = row[j];
    });
    if (monthParam && monthParam !== "full") {
      const rowMonth = String(obj["Month"] ?? "").trim();
      if (rowMonth !== monthParam) continue;
    }
    rows.push(obj);
  }

  return ContentService.createTextOutput(JSON.stringify(rows))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  const sheet = getSheet();
  const payload = JSON.parse(e.postData?.contents || "{}");
  const timestamp = new Date();
  const expenseType = payload.expenseType || "";
  const amount = Number(payload.amount) || 0;
  const description = payload.description || "";
  const month = payload.month || "";

  sheet.appendRow([timestamp, expenseType, amount, description, month]);

  return ContentService.createTextOutput(JSON.stringify({ success: true }))
    .setMimeType(ContentService.MimeType.JSON);
}
