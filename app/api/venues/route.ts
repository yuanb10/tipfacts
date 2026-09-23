import { NextRequest, NextResponse } from 'next/server';
import { getStorage } from '@/lib/storage';
import type { Evidence, Report, Venue } from '@/lib/storage';
import { summarizeVenues } from '@/lib/score';
import type { VenueCard } from '@/lib/score';

/**
 * GET /api/venues?q=&city=&service=&sort=&state=&limit=&offset=
 * Public venue directory (PRD §5.4). Lists EVERY venue — scored, early-data,
 * and no-data shells alike. Approved reports only; scoring is evidence-backed.
 *
 * state: 'scored' (score != null) | 'early' (approved reports but no score)
 *        | 'none' (zero reports) | unset = all
 * sort:  'score' | 'reports' | 'name' | 'updated' (recently updated first)
 * limit: page size, default 100, clamped 1..500
 * offset: page offset, default 0
 * Returns { venues, cities, total }.
 */
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const q = (searchParams.get('q') || '').toLowerCase().trim();
  const city = searchParams.get('city') || '';
  const service = searchParams.get('service') || '';
  const sort = searchParams.get('sort') || 'score';
  const state = searchParams.get('state') || '';

  const limitRaw = Number.parseInt(searchParams.get('limit') || '100', 10);
  const limit = Number.isFinite(limitRaw)
    ? Math.min(Math.max(limitRaw, 1), 500)
    : 100;
  const offsetRaw = Number.parseInt(searchParams.get('offset') || '0', 10);
  const offset = Number.isFinite(offsetRaw) ? Math.max(offsetRaw, 0) : 0;

  const store = getStorage();
  const venues: Venue[] = await store.listVenues();
  const approved: Report[] = await store.listReports({
    status: 'approved',
    includeSeeds: true,
  });

  const evidenceById = new Map<string, Evidence>();
  const evidenceLists = await Promise.all(
    approved.map((r) => store.listEvidenceForReport(r.id)),
  );
  for (const list of evidenceLists) {
    for (const e of list) evidenceById.set(e.id, e);
  }

  // No approvedCount filter here — the directory lists every venue (PRD R.1).
  // Service type comes from the same evidence-backed aggregation used for
  // scoring, falling back to community consensus when no screen evidence
  // backs it yet; it is exposed per card via card.facts.serviceType.
  let cards: VenueCard[] = summarizeVenues(venues, approved, evidenceById);

  if (state === 'scored') {
    cards = cards.filter((c) => c.score !== null);
  } else if (state === 'early') {
    cards = cards.filter((c) => c.approvedCount > 0 && c.score === null);
  } else if (state === 'none') {
    cards = cards.filter((c) => c.approvedCount === 0);
  }

  if (q) {
    cards = cards.filter((c) => c.venue.name.toLowerCase().includes(q));
  }
  if (city) {
    cards = cards.filter((c) => c.venue.city === city);
  }
  if (service) {
    cards = cards.filter((c) => c.facts.serviceType === service);
  }

  cards = [...cards].sort((a, b) => {
    if (sort === 'name') return a.venue.name.localeCompare(b.venue.name);
    if (sort === 'reports') return b.approvedCount - a.approvedCount;
    if (sort === 'updated')
      return (
        b.lastUpdated.localeCompare(a.lastUpdated) ||
        a.venue.name.localeCompare(b.venue.name)
      );
    // score desc; null (awaiting evidence / no data) last
    const sa = a.score === null ? -1 : a.score.score;
    const sb = b.score === null ? -1 : b.score.score;
    if (sb !== sa) return sb - sa;
    return b.approvedCount - a.approvedCount;
  });

  const total = cards.length;
  const page = cards.slice(offset, offset + limit);

  const cities = [...new Set(venues.map((v) => v.city))].sort();
  return NextResponse.json({ venues: page, cities, total });
}
