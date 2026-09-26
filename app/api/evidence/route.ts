/**
 * POST /api/evidence — upload a receipt/screen photo for a report.
 *
 * The client redacts PII on-device (RedactionCanvas) BEFORE uploading, so
 * the bytes we receive here are already the user-redacted image — the true
 * original never leaves the reporter's device. We normalize the upload to
 * the storage spec (grayscale JPEG, longest side ≤1200px, quality 80) and
 * store it under data/uploads/; it is served at
 * /api/uploads/<id>-redacted.jpg (a route handler, because the production
 * server doesn't pick up files added to public/ at runtime). The venue page
 * shows it once the uploader confirms the evidence.
 *
 * Multipart: { photo: File, type: 'receipt' | 'screen' }
 */

import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { getStorage } from '@/lib/storage';
import type { Evidence, EvidenceType } from '@/lib/storage';

export const runtime = 'nodejs';

const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const TYPES = new Set<EvidenceType>(['receipt', 'screen']);

function publicEvidenceShape(ev: Evidence) {
  return {
    id: ev.id,
    type: ev.type,
    redactedUrl: ev.redactedPath, // '/api/uploads/<id>-redacted.jpg'
    redactionStatus: ev.redactionStatus,
    parsed: ev.parsed,
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
  if (!TYPES.has(type as EvidenceType)) {
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

  // Create the evidence row first so the stored file is named after the
  // evidence id. Paths are filled in once the upload is normalized below.
  let evidence = await storage.createEvidence({
    type: type as EvidenceType,
    originalPath: '',
    redactionStatus: 'manual',
    userConfirmed: false,
    parsed: null,
  });

  const id = evidence.id;
  const uploadDir = path.join(process.cwd(), 'data', 'uploads');
  await fs.promises.mkdir(uploadDir, { recursive: true });

  // Normalize the user-redacted upload to the storage spec. This is the only
  // server copy of the image.
  const fileName = `${id}-redacted.jpg`;
  const absPath = path.join(uploadDir, fileName);
  try {
    const buf = Buffer.from(await photo.arrayBuffer());
    await sharp(buf)
      .grayscale()
      .resize(1200, 1200, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toFile(absPath);
  } catch {
    return NextResponse.json(
      { ok: false, error: 'Could not read the photo. Try another image.' },
      { status: 400 },
    );
  }

  const relPath = path.join('data', 'uploads', fileName);
  evidence = await storage.updateEvidence(id, {
    // v1: the client only uploads the user-redacted image, so there is no
    // pre-redaction copy server-side — both paths point at the redacted file.
    originalPath: relPath,
    redactedPath: `/api/uploads/${fileName}`,
  });

  return NextResponse.json({ ok: true, evidence: publicEvidenceShape(evidence) });
}
