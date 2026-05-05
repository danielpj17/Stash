/**
 * Browser-safe fingerprint generator for the merchant memory feature.
 * Lives outside services/reconciliationService.ts because that module
 * imports node:crypto, which webpack cannot bundle for the client.
 */
export function generateMerchantFingerprint(
  description: string,
  amount: number,
): string {
  let normalized = String(description ?? "").toLowerCase();
  // Strip embedded dates (YYYY-MM-DD, MM/DD, MM/DD/YYYY)
  normalized = normalized.replace(/\d{4}[-/]\d{1,2}[-/]\d{1,2}/g, " ");
  normalized = normalized.replace(/\d{1,2}[-/]\d{1,2}(?:[-/]\d{2,4})?/g, " ");
  // Strip long digit runs (transaction IDs, card last-4 chains, ATM codes)
  normalized = normalized.replace(/\d{5,}/g, " ");
  // Strip standalone short tokens that look like reference codes
  normalized = normalized.replace(/\b(ref|id|txn|auth|seq)#?\s*\w+\b/g, " ");
  // Collapse whitespace and trim
  normalized = normalized.replace(/[^a-z0-9 ]+/g, " ");
  normalized = normalized.replace(/\s+/g, " ").trim();

  const dollarBucket = Math.round(Math.abs(Number(amount) || 0));
  return `${dollarBucket}|${normalized}`;
}
