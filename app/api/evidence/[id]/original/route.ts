import { NextRequest, NextResponse } from 'next/server';
import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import path from 'path';
import { getStorage } from '@/lib/storage';

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
  heic: 'image/heic',
};

/**
 * GET /api/evidence/[id]/original
 *
 * Serves the uploader's ORIGINAL photo (pre-redaction) so they can compare it
 * side-by-side with the redacted copy in step 2 of the submission flow.
 *
 * Access control for v1 is the unguessable random evidence id — originals are
 * never linked anywhere public and are excluded from search indexing via the
 * review page's noindex/no-robots context. Never embed this URL in a public
 * page or feed.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!/^[A-Za-z0-9_-]{4,128}$/.test(id)) {
    return NextResponse.json({ ok: false, error: 'Not found.' }, { status: 404 });
  }

  const evidence = await getStorage().getEvidence(id);
  if (!evidence || !evidence.originalPath) {
    return NextResponse.json({ ok: false, error: 'Not found.' }, { status: 404 });
  }

  // originalPath looks like `data/uploads-private/<f>` — resolve against cwd,
  // and refuse to leave the app directory (path-traversal guard).
  const root = path.resolve(process.cwd()) + path.sep;
  const full = path.resolve(process.cwd(), evidence.originalPath);
  if (!full.startsWith(root)) {
    return NextResponse.json({ ok: false, error: 'Not found.' }, { status: 404 });
  }

  const info = await stat(full).catch(() => null);
  if (!info || !info.isFile()) {
    return NextResponse.json({ ok: false, error: 'Not found.' }, { status: 404 });
  }

  const ext = full.split('.').pop()?.toLowerCase() ?? '';
  const contentType = MIME[ext] ?? 'application/octet-stream';

  const stream = createReadStream(full);
  return new NextResponse(stream as unknown as ReadableStream, {
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(info.size),
      // Private: never shared publicly; short cache for the review step only.
      'Cache-Control': 'private, max-age=3600',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
}
