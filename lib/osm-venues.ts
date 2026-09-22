// Shared OSM venue-shell helpers for the import scripts
// (scripts/import-osm.ts — Overpass API, scripts/import-geofabrik.ts —
// local PBF extract). Both produce identical venue shells: name, address,
// lat/lng, category, source='osm', no scores. Shells have no approved
// reports, so they stay out of the public leaderboard and sitemap; they
// exist so the submit flow's type-ahead / OCR pre-fill / nearby picker can
// attach reports to them without anyone typing a full name.
import { getStorage, normalize } from './storage.ts';
import type { Storage, VenueUpsert } from './storage.ts';

export const AMENITIES = [
  'restaurant',
  'cafe',
  'fast_food',
  'bar',
  'pub',
  'ice_cream',
  'food_court',
];

export const CATEGORY_LABEL: Record<string, string> = {
  restaurant: 'restaurant',
  cafe: 'cafe',
  fast_food: 'fast food',
  bar: 'bar',
  pub: 'pub',
  ice_cream: 'ice cream',
  food_court: 'food court',
};

// Rough city assignment when OSM has no addr:city tag: [south, west, north, east, name].
// Seattle metro: Everett-ish south of the Sound to Tacoma, Sound to the Cascades foothills.
// Plus major Washington cities (the Geofabrik import covers the whole state).
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
  // Major Washington cities outside the metro (statewide Geofabrik import).
  [47.6, -117.55, 47.73, -117.15, 'Spokane'],
  [45.58, -122.72, 45.72, -122.45, 'Vancouver'],
  [47.88, -122.28, 48.0, -122.14, 'Everett'],
  [48.0, -122.2, 48.1, -122.1, 'Marysville'],
  [48.68, -122.56, 48.8, -122.38, 'Bellingham'],
  [46.95, -122.98, 47.08, -122.8, 'Olympia'],
  [46.55, -120.6, 46.65, -120.45, 'Yakima'],
  [46.18, -119.3, 46.32, -119.0, 'Tri-Cities'],
  [47.38, -120.35, 47.48, -120.28, 'Wenatchee'],
  [46.03, -118.4, 46.1, -118.28, 'Walla Walla'],
  [46.7, -117.2, 46.76, -117.15, 'Pullman'],
  [46.95, -120.6, 47.02, -120.5, 'Ellensburg'],
  [47.52, -122.68, 47.6, -122.6, 'Bremerton'],
  [47.62, -122.72, 47.68, -122.66, 'Silverdale'],
  [48.08, -123.5, 48.14, -123.38, 'Port Angeles'],
  [48.4, -122.38, 48.46, -122.3, 'Mount Vernon'],
  [46.1, -122.98, 46.18, -122.88, 'Longview'],
  [46.95, -123.9, 47.0, -123.78, 'Aberdeen'],
];

export function cityFor(lat: number, lng: number, tagCity: string): string {
  const t = tagCity.trim();
  if (t) return t;
  for (const [s, w, n, e, name] of CITY_BOXES) {
    if (lat >= s && lat <= n && lng >= w && lng <= e) return name;
  }
  return 'Washington';
}

/** True when an OSM element's tags mark it as one of our venue categories. */
export function isVenueAmenity(tags: Record<string, string>): boolean {
  return AMENITIES.includes((tags.amenity ?? '').toLowerCase());
}

/**
 * Build a venue shell from OSM tags + coordinates. Returns null for
 * elements with no usable name or no coordinates (callers count these
 * as skipped).
 */
export function buildVenueShell(
  tags: Record<string, string>,
  lat: number,
  lng: number,
): VenueUpsert | null {
  const name = (tags.name ?? '').trim();
  if (!name || name.length > 100) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const street = [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' ').trim();
  const city = cityFor(lat, lng, tags['addr:city'] ?? '');
  const amenity = (tags.amenity ?? '').toLowerCase();
  return {
    name,
    city,
    area: (tags['addr:suburb'] ?? tags['addr:neighbourhood'] ?? '').trim(),
    address: street,
    lat,
    lng,
    category: CATEGORY_LABEL[amenity] ?? amenity,
    source: 'osm',
    // Chain branches at different addresses stay distinct; re-runs are stable.
    disambiguator: street || `${lat.toFixed(5)},${lng.toFixed(5)}`,
  };
}

/**
 * Drop exact duplicates inside one import batch (e.g. node+way double-tagging
 * of the same venue).
 */
export function dedupeVenueShells(shells: VenueUpsert[]): VenueUpsert[] {
  const seen = new Set<string>();
  return shells.filter((v) => {
    const key = normalize(v.name) + '|' + normalize(v.city) + '|' + normalize(v.address ?? '');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export interface UpsertResult {
  created: number;
  updated: number;
  total: number;
  enriched: number;
}

/**
 * Write venue shells to storage. An OSM candidate matching an existing
 * manual venue by normalized (name, city) fills in that venue's missing
 * lat/lng/address instead of creating a second shell (keeps the seed
 * venues canonical). bulkUpsertVenues is idempotent, so re-running with
 * the same shells is a no-op.
 */
export async function upsertVenueShells(
  storage: Storage,
  shells: VenueUpsert[],
): Promise<UpsertResult> {
  const existing = await storage.listVenues();
  const existingByKey = new Map(existing.map((v) => [normalize(v.name) + '|' + normalize(v.city), v]));
  const toImport: VenueUpsert[] = [];
  let enriched = 0;
  for (const v of shells) {
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
  return { ...result, enriched };
}

/** Convenience wrapper: getStorage() + upsertVenueShells. */
export async function importVenueShells(shells: VenueUpsert[]): Promise<UpsertResult> {
  return upsertVenueShells(getStorage(), shells);
}
