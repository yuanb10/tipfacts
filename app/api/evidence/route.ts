/**
 * POST /api/evidence — upload a receipt/screen photo for PII redaction.
 *
 * Multipart: { photo: File, type: 'receipt' | 'screen' }
 * Originals are saved to data/uploads-private/ (gitignored, NEVER web-served).
 * When tesseract is available: OCR → detect PII boxes → render a blacked-out
 * public copy to public/uploads/<id>-redacted.png → extract parsed values.
 * Without tesseract: the evidence goes to the 'manual' path — the uploader
 * reviews/redacts by hand in the confirm UI. OCR failures are stored as
 * 'failed', never papered over.
 */

import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { getStorage, newId } from '@/lib/storage';
import type { Evidence, EvidenceType, ReceiptParsed } from '@/lib/storage';
import { isOcrAvailable, runOcr } from '@/lib/ocr';
import { findPiiBoxes, extractParsedValues, renderRedacted } from '@/lib/redact';

export const runtime = 'nodejs';

const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const TYPES = new Set<EvidenceType>(['receipt', 'screen']);

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'image/heif': 'heif',
};

function publicEvidenceShape(ev: Evidence, ocrAvailable: boolean) {
  return {
    id: ev.id,
    type: ev.type,
    redactedUrl: ev.redactedPath, // '/uploads/<id>-redacted.png' or null
    redactionStatus: ev.redactionStatus,
    parsed: ev.parsed,
    ocrAvailable,
  };
}

export async function POST(req: NextRequest) {
  const storage = getStorage();

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ ok: false, error: 'Could not read the form.' }, { status: 400 });
  }

  const type = form.get('type');
  if (type !== 'receipt' && type !== 'screen') {
    return NextResponse.json(
      { ok: false, error: "type must be 'receipt' or 'screen'." },
      { status: 400 },
    );
  }

  const photo = form.get('photo');
  if (!photo || typeof photo === 'string') {
    return NextResponse.json({ ok: false, error: 'photo file is required.' }, { status: 400 });
  }
  if (!photo.type.startsWith('image/')) {
    return NextResponse.json({ ok: false, error: 'photo must be an image.' }, { status: 400 });
  }
  if (photo.size > MAX_PHOTO_BYTES) {
    return NextResponse.json({ ok: false, error: 'photo must be 10MB or less.' }, { status: 400 });
  }
  if (photo.size === 0) {
    return NextResponse.json({ ok: false, error: 'photo is empty.' }, { status: 400 });
  }

  const id = newId();
  const ext = EXT_BY_MIME[photo.type] ?? 'png';
  const privateDir = path.join(process.cwd(), 'data', 'uploads-private');
  const publicDir = path.join(process.cwd(), 'public', 'uploads');
  await fs.promises.mkdir(privateDir, { recursive: true });
  await fs.promises.mkdir(publicDir, { recursive: true });

  const originalPath = path.join('data', 'uploads-private', `${id}.${ext}`);
  const originalAbs = path.join(process.cwd(), originalPath);
  const buf = Buffer.from(await photo.arrayBuffer());
  await fs.promises.writeFile(originalAbs, buf);

  let evidence: Evidence = await storage.createEvidence({
    type: type as EvidenceType,
    originalPath,
    redactionStatus: 'pending',
    userConfirmed: false,
    parsed: null,
  });

  const ocrAvailable = isOcrAvailable();

  if (!ocrAvailable) {
    // No tesseract: manual path. Uploader reviews/redacts in the confirm UI.
    evidence = await storage.updateEvidence(evidence.id, {
      redactionStatus: 'manual',
      parsed: null,
    });
    return NextResponse.json({
      ok: true,
      evidence: publicEvidenceShape(evidence, false),
    });
  }

  try {
    const ocr = await runOcr(originalAbs);
    if (!ocr) {
      evidence = await storage.updateEvidence(evidence.id, {
        redactionStatus: 'failed',
        parsed: null,
      });
      return NextResponse.json({
        ok: true,
        evidence: publicEvidenceShape(evidence, true),
      });
    }

    const meta = await sharp(originalAbs).metadata();
    const boxes = findPiiBoxes(ocr.words, meta.width ?? 0, meta.height ?? 0);
    const redactedAbs = path.join(publicDir, `${id}-redacted.png`);
    await renderRedacted(originalAbs, boxes, redactedAbs);

    const parsed: ReceiptParsed = extractParsedValues(ocr.words, ocr.rawText);
    parsed.ocrConfidence = ocr.meanConfidence;

    evidence = await storage.updateEvidence(evidence.id, {
      redactedPath: `/uploads/${id}-redacted.png`,
      redactionStatus: 'pending',
      parsed,
    });
    return NextResponse.json({
      ok: true,
      evidence: publicEvidenceShape(evidence, true),
    });
  } catch {
    evidence = await storage.updateEvidence(evidence.id, {
      redactionStatus: 'failed',
      parsed: null,
    });
    return NextResponse.json({
      ok: true,
      evidence: publicEvidenceShape(evidence, true),
    });
  }
}
