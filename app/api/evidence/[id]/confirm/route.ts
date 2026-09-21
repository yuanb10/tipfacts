/**
 * POST /api/evidence/[id]/confirm — the uploader reviews the redacted copy
 * (or the manual flow when OCR was unavailable) and confirms it is safe.
 *
 * Body: { confirmed: boolean, attestedNoPii?: boolean, parsed?: Partial<ReceiptParsed> }
 *
 * - confirmed=true requires redactionStatus 'pending' or 'manual'. A 'failed'
 *   OCR can still be confirmed if the uploader attests the image contains no
 *   PII (attestedNoPii) — it is then reclassified as 'manual'.
 * - confirmed=false returns the evidence unchanged (review declined).
 * - parsed corrections merge into the existing parsed object; ocrEngine is
 *   never overwritten (it records how the values were originally produced).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getStorage } from '@/lib/storage';
import type { ReceiptParsed } from '@/lib/storage';

export const runtime = 'nodejs';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const storage = getStorage();

  const evidence = await storage.getEvidence(id);
  if (!evidence) {
    return NextResponse.json({ ok: false, error: 'Evidence not found.' }, { status: 404 });
  }

  let body: { confirmed?: boolean; attestedNoPii?: boolean; parsed?: Partial<ReceiptParsed> };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body.' }, { status: 400 });
  }

  if (body.confirmed !== true) {
    return NextResponse.json({ ok: true, evidence });
  }

  const { redactionStatus } = evidence;
  const canConfirm =
    redactionStatus === 'pending' ||
    redactionStatus === 'manual' ||
    (redactionStatus === 'failed' && body.attestedNoPii === true);

  if (!canConfirm) {
    return NextResponse.json(
      {
        ok: false,
        error:
          redactionStatus === 'failed'
            ? 'OCR failed on this photo. Attest that it contains no PII (attestedNoPii: true) to confirm, or re-upload.'
            : 'This evidence is already confirmed.',
      },
      { status: 400 },
    );
  }

  // Merge parsed corrections over the existing parsed object, keeping
  // ocrEngine as-is (it records the provenance of the original read).
  let parsed = evidence.parsed;
  if (body.parsed && typeof body.parsed === 'object') {
    const { ocrEngine: _ignored, ...corrections } = body.parsed;
    parsed = { ...(parsed ?? nullParsed()), ...corrections, ocrEngine: parsed?.ocrEngine ?? 'manual' };
  }

  const updated = await storage.updateEvidence(id, {
    userConfirmed: true,
    // 'failed' + attestedNoPii reclassifies as manual provenance.
    redactionStatus: 'confirmed',
    parsed,
  });

  return NextResponse.json({ ok: true, evidence: updated });
}

function nullParsed(): ReceiptParsed {
  return {
    merchant: null,
    purchasedAt: null,
    subtotal: null,
    tax: null,
    tip: null,
    total: null,
    fees: [],
    presets: [],
    tipPercentReported: null,
    rawText: null,
    ocrEngine: 'manual',
    ocrConfidence: null,
  };
}
