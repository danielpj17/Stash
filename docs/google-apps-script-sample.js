/**
 * Google Apps Script for the Stash Web App backend.
 *
 * Supports two tabs in the same spreadsheet:
 * - "Expense Form" — expenses/income (Timestamp, Expense Type, Amount, Description, Month)
 * - "Transfers" — transfers (Timestamp, Transfer from, Transfer Amount, Transfer Description, Month)
 *
 * When the Stash app calls this Web App by URL, there is no "active" spreadsheet,
 * so we open by SPREADSHEET_ID. Replace YOUR_SPREADSHEET_ID_HERE with the ID from your sheet URL:
 * https://docs.google.com/spreadsheets/d/THIS_PART_IS_THE_ID/edit
 */

const SPREADSHEET_ID = "YOUR_SPREADSHEET_ID_HERE";
const EXPENSE_SHEET_NAME = "Expense Form";
const TRANSFERS_SHEET_NAME = "Transfers";

function getSheet(name) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  return ss.getSheetByName(name);
}

function doGet(e) {
  const sheetName = (e && e.parameter && e.parameter.sheet) || EXPENSE_SHEET_NAME;
  const sheet = getSheet(sheetName);
  if (!sheet) {
    return ContentService.createTextOutput(JSON.stringify({ error: "Sheet not found: " + sheetName }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const monthParam = (e && e.parameter) ? e.parameter.month : undefined;

  const rows = [];
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (row.every(c => c === "" || c === null)) continue;
    const obj = {};
    headers.forEach((header, j) => {
      obj[header] = row[j];
    });
    if (monthParam && monthParam !== "full") {
      const rowMonth = String((obj["Month"] != null ? obj["Month"] : "")).trim();
      if (rowMonth !== monthParam) continue;
    }
    rows.push(obj);
  }

  return ContentService.createTextOutput(JSON.stringify(rows))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const sheetName = body.sheet || EXPENSE_SHEET_NAME;
    const sheet = getSheet(sheetName);
    if (!sheet) {
      return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "Sheet not found: " + sheetName }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    const timestamp = new Date();

    if (sheetName === TRANSFERS_SHEET_NAME) {
      sheet.appendRow([
        timestamp,
        body.transferFrom || "",
        Number(body.amount) || 0,
        body.description || ""
      ]);
    } else {
      // Expense Form: Timestamp, Expense Type, Amount, Description (Month = formula on sheet)
      sheet.appendRow([
        timestamp,
        body.expenseType || "",
        Number(body.amount) || 0,
        body.description || ""
      ]);
    }

    return ContentService.createTextOutput(JSON.stringify({ status: "success" }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ status: "error", message: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
