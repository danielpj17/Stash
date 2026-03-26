/**
 * Google Apps Script for the Stash Web App backend.
 *
 * Supports two tabs in the same spreadsheet:
 * - "Expenses" — expenses/income (Timestamp, Expense Type, Amount, Description, Month, Row ID)
 * - "Transfers" — transfers (Timestamp, Transfer from, Transfer To, Transfer Amount, Month via sheet formula, Transfer Row ID)
 *
 * When the Stash app calls this Web App by URL, open by SPREADSHEET_ID. Replace the ID below
 * with the value from your sheet URL: .../d/THIS_PART_IS_THE_ID/edit
 */

const SPREADSHEET_ID = "YOUR_SPREADSHEET_ID_HERE";
const EXPENSE_SHEET_NAME = "Expenses";
const TRANSFERS_SHEET_NAME = "Transfers";

function getSheet(name) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  return ss.getSheetByName(name);
}

function appendByHeaders(sheet, valuesByHeader) {
  const lastCol = Math.max(sheet.getLastColumn(), 1);
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const row = headers.map((header) => valuesByHeader[header] != null ? valuesByHeader[header] : "");
  sheet.appendRow(row);
}

function parseNumber(value) {
  const raw = String(value == null ? "" : value).replace(/[$,]/g, "").trim();
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function firstNonEmpty(obj, keys, fallback) {
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
    const value = obj[key];
    if (value == null) continue;
    const s = String(value).trim();
    if (s) return value;
  }
  return fallback;
}

function getIncomingBody(e) {
  const params = (e && e.parameter) ? e.parameter : {};
  let jsonBody = {};

  const raw = e && e.postData && typeof e.postData.contents === "string"
    ? e.postData.contents.trim()
    : "";
  if (raw) {
    try {
      jsonBody = JSON.parse(raw);
    } catch (_) {
      // Not JSON (often form-encoded from mobile shortcuts); params fallback below.
    }
  }

  const merged = Object.assign({}, params, jsonBody);

  return {
    sheet: String(firstNonEmpty(merged, ["sheet", "Sheet"], EXPENSE_SHEET_NAME)),
    expenseType: String(firstNonEmpty(merged, ["expenseType", "Expense Type", "expense_type", "type"], "")),
    amount: parseNumber(firstNonEmpty(merged, ["amount", "Amount", "transferAmount", "Transfer Amount"], "")),
    description: String(firstNonEmpty(merged, ["description", "Description", "notes", "note"], "")),
    transferFrom: String(firstNonEmpty(merged, ["transferFrom", "Transfer from", "Transfer From"], "")),
    transferTo: String(firstNonEmpty(merged, ["transferTo", "Transfer To"], "")),
  };
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
    if (!obj["Row ID"] && sheetName === EXPENSE_SHEET_NAME) {
      obj["Row ID"] = "";
    }
    if (!obj["Transfer Row ID"] && sheetName === TRANSFERS_SHEET_NAME) {
      obj["Transfer Row ID"] = "";
    }
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
    const body = getIncomingBody(e);
    const sheetName = body.sheet || EXPENSE_SHEET_NAME;
    const sheet = getSheet(sheetName);
    if (!sheet) {
      return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "Sheet not found: " + sheetName }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    const timestamp = new Date();
    const rowId = Utilities.getUuid();
    const transferRowId = Utilities.getUuid();

    if (sheetName === TRANSFERS_SHEET_NAME) {
      if (!Number.isFinite(body.amount) || body.amount <= 0) {
        return ContentService.createTextOutput(
          JSON.stringify({ status: "error", message: "Transfer amount must be a positive number." })
        ).setMimeType(ContentService.MimeType.JSON);
      }
      appendByHeaders(sheet, {
        "Timestamp": timestamp,
        "Transfer from": body.transferFrom || "",
        "Transfer From": body.transferFrom || "",
        "Transfer To": body.transferTo || "",
        "Transfer Amount": body.amount,
        "Transfer Row ID": transferRowId,
      });
    } else {
      // Expenses: Timestamp, Expense Type, Amount, Description, Row ID
      if (!body.expenseType) {
        return ContentService.createTextOutput(
          JSON.stringify({ status: "error", message: "Expense Type is required." })
        ).setMimeType(ContentService.MimeType.JSON);
      }
      if (!Number.isFinite(body.amount) || body.amount <= 0) {
        return ContentService.createTextOutput(
          JSON.stringify({ status: "error", message: "Amount must be a positive number." })
        ).setMimeType(ContentService.MimeType.JSON);
      }
      appendByHeaders(sheet, {
        "Timestamp": timestamp,
        "Expense Type": body.expenseType || "",
        "Amount": body.amount,
        "Description": body.description || "",
        "Row ID": rowId,
      });
    }

    return ContentService.createTextOutput(JSON.stringify({ status: "success" }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ status: "error", message: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
