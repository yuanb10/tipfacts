/**
 * lib/vlm-extract.ts
 *
 * Prompt + hand-rolled schema validation for the VLM receipt-extraction
 * route (POST /api/receipt/extract).
 *
 * PRIVACY (TipFacts PRD v0.3, decision 14): the vision model may extract
 * receipt facts ONLY from the already-redacted image(s) — it can never see
 * PII the user blacked out. Extracted values are always user-confirmed
 * before publish; the score is computed from confirmed values only. Nothing
 * in this module persists or logs the image.
 *
 * GENERALIZATION (v2, 2026-09-22): the contract is format-, language- and
 * currency-agnostic. The model does the understanding — no per-venue or
 * per-format parsing templates. Anything the model cannot determine with
 * confidence comes back as null, and the human confirmation step resolves
 * the rest ("machine proposes, human disposes").
 */

export interface ExtractionFee {
  label: string;
  amount: number;
}

export type TaxBase = 'pre' | 'post' | 'unknown';
export type Confidence = 'low' | 'medium' | 'high';

export interface Extraction {
  venue: string | null;
  /** ISO 4217 currency code (USD, EUR, CNY, ...), or null when unclear. */
  currency: string | null;
  subtotal: number | null;
  tax: number | null;
  presets: number[] | null;
  tip: number | null;
  fees: ExtractionFee[] | null;
  paidTotal: number | null;
  tipPercentage: number | null;
  taxBase: TaxBase;
  /** One short line flagging ambiguity for the human reviewer, or null. */
  notes: string | null;
  confidence: Confidence;
}

/**
 * Prompt sent alongside the redacted image(s). Kept short; temperature is
 * set low (0.2) at the call site.
 */
export const EXTRACTION_PROMPT = `You are extracting facts from receipt images. The images show an ALREADY-REDACTED receipt: private information is covered by solid black boxes. Do NOT attempt to read, guess, or reconstruct anything under the black boxes.

The receipt may be any format: a paper receipt photo, a digital receipt, a screenshot, a multi-page receipt, or several slips (e.g. an itemized bill plus a card slip). It may be in any language and any currency.

Extract the visible facts and return JSON ONLY (no markdown, no explanation) with exactly this shape, using null for anything unreadable or missing:

{
  "venue": string | null,
  "currency": string | null,
  "subtotal": number | null,
  "tax": number | null,
  "presets": number[] | null,
  "tip": number | null,
  "fees": [{ "label": string, "amount": number }] | null,
  "paidTotal": number | null,
  "tipPercentage": number | null,
  "taxBase": "pre" | "post" | "unknown",
  "notes": string | null,
  "confidence": "low" | "medium" | "high"
}

Rules:
- If several images or pages show the SAME receipt, combine them into one receipt. If they look like DIFFERENT receipts, use only the first.
- "venue" is the merchant name as printed, in its original language and script.
- "currency" is the 3-letter ISO code (USD, CAD, EUR, CNY, KRW, JPY, ...) inferred from currency symbols or context, or null if unclear.
- All money amounts are plain numbers in that currency (e.g. 12.50). Never put currency symbols inside numbers.
- "subtotal" is the pre-tax merchandise/food total before tip. If tax is already included in the listed prices (e.g. VAT-inclusive with no tax breakdown), set "tax" to null and say so in "notes".
- "tax" is the tax amount (sales tax, GST, VAT, ...). If several tax lines are shown, sum them.
- "presets" are suggested tip percentages PRINTED on the receipt (each 0-100), or null if none are shown. Do not confuse tip amounts in money with percentages.
- "tip" is the gratuity the customer added (labels like tip, gratuity, 小费, pourboire, propina). A "service charge" is NOT a tip — put it in "fees".
- "fees" are extra charges other than tax and tip: service charge, card surcharge, delivery fee, convenience fee, etc., each with its printed label and amount. Or null.
- "paidTotal" is the final amount charged or paid.
- "tipPercentage" is the tip expressed as a percentage. "taxBase" is "pre" if the tip was computed on the pre-tax subtotal, "post" if on the after-tax total. If the tax amount itself is unknown, "taxBase" MUST be "unknown" — a pre/post claim cannot be verified without the tax figure. Otherwise "unknown".
- "notes": one short line flagging anything ambiguous for a human reviewer (e.g. "handwritten tip", "two different totals, used the card slip", "VAT included in prices"), or null if nothing is ambiguous.
- Sanity check: subtotal + tax + tip + fees should approximately equal paidTotal. If it does not, say so in "notes" — do NOT adjust the numbers.
- Read handwritten tip/total lines when legible; otherwise use null.
- Never invent values; when in doubt, use null.`;

