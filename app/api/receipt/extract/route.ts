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
 * facts from the ALREADY-REDACTED receipt photo. The original never leaves
 * the user's device; the server only ever receives the redacted image and
 * must never persist it, write it to disk, or log it.
 *
 * Contract (built against by the /submit UI):
 * - Request: multipart/form-data, field `image` = redacted JPEG file.
 * - Success: 200 { ok: true, data: Extraction }
 * - Failure: 503 { ok: false, error: string, fallback: 'manual' } — the UI
 *   treats 503 as "fall back to the manual track".
 */

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // safety net; client compresses to ≤1600px side

interface FailureBody {
  ok: false;
  error: string;
  fallback: 'manual';
}

function fallback(error: string): NextResponse<FailureBody> {
  return NextResponse.json({ ok: false, error, fallback: 'manual' }, { status: 503 });
}

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
  const model = process.env.GEMINI_MODEL || 'gemini-3-flash';

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return fallback('Could not read the uploaded image.');
  }

  const file = form.get('image');
  if (!(file instanceof File)) {
    return fallback('No image was uploaded.');
  }
  if (!file.type.startsWith('image/')) {
    return fallback('The uploaded file is not an image.');
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return fallback('The image is too large. Please try a smaller photo.');
  }

  // In-memory only: never written to disk, never persisted, never logged.
  const base64 = Buffer.from(await file.arrayBuffer()).toString('base64');

  let upstream: Response;
  try {
    upstream = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: EXTRACTION_PROMPT },
                { inlineData: { mimeType: file.type, data: base64 } },
              ],
            },
          ],
          generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
        }),
      },
    );
  } catch {
    return fallback('Could not reach the extraction service. Please try again.');
  }

  if (!upstream.ok) {
    // Log only the status — never the image, base64, or request body.
    console.error(`[receipt/extract] Gemini returned HTTP ${upstream.status}`);
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
