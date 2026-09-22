import { NextRequest, NextResponse } from 'next/server';
import { getStorage } from '@/lib/storage';
import type { Venue } from '@/lib/storage';
import { haversineMeters, normalizeVenueName } from '@/lib/venue-match';

/**
 * GET /api/venues/search?q=&lat=&lng=&radius=
 *
 * Lightweight venue lookup for the submit flow's type-ahead and "nearby"
 * picker. Unlike /api/venues (the scored leaderboard), this returns listing
 * shells too — venues with no approved reports yet — because the whole point
 * is attaching a new report to an existing listing instead of typing one
 * from scratch.
 *
 * Modes (q wins when both are present):
 *   - text:   ?q=star  → prefix/substring match on name, then address/area
 *   - nearby: ?lat=47.6&lng=-122.33[&radius=800] → venues within radius meters
 *
 * Response: { ok, venues: [{ id, name, city, area, address, lat, lng,
 * category, source, distanceMeters? }] } — capped at 10 (text) / 20 (nearby).
 */
export const dynamic = 'force-dynamic';

const TEXT_CAP = 10;
const NEARBY_CAP = 20;
const DEFAULT_RADIUS_M = 800;
const MAX_RADIUS_M = 5000;

interface VenueHit {
  id: string;
  name: string;
  city: string;
  area: string;
  address: string;
  lat: number | null;
  lng: number | null;
  category: string;
  source: 'osm' | 'manual';
  distanceMeters?: number;
}

function shape(v: Venue, distanceMeters?: number): VenueHit {
  const hit: VenueHit = {
    id: v.id,
    name: v.name,
    city: v.city,
    area: v.area,
    address: v.address,
    lat: v.lat,
    lng: v.lng,
    category: v.category,
    source: v.source,
  };
  if (distanceMeters !== undefined) hit.distanceMeters = Math.round(distanceMeters);
  return hit;
}

function textSearch(venues: Venue[], q: string): VenueHit[] {
  const nq = normalizeVenueName(q);
  if (nq.length < 2) return [];
  const ranked: { v: Venue; rank: number }[] = [];
  for (const v of venues) {
    const nn = normalizeVenueName(v.name);
    if (!nn) continue;
    if (nn.startsWith(nq)) ranked.push({ v, rank: 0 });
    else if (nn.includes(nq)) ranked.push({ v, rank: 1 });
    else {
      // Every query token appears somewhere in the name ("house pho" → "Pho House").
      const tokens = nq.split(' ').filter(Boolean);
      if (tokens.length > 1 && tokens.every((t) => nn.includes(t))) {
        ranked.push({ v, rank: 2 });
      } else if (
        normalizeVenueName(v.address).includes(nq) ||
        normalizeVenueName(v.area).includes(nq)
      ) {
        ranked.push({ v, rank: 3 });
      }
    }
  }
  ranked.sort((a, b) => a.rank - b.rank || a.v.name.localeCompare(b.v.name));
  return ranked.slice(0, TEXT_CAP).map((r) => shape(r.v));
}

function nearbySearch(venues: Venue[], lat: number, lng: number, radius: number): VenueHit[] {
  const hits: { v: Venue; d: number }[] = [];
  for (const v of venues) {
    if (v.lat == null || v.lng == null) continue;
    const d = haversineMeters(lat, lng, v.lat, v.lng);
    if (d <= radius) hits.push({ v, d });
  }
  hits.sort((a, b) => a.d - b.d);
  return hits.slice(0, NEARBY_CAP).map((h) => shape(h.v, h.d));
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const q = (searchParams.get('q') || '').trim().slice(0, 80);
  const latRaw = searchParams.get('lat');
  const lngRaw = searchParams.get('lng');
  const radiusRaw = searchParams.get('radius');

  const store = getStorage();
  const venues = await store.listVenues();

  // Unapproved manual shells stay out of search: a hand-typed venue with only
  // a pending report shouldn't be suggested to other users before moderation.
  // OSM listing shells are public data and always searchable.
  const approved = await store.listReports({ status: 'approved', includeSeeds: true });
  const approvedVenueIds = new Set(approved.map((r) => r.venueId));
  const searchable = venues.filter((v) => v.source === 'osm' || approvedVenueIds.has(v.id));

  if (q) {
    return NextResponse.json({ ok: true, venues: textSearch(searchable, q), mode: 'text' });
  }

  const lat = latRaw == null ? NaN : parseFloat(latRaw);
  const lng = lngRaw == null ? NaN : parseFloat(lngRaw);
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    let radius = radiusRaw == null ? DEFAULT_RADIUS_M : parseFloat(radiusRaw);
    if (!Number.isFinite(radius) || radius <= 0) radius = DEFAULT_RADIUS_M;
    radius = Math.min(radius, MAX_RADIUS_M);
    return NextResponse.json({
      ok: true,
      venues: nearbySearch(searchable, lat, lng, radius),
      mode: 'nearby',
    });
  }

  return NextResponse.json(
    { ok: false, error: 'Provide q (text search) or lat+lng (nearby search).' },
    { status: 400 },
  );
}
