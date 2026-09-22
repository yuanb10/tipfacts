// OSM venue import: polite sequential Overpass queries for Seattle-metro
// food/drink venues → normalized listing shells (name, address, lat/lng,
// category, source='osm', no scores). Re-running with the same data is a no-op: venue
// ids are deterministic (name + city + address/coords), and bulkUpsertVenues
// only fills in missing fields on conflict.
//
// Usage:
//   node scripts/import-osm.ts            # full import (JSON store or Postgres)
//   node scripts/import-osm.ts --dry-run  # fetch + normalize, print counts, no writes
//   node scripts/import-osm.ts --max 50   # cap imported venues (testing)
//
// Shells have no approved reports, so they stay out of the public leaderboard
// and sitemap; they exist so the submit flow's type-ahead / OCR pre-fill /
// nearby picker can attach reports to them without anyone typing a full name.
import { getStorage, normalize } from '../lib/storage.ts';
import type { VenueUpsert } from '../lib/storage.ts';

const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter', // community mirror, tried only if the main instance fails
];
// Seattle metro: Everett-ish south of the Sound to Tacoma, Sound to the Cascades foothills.
const BBOX = { south: 47.2, west: -122.62, north: 47.85, east: -121.95 };
const AMENITIES = ['restaurant', 'cafe', 'fast_food', 'bar', 'pub', 'ice_cream', 'food_court'];

const CATEGORY_LABEL: Record<string, string> = {
  restaurant: 'restaurant',
  cafe: 'cafe',
  fast_food: 'fast food',
  bar: 'bar',
  pub: 'pub',
  ice_cream: 'ice cream',
  food_court: 'food court',
};

// Rough city assignment when OSM has no addr:city tag: [south, west, north, east, name].
const CITY_BOXES: [number, number, number, number, string][] = [
  [47.49, -122.46, 47.73, -122.2, 'Seattle'],
  [47.58, -122.2, 47.65, -122.08, 'Bellevue'],
  [47.64, -122.16, 47.7, -122.04, 'Redmond'],
  [47.64, -122.24, 47.7, -122.16, 'Kirkland'],
  [47.66, -122.2, 47.72, -122.1, 'Kenmore'],
  [47.72, -122.24, 47.78, -122.16, 'Bothell'],
  [47.66, -122.06, 47.72, -121.98, 'Woodinville'],
  [47.58, -122.08, 47.64, -121.98, 'Sammamish'],
  [47.52, -122.08, 47.58, -122.0, 'Issaquah'],
  [47.52, -122.22, 47.56, -122.14, 'Newcastle'],
  [47.44, -122.24, 47.52, -122.12, 'Renton'],
  [47.36, -122.24, 47.44, -122.12, 'Kent'],
  [47.42, -122.32, 47.48, -122.24, 'Tukwila'],
  [47.44, -122.36, 47.5, -122.28, 'SeaTac'],
  [47.4, -122.36, 47.46, -122.28, 'Burien'],
  [47.36, -122.36, 47.42, -122.28, 'Des Moines'],
  [47.28, -122.36, 47.36, -122.28, 'Federal Way'],
  [47.2, -122.55, 47.32, -122.35, 'Tacoma'],
  [47.68, -122.42, 47.78, -122.3, 'Shoreline'],
  [47.76, -122.36, 47.84, -122.28, 'Mountlake Terrace'],
  [47.76, -122.28, 47.84, -122.2, 'Lynnwood'],
];

function cityFor(lat: number, lng: number, tagCity: string): string {
  const t = tagCity.trim();
  if (t) return t;
  for (const [s, w, n, e, name] of CITY_BOXES) {
    if (lat >= s && lat <= n && lng >= w && lng <= e) return name;
  }
  return 'Seattle';
}

function buildQuery(amenity: string): string {
  const bbox = `${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east}`;
  return `[out:json][timeout:90];
(
  node["amenity"="${amenity}"](${bbox});
  way["amenity"="${amenity}"](${bbox});
);
out center tags;`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface OsmElement {
  type: 'node' | 'way';
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

/** One Overpass query with mirror fallback and retries. Throws when all fail. */
async function queryOverpass(ql: string, label: string): Promise<OsmElement[]> {
  const body = 'data=' + encodeURIComponent(ql);
  let lastError = '';
  for (const url of OVERPASS_URLS) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 120_000);
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'TipFacts venue-import (https://github.com/yuanb10/tipfacts)',
          },
          body,
          signal: ctrl.signal,
        });
        const text = await res.text();
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        if (text.startsWith('<')) {
          // Overpass answers overloads with an XML/HTML error page.
          const m = text.match(/Error<\/strong>: ([^<]{0,140})/);
          throw new Error('Overpass error: ' + (m?.[1] ?? 'unknown').trim());
        }
        return (JSON.parse(text) as { elements?: OsmElement[] }).elements ?? [];
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        console.log(`  [${label}] ${url} attempt ${attempt}/3 failed: ${lastError}`);
      } finally {
        clearTimeout(timer);
      }
      await sleep(2000 * attempt);
    }
  }
  throw new Error(
    `Overpass query "${label}" failed after all retries (last: ${lastError}). ` +
      `The API is rate-limited and occasionally overloaded — wait a few minutes and re-run. Nothing was written.`,
  );
}

