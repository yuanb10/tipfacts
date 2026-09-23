import { NextRequest, NextResponse } from 'next/server';
import {
  EXTRACTION_PROMPT,
  validateExtraction,
  type Extraction,
} from '@/lib/vlm-extract';

/**
 * POST /api/receipt/extract
 *
 * VLM extraction track (TipFacts PRD v0.3, decision 14): extracts receipt
 * facts from ALREADY-REDACTED receipt photo(s). The original never leaves
 * the user's device; the server only ever receives the redacted image(s)
 * and must never persist them, write them to disk, or log them.
 *
 * Tier note (Bo, 2026-09-22): we start on the Gemini FREE tier (prompts may
 * be used for training — acceptable because only the already-redacted image
 * is sent). Switching to the paid tier later requires nothing more than
 * swapping in a paid-tier key in GEMINI_API_KEY — the code deliberately
 * avoids paid-tier-only features (no batch API, no context caching).
 *
 * Contract (built against by the /submit UI):
 * - Request: multipart/form-data, field `image` = redacted JPEG file
 *   (single), or `images` = up to 4 redacted image files (multi-slip:
 *   itemized bill + card slip, multi-page, ...). `image` is kept for
 *   backward compatibility.
 * - Success: 200 { ok: true, data: Extraction }
 * - Failure: 503 { ok: false, error: string, fallback: 'manual' } — the UI
 *   treats 503 as "fall back to the manual track".
 */

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // safety net; client compresses to ≤1600px side
const MAX_IMAGES = 4;

// Free-tier rate limits are strict: on 429 (or a transient 5xx) retry with
// backoff, then give up cleanly to the manual track. Bounded so a single
// submit stays interactive.
const MAX_RETRIES = 2;
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

interface FailureBody {
  ok: false;
  error: string;
  fallback: 'manual';
}

function fallback(error: string): NextResponse<FailureBody> {
  return NextResponse.json({ ok: false, error, fallback: 'manual' }, { status: 503 });
}

/** Backoff before a retry: honor Retry-After (capped), else exponential. */
function retryDelayMs(attempt: number, res: Response | null): number {
  if (res) {
    const ra = res.headers.get('retry-after');
    if (ra) {
      const secs = Number(ra);
      if (Number.isFinite(secs) && secs > 0 && secs <= 10) return secs * 1000;
    }
  }
  return 1000 * 2 ** attempt; // 1s, 2s
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Pull the model's text out of a Gemini generateContent response. */
function extractModelText(json: unknown): string | null {
  if (typeof json !== 'object' || json === null) return null;
  const candidates = (json as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const first = candidates[0] as { content?: { parts?: Array<{ text?: unknown }> } };
  const parts = first?.content?.parts;
  if (!Array.isArray(parts)) return null;
  const text = parts
    .map((p) => (typeof p?.text === 'string' ? p.text : ''))
    .join('')
    .trim();
  return text ? text : null;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return fallback('Receipt extraction is not configured right now.');
  }
  // Model fallback chain: same price class, different capacity pools. We saw
  // gemini-3.6-flash 503 while gemini-3-flash-preview served fine (2026-09-22).
  const models = [
    process.env.GEMINI_MODEL || 'gemini-3-flash-preview',
    'gemini-3.6-flash',
  ];

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return fallback('Could not read the uploaded image.');
  }

  // Accept `image` (single, legacy) and/or `images` (multi-slip/multi-page).
  const files: File[] = [];
  const single = form.get('image');
  if (single instanceof File) files.push(single);
  for (const f of form.getAll('images')) {
    if (f instanceof File) files.push(f);
  }
  if (files.length === 0) {
    return fallback('No image was uploaded.');
  }
  if (files.length > MAX_IMAGES) {
    return fallback(`Please upload at most ${MAX_IMAGES} images of the same receipt.`);
  }
  for (const file of files) {
    if (!file.type.startsWith('image/')) {
      return fallback('The uploaded file is not an image.');
    }
    if (file.size > MAX_IMAGE_BYTES) {
      return fallback('An image is too large. Please try a smaller photo.');
    }
  }

  // In-memory only: never written to disk, never persisted, never logged.
  const inlineParts = await Promise.all(
    files.map(async (file) => ({
      inlineData: {
        mimeType: file.type,
        data: Buffer.from(await file.arrayBuffer()).toString('base64'),
      },
    })),
  );

  const parts = [{ text: EXTRACTION_PROMPT }, ...inlineParts];
  const requestBody = JSON.stringify({
    contents: [{ parts }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
  });

  // Try the primary model with retries, then fall through to the next model
  // in the chain before giving up to the manual track.
  let upstream: Response | null = null;
  let lastStatus: number | null = null;
  let modelFailed = false;

  for (const model of models) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    upstream = null;
    modelFailed = false;
    for (let attempt = 0; ; attempt++) {
      upstream = null;
      let networkFailed = false;
      try {
        upstream = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey,
          },
          body: requestBody,
        });
      } catch {
        networkFailed = true;
      }
      const retryable = networkFailed || (upstream !== null && RETRYABLE.has(upstream.status));
      if (!retryable || attempt >= MAX_RETRIES) break;
      await sleep(retryDelayMs(attempt, upstream));
    }
    if (upstream && upstream.ok) break; // success — stop the chain
    if (upstream) lastStatus = upstream.status;
    modelFailed = true;
    console.error(
      `[receipt/extract] Gemini model ${model} failed (HTTP ${lastStatus ?? 'network'}), trying next in chain`,
    );
  }

  if (!upstream || modelFailed) {
    if (lastStatus === 429) {
      return fallback('The extraction service is busy right now. Please try the manual entry.');
    }
    return fallback('The extraction service failed. Please try again.');
  }

  let modelText: string | null;
  try {
    const json: unknown = await upstream.json();
    modelText = extractModelText(json);
  } catch {
    return fallback('The extraction service returned an unreadable response.');
  }
  if (!modelText) {
    return fallback('The extraction service returned no text.');
  }

  let raw: unknown;
  try {
    raw = JSON.parse(modelText) as unknown;
  } catch {
    return fallback('The extraction service returned invalid data.');
  }

  const extraction: Extraction | null = validateExtraction(raw);
  if (!extraction) {
    return fallback('The extraction result could not be understood.');
  }

  return NextResponse.json({ ok: true, data: extraction }, { status: 200 });
}
