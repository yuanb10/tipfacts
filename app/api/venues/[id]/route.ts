import { NextRequest, NextResponse } from 'next/server';
import { readReports, venueDetail } from '@/lib/store';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const detail = venueDetail(readReports(), id);
  if (!detail) {
    return NextResponse.json({ ok: false, error: 'Venue not found.' }, { status: 404 });
  }
  return NextResponse.json({ ok: true, ...detail });
}
