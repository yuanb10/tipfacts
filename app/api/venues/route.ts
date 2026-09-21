import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { readReports, writeReports, summarize, Report } from '@/lib/store';

const SERVICE_TYPES = new Set(['counter', 'table', 'takeout', 'nonfood']);
const FEE_VALUES = new Set(['service-charge', 'card-surcharge', 'none', 'other']);
const TIP_BASE_VALUES = new Set(['pre-tax', 'post-tax', 'not-sure']);
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

// Simple in-memory rate limit: 5 submissions per IP per rolling hour.
const hits = new Map<string, number[]>();
function allowed(ip: string): boolean {
  const now = Date.now();
  const arr = (hits.get(ip) ?? []).filter((t) => now - t < 3600_000);
  if (arr.length >= 5) return false;
  arr.push(now);
  hits.set(ip, arr);
  return true;
}

function clientIp(req: NextRequest): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const q = (searchParams.get('q') || '').toLowerCase().trim();
  const city = searchParams.get('city') || '';
  const service = searchParams.get('service') || '';
  const sort = searchParams.get('sort') || 'score';

  const all = summarize(readReports());
  let venues = all;
  if (q) venues = venues.filter((v) => v.venueName.toLowerCase().includes(q));
  if (city) venues = venues.filter((v) => v.city === city);
  if (service) venues = venues.filter((v) => v.serviceType === service);

  venues = [...venues].sort((a, b) => {
    if (sort === 'name') return a.venueName.localeCompare(b.venueName);
    if (sort === 'reports') return b.reports - a.reports;
    // score desc; "few reports" (null) last
    const sa = a.score === null ? -1 : a.score;
    const sb = b.score === null ? -1 : b.score;
    return sb - sa;
  });

  const cities = [...new Set(all.map((v) => v.city))].sort();
  return NextResponse.json({ venues, cities });
}

export async function POST(req: NextRequest) {
  const ip = clientIp(req);

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ ok: false, error: 'Could not read the form.' }, { status: 400 });
  }
  const str = (k: string): string => {
    const v = form.get(k);
    return typeof v === 'string' ? v.trim() : '';
  };

  // Honeypot: bots fill it; silently accept and discard.
  if (str('website')) {
    return NextResponse.json({ ok: true });
  }

  if (!allowed(ip)) {
    return NextResponse.json(
      { ok: false, error: 'Too many submissions — please try again later.' },
      { status: 429 },
    );
  }

  const venueName = str('venueName');
  const city = str('city');
  const serviceType = str('serviceType');
  if (!venueName || !city) {
    return NextResponse.json(
      { ok: false, error: 'Venue name and city are required.' },
      { status: 400 },
    );
  }
  if (!SERVICE_TYPES.has(serviceType)) {
    return NextResponse.json({ ok: false, error: 'Invalid service type.' }, { status: 400 });
  }

  const fees = form
    .getAll('fees')
    .filter((v): v is string => typeof v === 'string' && FEE_VALUES.has(v));

  // Optional photo upload (stored locally for v1; see README for the S3 TODO).
  let photoPath: string | null = null;
  const photo = form.get('photo');
  if (photo && typeof photo !== 'string' && photo.size > 0) {
    if (!photo.type.startsWith('image/')) {
      return NextResponse.json({ ok: false, error: 'Photo must be an image file.' }, { status: 400 });
    }
    if (photo.size > MAX_PHOTO_BYTES) {
      return NextResponse.json(
        { ok: false, error: 'Photo must be smaller than 10 MB.' },
        { status: 400 },
      );
    }
    const rawExt = (photo.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '');
    const ext = rawExt || 'jpg';
    const fname = crypto.randomBytes(8).toString('hex') + '.' + ext;
    const dir = path.join(process.cwd(), 'public', 'uploads');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, fname), Buffer.from(await photo.arrayBuffer()));
    photoPath = '/uploads/' + fname;
  }

  const tipBaseRaw = str('tipBase');
  const report: Report = {
    id: crypto.randomBytes(8).toString('hex'),
    venueName,
    city,
    area: str('area'),
    serviceType: serviceType as Report['serviceType'],
    screenPresentation: str('screenPresentation'),
    presets: str('presets'),
    tipBase: (TIP_BASE_VALUES.has(tipBaseRaw) ? tipBaseRaw : '') as Report['tipBase'],
    fees,
    photoPath,
    notes: str('notes'),
    email: str('email'),
    verified: photoPath !== null, // photo-backed = verified, text-only = unverified
    createdAt: new Date().toISOString(),
  };

  const reports = readReports();
  reports.push(report);
  writeReports(reports);

  return NextResponse.json({ ok: true, id: report.id });
}
