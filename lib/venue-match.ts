/**
 * Venue matching helpers for TipFacts venue coverage.
 *
 * Client-safe: no Node imports, so both API routes and the /submit page can
 * use it. Used for (a) fuzzy-matching an OCR-extracted merchant name against
 * known venues and (b) ranking type-ahead / nearby results.
 */

/** Lowercase, strip punctuation and corporate suffixes, collapse spaces. */
export function normalizeVenueName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[''ʼ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(
      /\b(llc|inc|co|corp|corporation|ltd|pllc|restaurant|restaurants|cafe|coffee|kitchen|bar|grill|eatery)\b/g,
      ' ',
    )
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array<number>(b.length + 1);
  let cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    const t = prev;
    prev = cur;
    cur = t;
  }
  return prev[b.length];
}

/**
 * Similarity between a raw query (e.g. OCR merchant text) and a venue name,
 * 0..1. Combines edit similarity with token overlap so minor OCR noise
 * ("Starbuck5", "MCD0NALD'S") still matches. Returns 0 for empty input.
 */
export function matchScore(query: string, name: string): number {
  const q = normalizeVenueName(query);
  const n = normalizeVenueName(name);
  if (!q || !n) return 0;
  if (q === n) return 1;
  // One contains the other — common when receipts print "STARBUCKS STORE #123".
  if (n.includes(q) || q.includes(n)) {
    const shorter = Math.min(q.length, n.length);
    const longer = Math.max(q.length, n.length);
    return 0.7 + 0.3 * (shorter / longer);
  }
  const maxLen = Math.max(q.length, n.length);
  const editSim = 1 - levenshtein(q, n) / maxLen;
  // Token overlap (Jaccard), order-insensitive: "Pho House Fictional" ~= "Fictional Pho House".
  const qt = new Set(q.split(' '));
  const nt = new Set(n.split(' '));
  let inter = 0;
  for (const t of qt) if (nt.has(t)) inter++;
  const jaccard = inter / (qt.size + nt.size - inter || 1);
  return Math.max(editSim, jaccard);
}

/** Best venue for a merchant string, or null when nothing passes `minScore`. */
export function bestVenueMatch<T extends { name: string }>(
  query: string,
  venues: T[],
  minScore = 0.75,
): { venue: T; score: number } | null {
  let best: { venue: T; score: number } | null = null;
  for (const venue of venues) {
    const score = matchScore(query, venue.name);
    if (score >= minScore && (!best || score > best.score)) {
      best = { venue, score };
    }
  }
  return best;
}

/** Great-circle distance in meters. */
export function haversineMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
