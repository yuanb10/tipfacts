// Geofabrik venue import: parse a regional OSM PBF extract locally →
// normalized listing shells (same shape as scripts/import-osm.ts: name,
// address, lat/lng, category, source='osm', no scores). Replaces the
// Overpass API approach — the public Overpass instances have been
// chronically overloaded since early 2026 and most mirrors are dead.
//
// Get the extract from https://download.geofabrik.de/ (e.g.
// north-america/us/washington-latest.osm.pbf). Do NOT commit the .pbf —
// it is gitignored; the script only needs it at import time.
//
// Re-running with the same extract is a no-op: venue ids are deterministic
// (name + city + address/coords), and bulkUpsertVenues only fills in missing
// fields on conflict.
//
// Usage:
//   node scripts/import-geofabrik.ts [extract.osm.pbf]
//   node scripts/import-geofabrik.ts --dry-run
//   node scripts/import-geofabrik.ts --max=50
//
// Shells have no approved reports, so they stay out of the public leaderboard
// and sitemap; they exist so the submit flow's type-ahead / OCR pre-fill /
// nearby picker can attach reports to them without anyone typing a full name.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildVenueShell,
  dedupeVenueShells,
  importVenueShells,
  isVenueAmenity,
} from '../lib/osm-venues.ts';
import type { VenueUpsert } from '../lib/storage.ts';

const require = createRequire(import.meta.url);
// osm-pbf-parser is a small pure-JS streaming PBF reader (devDependency).
const parsePbf = require('osm-pbf-parser') as () => NodeJS.ReadWriteStream;

interface PbfItem {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
  refs?: number[];
}

interface WayCandidate {
  tags: Record<string, string>;
  refs: number[];
}

/** Stream every item in the PBF through onItem. */
function streamPbf(pbfPath: string, onItem: (item: PbfItem) => void, label: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const parser = parsePbf();
    let scanned = 0;
    const t0 = Date.now();
    fs.createReadStream(pbfPath).pipe(parser);
    parser.on('data', (items: PbfItem[]) => {
      for (const item of items) {
        scanned++;
        onItem(item);
      }
      if (scanned % 10_000_000 === 0) {
        console.log(`  [${label}] scanned ${(scanned / 1e6).toFixed(0)}M objects…`);
      }
    });
    parser.on('end', () => {
      console.log(`  [${label}] scanned ${(scanned / 1e6).toFixed(1)}M objects in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
      resolve(scanned);
    });
    parser.on('error', reject);
  });
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const args = new Set(rawArgs);
  const dryRun = args.has('--dry-run');
  const maxArg = rawArgs.find((a) => a.startsWith('--max='));
  const max = maxArg ? parseInt(maxArg.split('=')[1], 10) : Infinity;
  const pbfArg = rawArgs.find((a) => !a.startsWith('--'));
  const pbfPath = path.resolve(pbfArg ?? 'data/washington-latest.osm.pbf');

  if (!fs.existsSync(pbfPath)) {
    console.error(`PBF extract not found: ${pbfPath}`);
    console.error('Download one from https://download.geofabrik.de/ (do not commit the .pbf).');
    process.exit(1);
  }

  const backend = process.env.DATABASE_URL ? 'postgres' : 'json';
  console.log(`Geofabrik import against ${backend} backend${dryRun ? ' (dry run — no writes)' : ''}…`);
  console.log(`Reading ${pbfPath}`);

  // Pass 1: matching nodes become shells directly; matching ways are kept
  // with their node refs for centroid computation in pass 2.
  const nodeShells: VenueUpsert[] = [];
  const wayCandidates: WayCandidate[] = [];
  let skipped = 0;
  await streamPbf(
    pbfPath,
    (item) => {
      const tags = item.tags ?? {};
      if (!isVenueAmenity(tags)) return;
      if (item.type === 'node') {
        const shell = buildVenueShell(tags, item.lat as number, item.lon as number);
        if (shell) nodeShells.push(shell);
        else skipped++;
      } else if (item.type === 'way') {
        const name = (tags.name ?? '').trim();
        if (!name || name.length > 100) {
          skipped++;
          return;
        }
        wayCandidates.push({ tags, refs: item.refs ?? [] });
      }
    },
    'pass 1',
  );
  console.log(`Pass 1: ${nodeShells.length} node shells, ${wayCandidates.length} way candidates, ${skipped} skipped.`);

  // Pass 2: resolve coordinates for nodes referenced by matching ways.
  const needed = new Set<number>();
  for (const w of wayCandidates) for (const r of w.refs) needed.add(r);
  console.log(`Resolving ${needed.size} referenced nodes…`);
  const coords = new Map<number, [number, number]>();
  await streamPbf(
    pbfPath,
    (item) => {
      if (item.type !== 'node' || !needed.has(item.id)) return;
      if (Number.isFinite(item.lat) && Number.isFinite(item.lon)) {
        coords.set(item.id, [item.lat as number, item.lon as number]);
        needed.delete(item.id);
      }
    },
    'pass 2',
  );

  const wayShells: VenueUpsert[] = [];
  let waysUnresolved = 0;
  for (const w of wayCandidates) {
    let sumLat = 0;
    let sumLon = 0;
    let n = 0;
    for (const r of w.refs) {
      const c = coords.get(r);
      if (c) {
        sumLat += c[0];
        sumLon += c[1];
        n++;
      }
    }
    if (n === 0) {
      waysUnresolved++;
      continue;
    }
    const shell = buildVenueShell(w.tags, sumLat / n, sumLon / n);
    if (shell) wayShells.push(shell);
    else skipped++;
  }
  console.log(`Pass 2: ${wayShells.length} way shells, ${waysUnresolved} ways with no resolvable nodes.`);

  let shells = dedupeVenueShells([...nodeShells, ...wayShells]);
  console.log(`Normalized ${shells.length} venue candidates (skipped ${skipped} without usable name/coords).`);
  if (Number.isFinite(max) && shells.length > max) {
    shells = shells.slice(0, max);
    console.log(`Capped at --max=${max}.`);
  }

  if (dryRun) {
    const cities = new Map<string, number>();
    for (const v of shells) cities.set(v.city, (cities.get(v.city) ?? 0) + 1);
    console.log('Top cities:', [...cities.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10));
    console.log(
      'Sample:',
      shells.slice(0, 5).map((v) => `${v.name} — ${v.address || 'no addr'} (${v.city}) [${v.category}]`),
    );
    return;
  }

  const result = await importVenueShells(shells);
  console.log(
    `Done: ${result.created} new shells, ${result.updated} already present, ` +
      `${result.total} venues total (${backend}).`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
