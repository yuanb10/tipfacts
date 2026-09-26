/**
 * POST /api/evidence/[id]/confirm — the uploader reviews the redacted copy
 * and confirms it is safe to publish.
 *
 * Body: { confirmed: boolean, attestedNoPii?: boolean, parsed?: Partial<ReceiptParsed> }
 *
 * - confirmed=true requires redactionStatus 'pending' or 'manual', and the
 *   uploader's attestation that the image contains no PII (the redaction was
 *   done by hand, on-device, before upload).
 * - confirmed=false returns the evidence unchanged (review declined).
 * - parsed corrections merge into the existing parsed object. When the
 *   corrected values include a tip and a subtotal, the pre-tax tip percentage
 *   is derived from them (never trusted from an external reader).
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
            ? 'This photo could not be read. Attest that it contains no PII (attestedNoPii: true) to confirm, or re-upload.'
            : 'This evidence is already confirmed.',
      },
      { status: 400 },
    );
  }

  // Merge parsed corrections over the existing parsed object. When the
  // corrected values include a tip and a subtotal, derive the pre-tax tip
  // percentage from them — arithmetic on confirmed inputs, never fabricated.
  let parsed = evidence.parsed;
  if (body.parsed && typeof body.parsed === 'object') {
    parsed = { ...(parsed ?? nullParsed()), ...body.parsed };
  }
  if (
    parsed &&
    parsed.tipPercentReported == null &&
    parsed.tip != null &&
    parsed.subtotal != null &&
    parsed.subtotal > 0
  ) {
    parsed.tipPercentReported = Math.round((parsed.tip / parsed.subtotal) * 1000) / 10;
  }

  const updated = await storage.updateEvidence(id, {
    userConfirmed: true,
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
  };
}