async function fetchOsm(): Promise<OsmElement[]> {
  // Sequential per-amenity queries: each is lighter than one giant query and
  // far more likely to succeed when the public instances are busy. Still
  // polite — strictly one request in flight, with a pause between amenities.
  const all: OsmElement[] = [];
  for (const amenity of AMENITIES) {
    console.log(`Querying amenity=${amenity} …`);
    const els = await queryOverpass(buildQuery(amenity), amenity);
    console.log(`  → ${els.length} elements`);
    all.push(...els);
    await sleep(1500);
  }
  return all;
}

function normalizeElements(elements: OsmElement[]): VenueUpsert[] {
  const out: VenueUpsert[] = [];
  const seenIds = new Set<string>();
  let skippedNoName = 0;
  for (const el of elements) {
    const tags = el.tags ?? {};
    const name = (tags.name ?? '').trim();
    if (!name || name.length > 100) {
      skippedNoName++;
      continue;
    }
    const lat = el.type === 'node' ? el.lat : el.center?.lat;
    const lng = el.type === 'node' ? el.lon : el.center?.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const street = [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' ').trim();
    const city = cityFor(lat as number, lng as number, tags['addr:city'] ?? '');
    const amenity = (tags.amenity ?? '').toLowerCase();
    out.push({
      name,
      city,
      area: (tags['addr:suburb'] ?? tags['addr:neighbourhood'] ?? '').trim(),
      address: street,
      lat: lat as number,
      lng: lng as number,
      category: CATEGORY_LABEL[amenity] ?? amenity,
      source: 'osm',
      // Chain branches at different addresses stay distinct; re-runs are stable.
      disambiguator: street || `${(lat as number).toFixed(5)},${(lng as number).toFixed(5)}`,
    });
  }
  // Drop exact duplicates inside the batch itself (node+way double-tagging).
  const deduped = out.filter((v) => {
    const key = normalize(v.name) + '|' + normalize(v.city) + '|' + normalize(v.address ?? '');
    if (seenIds.has(key)) return false;
    seenIds.add(key);
    return true;
  });
  console.log(`Skipped ${skippedNoName} elements with no usable name.`);
  return deduped;
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const dryRun = args.has('--dry-run');
  const maxArg = process.argv.find((a) => a.startsWith('--max='));
  const max = maxArg ? parseInt(maxArg.split('=')[1], 10) : Infinity;

  const backend = process.env.DATABASE_URL ? 'postgres' : 'json';
  console.log(`OSM import against ${backend} backend${dryRun ? ' (dry run — no writes)' : ''}…`);

  console.log('Querying Overpass (sequential per-amenity queries, Seattle metro bbox)…');
  const elements = await fetchOsm();
  console.log(`Overpass returned ${elements.length} elements.`);
  let venues = normalizeElements(elements);
  console.log(`Normalized ${venues.length} venue candidates.`);
  if (Number.isFinite(max) && venues.length > max) {
    venues = venues.slice(0, max);
    console.log(`Capped at --max=${max}.`);
  }

  if (dryRun) {
    const cities = new Map<string, number>();
    for (const v of venues) cities.set(v.city, (cities.get(v.city) ?? 0) + 1);
    console.log('Top cities:', [...cities.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8));
    console.log('Sample:', venues.slice(0, 5).map((v) => `${v.name} — ${v.address || 'no addr'} (${v.city})`));
    return;
  }

  const storage = getStorage();
  // Enrichment pass: an OSM candidate matching an existing manual venue by
  // normalized (name, city) fills in that venue's missing lat/lng/address
  // instead of creating a second shell (keeps the 8 seed venues canonical).
  const existing = await storage.listVenues();
  const existingByKey = new Map(existing.map((v) => [normalize(v.name) + '|' + normalize(v.city), v]));
  const toImport: VenueUpsert[] = [];
  let enriched = 0;
  for (const v of venues) {
    const hit = existingByKey.get(normalize(v.name) + '|' + normalize(v.city));
    if (hit && hit.source === 'manual' && (hit.lat === null || !hit.address)) {
      await storage.findOrCreateVenue(hit.name, hit.city, hit.area, {
        lat: v.lat,
        lng: v.lng,
        address: v.address,
        category: v.category,
      });
      enriched++;
    } else {
      toImport.push(v);
    }
  }
  if (enriched) console.log(`Enriched ${enriched} existing venues with OSM coordinates/address.`);

  const result = await storage.bulkUpsertVenues(toImport);
  await storage.close();
  console.log(
    `Done: ${result.created} new shells, ${result.updated} already present, ` +
      `${result.total} venues total (${backend}).`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
