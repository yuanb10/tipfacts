/**
 * GET /api/uploads/[name] — serve user-uploaded redacted evidence images.
 *
 * Uploads live under data/uploads/, NOT public/: the production server does
 * not pick up files added to public/ at runtime (they 404 until the next
 * restart), so user uploads must be served by a route handler that reads
 * from disk per request.
 *
 * Only serves the exact filenames the evidence upload endpoint writes:
 * <evidence-id>-redacted.jpg. Anything else 404s.
 */

import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export const runtime = 'nodejs';

const NAME_RE = /^[A-Za-z0-9_-]{4,128}-redacted\.jpg$/;

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  if (!NAME_RE.test(name)) {
    return NextResponse.json({ ok: false, error: 'Not found.' }, { status: 404 });
  }

  // Resolve against data/uploads and refuse to leave it (traversal guard).
  const root = path.resolve(process.cwd(), 'data', 'uploads') + path.sep;
  const full = path.resolve(root, name);
  if (!full.startsWith(root)) {
    return NextResponse.json({ ok: false, error: 'Not found.' }, { status: 404 });
  }

  const buf = await fs.promises.readFile(full).catch(() => null);
  if (!buf) {
    return NextResponse.json({ ok: false, error: 'Not found.' }, { status: 404 });
  }

  return new NextResponse(buf as unknown as BodyInit, {
    headers: {
      'content-type': 'image/jpeg',
      'content-length': String(buf.length),
      // Filenames are content-addressed by evidence id: immutable.
      'cache-control': 'public, max-age=31536000, immutable',
    },
  });
}
