import { NextRequest, NextResponse } from 'next/server';
import { getStorage } from '@/lib/storage';

export async function POST(req: NextRequest) {
  const secret = process.env.MOD_SECRET;

  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body.' }, { status: 400 });
  }

  const { key, reportId, action, note } = (body ?? {}) as {
    key?: unknown;
    reportId?: unknown;
    action?: unknown;
    note?: unknown;
  };

  // Key gate: 403 unless MOD_SECRET is set and the supplied key matches.
  // Never reveal whether the secret is set.
  if (!secret || typeof key !== 'string' || key !== secret) {
    return NextResponse.json({ ok: false, error: 'Forbidden.' }, { status: 403 });
  }

  if (
    typeof reportId !== 'string' ||
    reportId.length === 0 ||
    (action !== 'approved' && action !== 'rejected')
  ) {
    return NextResponse.json({ ok: false, error: 'Invalid reportId or action.' }, { status: 400 });
  }

  const noteStr = typeof note === 'string' ? note.slice(0, 2000) : '';

  const store = getStorage();
  const report = await store.getReport(reportId);
  if (!report) {
    return NextResponse.json({ ok: false, error: 'Report not found.' }, { status: 400 });
  }

  await store.setReportStatus(reportId, action, noteStr);
  await store.logModerationAction(reportId, action, noteStr);
  return NextResponse.json({ ok: true });
}
