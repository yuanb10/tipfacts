/**
 * PII detection, redaction rendering, and value extraction for TipFacts (Sprint 1).
 *
 * Detection philosophy: OVER-REDACT by default. A receipt that ships with a
 * card number visible is a privacy failure; a receipt with a few extra black
 * boxes is a cosmetic cost. When in doubt, mask it.
 *
 * LIMITATION (barcodes/QR codes): tesseract's TSV has no barcode geometry,
 * so barcodes and QR codes cannot be detected by OCR. If a photo contains a
 * barcode (common on receipts as a loyalty/transaction code), it must be
 * caught by the user's manual review step — the confirm UI should always let
 * the uploader attest or add boxes. We do not pretend to cover this case.
 */

import sharp from 'sharp';
import type { OcrWord } from './ocr';
import { groupWordsIntoLines } from './ocr.ts';
import type { ReceiptParsed } from '@/lib/storage';

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  reason: string;
}

/** Keywords whose neighboring token is almost certainly sensitive. */
const PII_KEYWORDS =
  /^(card|visa|mastercard|mc|amex|discover|auth|approval|acct|account|account#|card#|acct#|exp|expiry|expires|cvv|cvc|pin|signature|member|loyalty|rewards|ref|reference|invoice|order|trans|transaction|seq|check|server|clerk|cashier|terminal|tid|mid|batch|stan)$/i;

const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

// Card-brand words: when one of these appears, EVERY digit group that follows
// on the same visual line is treated as part of the card number (spaced
// "4111 1111 1111 1111" is the common case — masking only the first group
// would leak the rest).
const CARD_KEYWORDS = /^(card|visa|mastercard|mc|amex|discover)$/i;

// North-American style phone numbers; keep it narrow to avoid nuking prices.
const PHONE_RE =
  /^(?:\+?1[-.\s]?)?(?:\(\d{3}\)|\d{3})[-.\s]?\d{3}[-.\s]?\d{4}$/;

const DIGITS_ONLY = /^\d+$/;
const DIGIT_RUN = /\d[\d\s-]{10,21}\d/; // 12-19 digits with separators

const PADDING = 6;

function clampBox(b: Box, w: number, h: number): Box {
  return {
    x0: Math.max(0, Math.floor(b.x0 - PADDING)),
    y0: Math.max(0, Math.floor(b.y0 - PADDING)),
    x1: Math.min(w, Math.ceil(b.x1 + PADDING)),
    y1: Math.min(h, Math.ceil(b.y1 + PADDING)),
    reason: b.reason,
  };
}

function boxOf(w: OcrWord, reason: string): Box {
  return { x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1, reason };
}

/**
 * Regex-detect PII word boxes. Over-redacts: card-number-like runs (12-19
 * digits with optional spaces/dashes), any all-digit token with 6+ chars,
 * phone numbers, emails, and words adjacent to PII keywords
 * (CARD/VISA/MC/AUTH/APPROVAL/ACCT/ACCOUNT/…). Boxes are padded ~6px,
 * clamped to image bounds (needs width/height of the image).
 */
export function findPiiBoxes(words: OcrWord[], imageWidth: number, imageHeight: number): Box[] {
  const boxes: Box[] = [];
  const masked = new Set<number>(); // word indexes already masked

  const push = (idx: number, reason: string) => {
    if (idx < 0 || idx >= words.length || masked.has(idx)) return;
    masked.add(idx);
    boxes.push(clampBox(boxOf(words[idx], reason), imageWidth, imageHeight));
  };

  // Group words by VISUAL line (y-clustering). Tesseract's line_num is
  // unreliable (it repeats per paragraph), so adjacency must be geometric.
  const lines = groupWordsIntoLines(words);
  const wordIndex = new Map<OcrWord, number>();
  words.forEach((w, i) => wordIndex.set(w, i));
  const lineOf = new Map<number, OcrWord[]>();
  words.forEach((w, i) => {
    for (const line of lines) {
      if (line.includes(w)) {
        lineOf.set(i, line);
        break;
      }
    }
  });

  words.forEach((w, i) => {
    const t = w.text;

    // 12-19 digit card-number-like run (spaces/dashes inside one token).
    if (DIGIT_RUN.test(t.replace(/[^\d\s-]/g, ''))) {
      push(i, 'card-number-like');
      return;
    }
    // Any all-digit token with 6+ chars: auth codes, account numbers, phones.
    const digits = t.replace(/\D/g, '');
    if (DIGITS_ONLY.test(digits) && digits.length >= 6) {
      // Exclude obvious money? We over-redact, so no exclusion — but a bare
      // 6+ digit number on a receipt is never a price, so this is safe.
      push(i, 'long-digit-run');
      return;
    }
    if (EMAIL_RE.test(t)) {
      push(i, 'email');
      return;
    }
    if (PHONE_RE.test(t)) {
      push(i, 'phone');
      return;
    }
    // Keyword adjacency: mask the neighboring token(s) on the same line.
    if (PII_KEYWORDS.test(t.replace(/[:#]/g, ''))) {
      const line = lineOf.get(i) ?? [];
      const pos = line.indexOf(w);
      if (CARD_KEYWORDS.test(t.replace(/[:#]/g, ''))) {
        // Card brand/keyword: mask ALL digit groups after it on this line.
        for (let k = pos + 1; k < line.length; k++) {
          const u = line[k];
          if (/^[\d\s-]+$/.test(u.text) && /\d/.test(u.text)) {
            push(wordIndex.get(u) ?? -1, `card-number-after-${t.toLowerCase()}`);
          } else if (k > pos + 1) {
            break; // stop at the first non-digit token after the groups
          }
        }
      } else {
        const next = pos >= 0 && pos + 1 < line.length ? line[pos + 1] : null;
        if (next) push(wordIndex.get(next) ?? -1, `adjacent-to-${t.toLowerCase()}`);
      }
      return;
    }
  });

  // Spaced card numbers: runs of 3+ consecutive digit-only words (3-5 digits
  // each, 12+ digits total) on one visual line, e.g. "4111 1111 1111 1111".
  for (const line of lines) {
    let run: OcrWord[] = [];
    const flush = () => {
      const totalDigits = run.reduce((s, x) => s + x.text.replace(/\D/g, '').length, 0);
      if (run.length >= 3 && totalDigits >= 12) {
        for (const x of run) push(wordIndex.get(x) ?? -1, 'spaced-card-number');
      }
      run = [];
    };
    for (const x of line) {
      const d = x.text.replace(/\D/g, '');
      if (/^\d+$/.test(x.text) && d.length >= 3 && d.length <= 5) {
        run.push(x);
      } else {
        flush();
      }
    }
    flush();
  }

  return boxes;
}

// ---------------------------------------------------------------- parsing

const MONEY = /\$?\s*(\d{1,3}(?:,\d{3})*(?:\.\d{2})|\d+\.\d{2})/;

function parseMoney(s: string): number | null {
  const m = s.match(MONEY);
  if (!m) return null;
  const v = parseFloat(m[1].replace(/,/g, ''));
  return Number.isFinite(v) ? v : null;
}

function lineHas(line: string, re: RegExp): boolean {
  return re.test(line);
}

function linesFromWords(words: OcrWord[]): string[] {
  // Visual lines via y-clustering (tesseract's line_num is unreliable).
  return groupWordsIntoLines(words).map((ws) => ws.map((w) => w.text).join(' '));
}

function findMoneyLine(lines: string[], re: RegExp): number | null {
  // Prefer lines where the keyword appears; take the LAST money match on the
  // line (amounts usually sit at the end).
  for (const line of lines) {
    if (!lineHas(line, re)) continue;
    const matches = [...line.matchAll(new RegExp(MONEY.source, 'g'))];
    if (matches.length) {
      const v = parseFloat(matches[matches.length - 1][1].replace(/,/g, ''));
      if (Number.isFinite(v)) return v;
    }
  }
  return null;
}

/**
 * Best-effort merchant guess: the venue name usually sits at the very top of
 * a receipt. Conservative by design — returns null rather than a dubious
 * guess. The result is only ever a *proposal*: the submit flow fuzzy-matches
 * it against known venues and asks the uploader to confirm.
 *
 * Known limitation: receipts that print the *customer* name first (e.g.
 * "Order for Bo") can be misread as the merchant. The confirmation step is
 * the backstop.
 */
export function guessMerchant(lines: string[]): string | null {
  const SKIP = /\b(receipt|invoice|order\s*(#|number|no\.?)?|guest\s*check|table|server|cashier|clerk|transaction|auth(orization)?|balance|change|subtotal|total|tax|tip|gratuity|payment|paid|thank you|thanks|welcome)\b/i;
  for (const raw of lines.slice(0, 6)) {
    const line = raw.trim();
    if (line.length < 2 || line.length > 60) continue;
    if (!/[a-zA-Z]/.test(line)) continue; // must contain letters
    if (/\d{3}[-.\s]?\d{3}[-.\s]?\d{4}/.test(line)) continue; // phone number
    if (/https?:|www\.|\.(com|net|org|io)\b/i.test(line)) continue; // URL
    if (/\$\s*\d/.test(line) || /\d+\s*\.\s*\d{2}/.test(line)) continue; // money line
    if (SKIP.test(line)) continue;
    if (/\border\s+for\b|\bcustomer\b|\bguest\b/i.test(line)) continue; // customer name, not venue
    const cleaned = line.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, '').trim();
    if (cleaned.length >= 2) return cleaned.slice(0, 60);
  }
  return null;
}

/**
 * Pull structured values out of OCR words. Line-based regexes; every field
 * is null when not found — never guessed (merchant is a *proposal*, see
 * guessMerchant, and is always confirmed by the uploader).
 */
export function extractParsedValues(words: OcrWord[], rawText: string): ReceiptParsed {
  const lines = linesFromWords(words);

  const subtotal = findMoneyLine(lines, /\bsub[\s-]?total\b/i);
  const tax = findMoneyLine(lines, /\b(tax|taxes|sales tax|gst|hst|vat)\b/i);
  const tip = findMoneyLine(lines, /\b(tip|gratuity|tips)\b/i);
  const total = findMoneyLine(lines, /\b(total|balance|amount due|grand total)\b/i);

  const fees: { label: string; amount: number | null }[] = [];
  for (const line of lines) {
    if (/\b(fee|fees|surcharge|service charge|service fee|convenience fee|card fee)\b/i.test(line)) {
      const amount = parseMoney(line);
      fees.push({ label: line.trim().slice(0, 80), amount });
    }
  }

  // Tip presets: standalone percentages like "20%", "18% 20% 25%".
  const presets: number[] = [];
  for (const m of rawText.matchAll(/(\d{1,3})\s*%/g)) {
    const v = parseInt(m[1], 10);
    if (v >= 1 && v <= 100 && !presets.includes(v)) presets.push(v);
  }
  presets.sort((a, b) => a - b);

  // "Tip 20%" or "20% tip" phrasing → reported percent.
  let tipPercentReported: number | null = null;
  for (const line of lines) {
    const m = line.match(/\btip\b[^%\d]*(\d{1,3})\s*%|(\d{1,3})\s*%\s*\btip\b/i);
    if (m) {
      const v = parseInt(m[1] ?? m[2], 10);
      if (v >= 1 && v <= 100) {
        tipPercentReported = v;
        break;
      }
    }
  }

  return {
    merchant: guessMerchant(lines),
    purchasedAt: null,
    subtotal,
    tax,
    tip,
    total,
    fees,
    presets,
    tipPercentReported,
    rawText: rawText || null,
    ocrEngine: 'tesseract',
    ocrConfidence: null, // filled by the caller from OcrResult.meanConfidence
  };
}

// ---------------------------------------------------------------- rendering

/**
 * Composite solid black rectangles over the given boxes and write a PNG.
 * Boxes are expected pre-clamped; this is the final redacted public copy.
 */
export async function renderRedacted(
  originalPath: string,
  boxes: Box[],
  outPath: string,
): Promise<void> {
  const image = sharp(originalPath);
  const meta = await image.metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  if (!w || !h) throw new Error('Could not read image dimensions: ' + originalPath);

  const overlays = boxes
    .filter((b) => b.x1 > b.x0 && b.y1 > b.y0)
    .map((b) => {
      const bw = Math.round(b.x1 - b.x0);
      const bh = Math.round(b.y1 - b.y0);
      return {
        input: {
          create: {
            width: bw,
            height: bh,
            channels: 4 as const,
            background: { r: 0, g: 0, b: 0, alpha: 1 },
          },
        },
        left: Math.round(Math.max(0, Math.min(b.x0, w - bw))),
        top: Math.round(Math.max(0, Math.min(b.y0, h - bh))),
      };
    });

  await image.composite(overlays).png().toFile(outPath);
}
