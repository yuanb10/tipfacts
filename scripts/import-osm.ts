// OSM venue import: polite sequential Overpass queries for Seattle-metro
// food/drink venues → normalized listing shells (name, address, lat/lng,
// category, source='osm', no scores). Re-running with the same data is a no-op: venue
// ids are deterministic (name + city + address/coords), and bulkUpsertVenues
// only fills in missing fields on conflict.
//
// NOTE: the Overpass public API has been chronically overloaded since early
// 2026 (see scripts/import-geofabrik.ts for the local-extract alternative).
//
// Usage:
//   node scripts/import-osm.ts            # full import (JSON store or Postgres)
//   node scripts/import-osm.ts --dry-run  # fetch + normalize, print counts, no writes
//   node scripts/import-osm.ts --max 50   # cap imported venues (testing)
//
// Shells have no approved reports, so they stay out of the public leaderboard
// and sitemap; they exist so the submit flow's type-ahead / OCR pre-fill /
// nearby picker can attach reports to them without anyone typing a full name.
import {
  AMENITIES,
  buildVenueShell,
  dedupeVenueShells,
  importVenueShells,
} from '../lib/osm-venues.ts';
import type { VenueUpsert } from '../lib/storage.ts';

const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter', // community mirror, tried only if the main instance fails
];
// Seattle metro: Everett-ish south of the Sound to Tacoma, Sound to the Cascades foothills.
const BBOX = { south: 47.2, west: -122.62, north: 47.85, east: -121.95 };

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
  let skippedNoName = 0;
  for (const el of elements) {
    const tags = el.tags ?? {};
    const lat = el.type === 'node' ? el.lat : el.center?.lat;
    const lng = el.type === 'node' ? el.lon : el.center?.lon;
    const shell = buildVenueShell(tags, lat as number, lng as number);
    if (!shell) {
      skippedNoName++;
      continue;
    }
    out.push(shell);
  }
  // Drop exact duplicates inside the batch itself (node+way double-tagging).
  const deduped = dedupeVenueShells(out);
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

  const result = await importVenueShells(venues);
  console.log(
    `Done: ${result.created} new shells, ${result.updated} already present, ` +
      `${result.total} venues total (${backend}).`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
