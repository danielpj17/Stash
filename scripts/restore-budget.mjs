// Restore budget_store from a JSON file into Neon.
// Usage: node scripts/restore-budget.mjs path/to/old-budget.json
// The JSON must be the MonthlyBudgets object, e.g. { "1": { "Rent": 1200, ... }, ... }
import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";

const file = process.argv[2];
if (!file) {
  console.error("Usage: node scripts/restore-budget.mjs <path-to-json>");
  process.exit(1);
}

const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const url = env.match(/DATABASE_URL=([^\r\n]+)/)?.[1]?.trim().replace(/^["']|["']$/g, "");
if (!url) {
  console.error("DATABASE_URL not found in .env.local");
  process.exit(1);
}

const data = JSON.parse(readFileSync(file, "utf8"));
const months = Object.keys(data).filter((k) => /^([1-9]|1[0-2])$/.test(k));
if (months.length === 0) {
  console.error("Refusing to restore: JSON has no valid month keys (1-12).");
  process.exit(1);
}
console.log(`Restoring ${months.length} month(s): ${months.join(", ")}`);

const sql = neon(url);
await sql`INSERT INTO budget_store (id, data) VALUES (1, ${data})
         ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`;
console.log("Done. Reload the budget page to confirm.");
