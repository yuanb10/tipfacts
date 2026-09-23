/**
 * tip-math — tiny helpers for the /submit manual track.
 *
 * inferTaxBase guesses whether a tip was computed on the pre-tax subtotal or
 * the post-tax total: compute the tip percentage against both bases and pick
 * whichever lands closest to a whole or half percent (real presets are round
 * numbers like 15 / 18 / 20 / 22.5). A tie within 0.1 percentage points — or
 * any invalid input — returns 'unknown' so the user picks explicitly.
 */

export type TaxBaseGuess = 'pre-tax' | 'post-tax' | 'unknown';

/** Distance of a percentage from the nearest whole or half percent. */
function roundness(pct: number): number {
  const dWhole = Math.abs(pct - Math.round(pct));
  const dHalf = Math.abs(pct - Math.round(pct * 2) / 2);
  return Math.min(dWhole, dHalf);
}

export function inferTaxBase(
  subtotal: number | null,
  tax: number | null,
  tip: number | null,
): TaxBaseGuess {
  for (const v of [subtotal, tax, tip]) {
    if (v == null || !Number.isFinite(v)) return 'unknown';
  }
  const st = subtotal as number;
  const tx = tax as number;
  const tp = tip as number;
  if (st <= 0 || tx < 0 || tp < 0) return 'unknown';

  const prePct = (tp / st) * 100;
  const postPct = (tp / (st + tx)) * 100;
  const dPre = roundness(prePct);
  const dPost = roundness(postPct);
  if (Math.abs(dPre - dPost) <= 0.1) return 'unknown';
  return dPre < dPost ? 'pre-tax' : 'post-tax';
}

/** tip as a percentage of `base` (e.g. tip=8.5, base=42.5 → 20). Null when uncomputable. */
export function tipPercentOf(tip: number | null, base: number | null): number | null {
  if (tip == null || base == null) return null;
  if (!Number.isFinite(tip) || !Number.isFinite(base) || base <= 0 || tip < 0) return null;
  return (tip / base) * 100;
}

/** Format a percentage for display: 20 → "20.0%", 18.75 → "18.8%". */
export function fmtPct(pct: number): string {
  return `${pct.toFixed(1)}%`;
}
