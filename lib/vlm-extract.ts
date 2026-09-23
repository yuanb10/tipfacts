/**
 * lib/vlm-extract.ts
 *
 * Prompt + hand-rolled schema validation for the VLM receipt-extraction
 * route (POST /api/receipt/extract).
 *
 * PRIVACY (TipFacts PRD v0.3, decision 14): the vision model may extract
 * receipt facts ONLY from the already-redacted image — it can never see PII
 * the user blacked out. Extracted values are always user-confirmed before
 * publish; the score is computed from confirmed values only. Nothing in
 * this module persists or logs the image.
 */

export interface ExtractionFee {
  label: string;
  amount: number;
}

export type TaxBase = 'pre' | 'post' | 'unknown';
export type Confidence = 'low' | 'medium' | 'high';

export interface Extraction {
  venue: string | null;
  subtotal: number | null;
  tax: number | null;
  presets: number[] | null;
  tip: number | null;
  fees: ExtractionFee[] | null;
  paidTotal: number | null;
  tipPercentage: number | null;
  taxBase: TaxBase;
  confidence: Confidence;
}

/**
 * Prompt sent alongside the redacted image. Kept short; temperature is set
 * low (0.2) at the call site.
 */
export const EXTRACTION_PROMPT = `This is a photo of a paper receipt that has ALREADY been redacted: private information is covered by solid black boxes. Do NOT attempt to read, guess, or reconstruct anything under the black boxes.

Extract only the visible receipt facts and return JSON ONLY (no markdown, no explanation) with exactly this shape, using null for anything unreadable or missing:

{
  "venue": string | null,
  "subtotal": number | null,
  "tax": number | null,
  "presets": number[] | null,
  "tip": number | null,
  "fees": [{ "label": string, "amount": number }] | null,
  "paidTotal": number | null,
  "tipPercentage": number | null,
  "taxBase": "pre" | "post" | "unknown",
  "confidence": "low" | "medium" | "high"
}

Rules:
- Numbers are plain dollar amounts, e.g. 12.50.
- "presets" are the suggested tip percentages printed on the receipt (each 0-100), or null if none are shown.
- "fees" are extra charges such as a service charge or card surcharge, with their label and amount, or null.
- "taxBase" is "pre" if the tip appears computed on the pre-tax subtotal, "post" if on the after-tax total, otherwise "unknown".
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

function validTaxBase(v: unknown): TaxBase {
  return v === 'pre' || v === 'post' || v === 'unknown' ? v : 'unknown';
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
  const coreMoneyCount = [subtotal, tip, tax, paidTotal].filter((v) => v !== null).length + (fees !== null ? 1 : 0);
  const confidence: Confidence =
    hasSubtotalAndTip ? 'high' : coreMoneyCount > 0 ? 'medium' : 'low';

  return {
    venue: validVenue(r.venue),
    subtotal,
    tax,
    presets: validPresets(r.presets),
    tip,
    fees,
    paidTotal,
    tipPercentage,
    taxBase: validTaxBase(r.taxBase),
    confidence,
  };
}
