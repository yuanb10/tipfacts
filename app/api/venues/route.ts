import { NextRequest, NextResponse } from 'next/server';
import { getStorage } from '@/lib/storage';
import type { Evidence, Report, Venue } from '@/lib/storage';
import { aggregateBackedFacts, aggregateConsensus, summarizeVenues } from '@/lib/score';
import type { VenueCard } from '@/lib/score';

/**
 * GET /api/venues?q=&city=&service=&sort=
 * Public ranking data. Approved reports only; scoring is evidence-backed.
 */
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const q = (searchParams.get('q') || '').toLowerCase().trim();
  const city = searchParams.get('city') || '';
  const service = searchParams.get('service') || '';
  const sort = searchParams.get('sort') || 'score';

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

  let cards: VenueCard[] = summarizeVenues(venues, approved, evidenceById);

  // Listing shells (bulk-imported venues with no approved reports yet) stay
  // out of the public leaderboard — they exist for type-ahead/nearby so new
  // reports can attach to them, and they surface here once real data lands.
  cards = cards.filter((c) => c.approvedCount > 0);

  // Backed service type is needed for the service filter; computed from the
  // same evidence-backed aggregation used for scoring, falling back to
  // community consensus when no screen evidence backs it yet.
  const serviceTypeByVenue = new Map<string, string>();
  for (const venue of venues) {
    const rs = approved
      .filter((r) => r.venueId === venue.id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const backed = aggregateBackedFacts(rs, evidenceById).serviceType;
    serviceTypeByVenue.set(venue.id, backed || aggregateConsensus(rs).serviceType);
  }

  if (q) {
    cards = cards.filter((c) => c.venue.name.toLowerCase().includes(q));
  }
  if (city) {
    cards = cards.filter((c) => c.venue.city === city);
  }
  if (service) {
    cards = cards.filter((c) => serviceTypeByVenue.get(c.venue.id) === service);
  }

  cards = [...cards].sort((a, b) => {
    if (sort === 'name') return a.venue.name.localeCompare(b.venue.name);
    if (sort === 'reports') return b.approvedCount - a.approvedCount;
    // score desc; null ("awaiting evidence") last
    const sa = a.score === null ? -1 : a.score.score;
    const sb = b.score === null ? -1 : b.score.score;
    if (sb !== sa) return sb - sa;
    return b.approvedCount - a.approvedCount;
  });

  const cities = [...new Set(venues.map((v) => v.city))].sort();
  return NextResponse.json({ venues: cards, cities });
}