/** A money amount must be a finite number >= 0, else it is treated as unknown. */
function validMoney(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

function validVenue(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t : null;
}

/** ISO 4217-ish: exactly 3 uppercase ASCII letters. */
function validCurrency(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(t) ? t : null;
}

function validNotes(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim().slice(0, 280);
  return t ? t : null;
}

function validPresets(v: unknown): number[] | null {
  if (!Array.isArray(v)) return null;
  const out: number[] = [];
  for (const p of v) {
    if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 100) {
      return null; // one bad entry poisons the whole list — never guess
    }
    out.push(p);
  }
  return out.length > 0 ? out : null;
}

function validFees(v: unknown): ExtractionFee[] | null {
  if (!Array.isArray(v)) return null;
  const out: ExtractionFee[] = [];
  for (const f of v) {
    if (typeof f !== 'object' || f === null) continue;
    const rec = f as Record<string, unknown>;
    const label = typeof rec.label === 'string' ? rec.label.trim() : '';
    const amount = validMoney(rec.amount);
    if (!label || amount === null) continue; // drop malformed entries
    out.push({ label, amount });
  }
  return out.length > 0 ? out : null;
}

function validTaxBase(v: unknown, tax: number | null, subtotal: number | null): TaxBase {
  // A pre/post claim is unverifiable without both figures — the model's
  // guess is discarded, same philosophy as the server-side confidence.
  if (tax === null || subtotal === null) return 'unknown';
  return v === 'pre' || v === 'post' ? v : 'unknown';
}

/**
 * Strict hand-rolled validation of the model's raw JSON output.
 * Returns a normalized Extraction, or null when the top-level shape is
 * unusable (the route then surfaces a 503 → manual-track fallback).
 * Unknown/missing fields become null — values are never invented.
 */
export function validateExtraction(raw: unknown): Extraction | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;

  const subtotal = validMoney(r.subtotal);
  const tip = validMoney(r.tip);
  const tax = validMoney(r.tax);
  const paidTotal = validMoney(r.paidTotal);
  const fees = validFees(r.fees);

  // tipPercentage: trust the model only if it is a sane non-negative number;
  // otherwise derive it from tip/subtotal when both are known.
  let tipPercentage = validMoney(r.tipPercentage);
  if (tipPercentage === null && tip !== null && subtotal !== null && subtotal > 0) {
    tipPercentage = Math.round((tip / subtotal) * 100 * 10) / 10;
  }

  // Confidence is recomputed server-side from the actual money fields the
  // model produced — the model's own self-assessment is ignored.
  const hasSubtotalAndTip = subtotal !== null && tip !== null;
  const coreMoneyCount =
    [subtotal, tip, tax, paidTotal].filter((v) => v !== null).length +
    (fees !== null ? 1 : 0);
  const confidence: Confidence =
    hasSubtotalAndTip ? 'high' : coreMoneyCount > 0 ? 'medium' : 'low';

  return {
    venue: validVenue(r.venue),
    currency: validCurrency(r.currency),
    subtotal,
    tax,
    presets: validPresets(r.presets),
    tip,
    fees,
    paidTotal,
    tipPercentage,
    taxBase: validTaxBase(r.taxBase, tax, subtotal),
    notes: validNotes(r.notes),
    confidence,
  };
}
