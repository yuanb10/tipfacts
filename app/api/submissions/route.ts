import { NextRequest, NextResponse } from 'next/server';
import { getStorage, hashKey } from '@/lib/storage';
import type { NewReport, ServiceType, TipBase, Venue } from '@/lib/storage';

const SERVICE_TYPES: ServiceType[] = ['counter', 'table', 'takeout', 'nonfood'];
const FEE_VALUES = new Set(['service-charge', 'card-surcharge', 'none', 'other']);
const TIP_BASE_VALUES: TipBase[] = ['pre-tax', 'post-tax', 'not-sure'];
const GUILT_VALUES = new Set(['yes', 'no', 'skip']);
/** Evidence must be reviewed+confirmed by the uploader before it can be attached. */
const CONFIRMED_STATUSES = new Set(['confirmed', 'manual']);

function clientIp(req: NextRequest): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
}

/**
 * Max submissions per IP per hour. Default 20 — generous enough for real
 * testing, still a backstop against floods. Override with SUBMIT_RATE_LIMIT.
 */
function submitRateLimit(): number {
  const raw = parseInt(process.env.SUBMIT_RATE_LIMIT ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 20;
}

/**
 * POST /api/submissions
 * Receipt-first submission endpoint (Sprint 1). Accepts multipart/form-data
 * built by the multi-step form at /submit. v1: reports publish immediately
 * (no MOD_SECRET → moderation queue not live yet); setting MOD_SECRET puts
 * new reports back to 'pending' until approved.
 */
export async function POST(req: NextRequest) {
  const ip = clientIp(req);
  const storage = getStorage();

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

  const rl = await storage.checkRateLimit('submit:' + ip, submitRateLimit(), 3600_000);
  if (!rl.allowed) {
    return NextResponse.json(
      { ok: false, error: 'Too many submissions — please try again later.' },
      { status: 429 },
    );
  }

  const venueName = str('venueName');
  const city = str('city');
  const serviceType = str('serviceType') as ServiceType;

  // When the submit flow picked an existing listing (type-ahead, OCR
  // pre-fill, or nearby), the client sends its venueId; the venue's own
  // name/city win over anything typed. Otherwise fall back to the manual
  // name + city fields, which create the venue on the fly.
  const venueIdRaw = str('venueId');
  let venue: Venue;
  if (venueIdRaw) {
    const existing = await storage.getVenue(venueIdRaw);
    if (!existing) {
      return NextResponse.json({ ok: false, error: 'Unknown venue.' }, { status: 400 });
    }
    venue = existing;
  } else {
    if (!venueName || !city) {
      return NextResponse.json(
        { ok: false, error: 'Venue name and city are required.' },
        { status: 400 },
      );
    }
    venue = await storage.findOrCreateVenue(venueName, city, str('area'));
  }
  if (!SERVICE_TYPES.includes(serviceType)) {
    return NextResponse.json({ ok: false, error: 'Invalid service type.' }, { status: 400 });
  }

  // Evidence: every attached item must exist and have been reviewed + confirmed
  // by the uploader in step 2 (redaction review gate).
  let evidenceIds: string[] = [];
  const evidenceRaw = str('evidenceIds');
  if (evidenceRaw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(evidenceRaw);
    } catch {
      return NextResponse.json({ ok: false, error: 'Invalid evidence list.' }, { status: 400 });
    }
    if (!Array.isArray(parsed) || !parsed.every((e) => typeof e === 'string')) {
      return NextResponse.json({ ok: false, error: 'Invalid evidence list.' }, { status: 400 });
    }
    evidenceIds = [...new Set(parsed)];
    for (const eid of evidenceIds) {
      const ev = await storage.getEvidence(eid);
      if (!ev || !ev.userConfirmed || !CONFIRMED_STATUSES.has(ev.redactionStatus)) {
        return NextResponse.json(
          { ok: false, error: 'Evidence must be reviewed and confirmed first.' },
          { status: 400 },
        );
      }
      // One photo, one report: never steal another report's evidence link.
      if (ev.reportId) {
        return NextResponse.json(
          { ok: false, error: 'This photo is already attached to another report.' },
          { status: 400 },
        );
      }
    }
  }

  const fees = form
    .getAll('fees')
    .filter((v): v is string => typeof v === 'string' && FEE_VALUES.has(v));

  const tipBaseRaw = str('tipBase');
  const guiltRaw = str('guilt');
  const easyOptOutRaw = str('easyOptOut');
  const serviceDateRaw = str('serviceDate');
  const serviceDate = /^\d{4}-\d{2}-\d{2}$/.test(serviceDateRaw) ? serviceDateRaw : '';

  const report = await storage.createReport({
    venueId: venue.id,
    venueName: venueIdRaw ? venue.name : venueName,
    city: venueIdRaw ? venue.city : city,
    area: venueIdRaw ? venue.area || str('area') : str('area'),
    serviceDate,
    serviceType,
    screenPresentation: str('screenPresentation'),
    presets: str('presets'),
    tipBase: (TIP_BASE_VALUES.includes(tipBaseRaw as TipBase) ? tipBaseRaw : '') as NewReport['tipBase'],
    fees,
    guilt: (GUILT_VALUES.has(guiltRaw) ? guiltRaw : 'skip') as NewReport['guilt'],
    easyOptOut: (GUILT_VALUES.has(easyOptOutRaw) ? easyOptOutRaw : 'skip') as NewReport['easyOptOut'],
    experienceNote: str('experienceNote'),
    notes: str('notes'),
    evidenceIds,
    reporterHash: hashKey(ip),
  } satisfies NewReport);

  return NextResponse.json({ ok: true, id: report.id });
}
