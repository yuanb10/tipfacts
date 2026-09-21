import { NextRequest, NextResponse } from 'next/server';
import { getVenueDetail } from '@/lib/score';

/**
 * GET /api/venues/[id]
 * Public venue detail. Approved reports only, reporterHash stripped, and only
 * confirmed (user-verified, redacted) evidence is exposed — originals are never
 * served.
 */
export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const detail = await getVenueDetail(id);
  if (!detail) {
    return NextResponse.json({ ok: false, error: 'Venue not found.' }, { status: 404 });
  }
  return NextResponse.json({ ok: true, ...detail });
}
