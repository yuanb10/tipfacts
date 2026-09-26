// Seed script: (re)creates the 8 fictional demo venues + 28 reports.
// Works against BOTH backends: Postgres when DATABASE_URL is set, otherwise
// the local JSON store. Seeds are marked isSeed and are clearly fictional
// ("Demo Diner" etc.). Wipe everything with: npm run wipe
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getStorage } from '../lib/storage.ts';
import type { Evidence, ReceiptParsed } from '../lib/storage.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const UPLOADS = path.join(ROOT, 'public', 'uploads');

const storage = getStorage();
const backend = process.env.DATABASE_URL ? 'postgres' : 'json';
console.log(`Seeding against ${backend} backend…`);
await storage.wipeAll();

// --- placeholder "receipt" SVGs (fictional, no PII) -------------------------
function receiptSvg(store: string, lines: [string, string][], tipLine: string): string {
  const rows = lines
    .map(
      ([label, amt], i) =>
        `<text x="24" y="${90 + i * 30}" font-family="monospace" font-size="15" fill="#333">${label}</text>` +
        `<text x="276" y="${90 + i * 30}" font-family="monospace" font-size="15" fill="#333" text-anchor="end">${amt}</text>`,
    )
    .join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="400">
<rect width="300" height="400" fill="#ffffff"/>
<rect x="0" y="0" width="300" height="52" fill="#f0ede8"/>
<text x="150" y="32" font-family="sans-serif" font-size="17" font-weight="bold" text-anchor="middle" fill="#222">${store}</text>
${rows}
<rect x="16" y="${80 + lines.length * 30}" width="268" height="44" fill="#eef4ff"/>
<text x="24" y="${108 + lines.length * 30}" font-family="monospace" font-size="16" font-weight="bold" fill="#0a6cff">TIP ${tipLine}</text>
<text x="150" y="380" font-family="sans-serif" font-size="12" fill="#999" text-anchor="middle">seed placeholder image</text>
</svg>`;
}

fs.mkdirSync(UPLOADS, { recursive: true });

interface SeedImage {
  file: string;
  kind: 'receipt' | 'screen';
  store: string;
  lines: [string, string][];
  tip: string;
  presets: number[];
  tipPercentReported: number | null;
}
const seedImages: SeedImage[] = [
  {
    file: 'seed-receipt-1.svg', kind: 'receipt', store: 'DEMO DINER',
    lines: [['Subtotal', '$41.00'], ['Tax', '$4.31']], tip: '20% 25% 30%',
    presets: [20, 25, 30], tipPercentReported: 18,
  },
  {
    file: 'seed-receipt-4.svg', kind: 'receipt', store: 'DEMO DINER',
    lines: [['Subtotal', '$38.20'], ['Tax', '$4.01']], tip: '20% 25% 30%',
    presets: [20, 25, 30], tipPercentReported: 25,
  },
  {
    file: 'seed-receipt-2.svg', kind: 'receipt', store: 'SAMPLE SUSHI',
    lines: [['Subtotal', '$58.50'], ['Tax', '$6.14']], tip: '20% 22% 25%',
    presets: [20, 22, 25], tipPercentReported: 22,
  },
  {
    file: 'seed-receipt-5.svg', kind: 'receipt', store: 'PRETEND PIZZA',
    lines: [['Subtotal', '$24.00'], ['Tax', '$2.52']], tip: '25% 30% 35%',
    presets: [25, 30, 35], tipPercentReported: 30,
  },
  {
    file: 'seed-receipt-3.svg', kind: 'receipt', store: 'TEST TACO TRUCK',
    lines: [['Subtotal', '$12.75'], ['Tax', '$1.34']], tip: '30% 35% 40%',
    presets: [30, 35, 40], tipPercentReported: 35,
  },
  {
    file: 'seed-receipt-6.svg', kind: 'receipt', store: 'TEST TACO TRUCK',
    lines: [['Subtotal', '$15.40'], ['Tax', '$1.62']], tip: '30% 35% 40%',
    presets: [30, 35, 40], tipPercentReported: 40,
  },
  {
    file: 'seed-screen-1.svg', kind: 'screen', store: 'DEMO DINER',
    lines: [], tip: '', presets: [20, 25, 30], tipPercentReported: null,
  },
  {
    file: 'seed-screen-2.svg', kind: 'screen', store: 'SAMPLE SUSHI',
    lines: [], tip: '', presets: [20, 22, 25], tipPercentReported: null,
  },
  {
    file: 'seed-screen-3.svg', kind: 'screen', store: 'PRETEND PIZZA',
    lines: [], tip: '', presets: [25, 30, 35], tipPercentReported: null,
  },
  {
    file: 'seed-screen-4.svg', kind: 'screen', store: 'TEST TACO TRUCK',
    lines: [], tip: '', presets: [30, 35, 40], tipPercentReported: null,
  },
];

// --- placeholder "tip screen" SVGs (fictional, no PII) -----------------------
function screenSvg(store: string, presets: number[]): string {
  const btns = presets
    .map(
      (p, i) =>
        `<rect x="${24 + i * 88}" y="120" width="80" height="56" rx="10" fill="#eef4ff" stroke="#0a6cff"/>` +
        `<text x="${64 + i * 88}" y="155" font-family="sans-serif" font-size="18" font-weight="bold" text-anchor="middle" fill="#0a6cff">${p}%</text>`,
    )
    .join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="400">
<rect width="300" height="400" rx="18" fill="#2b2b2e"/>
<text x="150" y="48" font-family="sans-serif" font-size="17" font-weight="bold" text-anchor="middle" fill="#fff">${store}</text>
<text x="150" y="88" font-family="sans-serif" font-size="15" text-anchor="middle" fill="#ccc">Add a tip?</text>
${btns}
<text x="150" y="380" font-family="sans-serif" font-size="12" fill="#999" text-anchor="middle">seed placeholder image</text>
</svg>`;
}

const evidenceByFile = new Map<string, Evidence>();
for (const img of seedImages) {
  const art =
    img.kind === 'screen' ? screenSvg(img.store, img.presets) : receiptSvg(img.store, img.lines, img.tip);
  fs.writeFileSync(path.join(UPLOADS, img.file), art, 'utf8');
  const pub = '/uploads/' + img.file;
  const ev = await storage.createEvidence({
    type: img.kind,
    originalPath: pub, // placeholder art, no PII — safe to serve
    redactedPath: pub,
    redactionStatus: 'confirmed',
    userConfirmed: true,
    parsed: {
      merchant: img.store,
      purchasedAt: null,
      subtotal: null,
      tax: null,
      tip: null,
      total: null,
      fees: [],
      presets: img.presets,
      tipPercentReported: img.tipPercentReported,
      rawText: null,
    } satisfies ReceiptParsed,
    isSeed: true,
  });
  evidenceByFile.set(img.file, ev);
}

// --- venues + reports -------------------------------------------------------
interface V { name: string; city: string; area: string; serviceType: 'counter'|'table'|'takeout'|'nonfood'; screen: string; presets: string; tipBase: 'pre-tax'|'post-tax'|'not-sure'; fees: string[] }
interface R { at: string; photo?: string; screenPhoto?: string; guilt?: 'yes' | 'no' | 'skip'; notes?: string; presets?: string; tipBase?: V['tipBase']; fees?: string[]; serviceType?: V['serviceType']; screen?: string; area?: string }

const venues: V[] = [
  { name: 'Demo Diner', city: 'Seattle', area: 'Capitol Hill', serviceType: 'counter', screen: 'staff-held', presets: '20%, 25%, 30%', tipBase: 'post-tax', fees: ['service-charge'] },
  { name: 'Fictional Pho House', city: 'Seattle', area: 'International District', serviceType: 'table', screen: 'handed-over', presets: '18%, 20%, 22%', tipBase: 'pre-tax', fees: ['none'] },
  { name: 'Pretend Pizza Co.', city: 'Seattle', area: 'Ballard', serviceType: 'takeout', screen: 'handed-over', presets: '25%, 30%, 35%', tipBase: 'post-tax', fees: ['card-surcharge'] },
  { name: 'Mock Mart', city: 'Seattle', area: 'Downtown', serviceType: 'nonfood', screen: 'staff-held', presets: '15%, 20%, 25%', tipBase: 'pre-tax', fees: ['none'] },
  { name: 'Imaginary Ice Cream', city: 'Seattle', area: 'Fremont', serviceType: 'counter', screen: 'no-screen', presets: '', tipBase: 'pre-tax', fees: ['none'] },
  { name: 'Sample Sushi Spot', city: 'Bellevue', area: 'Downtown Bellevue', serviceType: 'table', screen: 'staff-held', presets: '20%, 22%, 25%', tipBase: 'post-tax', fees: ['none'] },
  { name: 'Placeholder Coffee', city: 'Tacoma', area: 'Downtown', serviceType: 'counter', screen: 'handed-over', presets: '18%, 20%', tipBase: 'pre-tax', fees: ['none'] },
  { name: 'Test Taco Truck', city: 'Seattle', area: 'South Lake Union', serviceType: 'takeout', screen: 'staff-held', presets: '30%, 35%, 40%', tipBase: 'pre-tax', fees: ['service-charge'] },
];

const reportLists: R[][] = [
  [ // Demo Diner — 3 reports, photo + screen backed
    { at: '2026-09-02T12:10:00', photo: 'seed-receipt-1.svg', screenPhoto: 'seed-screen-1.svg', guilt: 'yes', notes: 'Cashier held the tablet the whole time. Post-tax total used for the tip math.' },
    { at: '2026-09-08T18:40:00', presets: '20 / 25 / 30', screenPhoto: 'seed-screen-1.svg', guilt: 'no' },
    { at: '2026-09-15T13:05:00', photo: 'seed-receipt-4.svg', guilt: 'yes', notes: 'Same as last time. 3% service charge printed on the receipt.' },
  ],
  [ // Fictional Pho House — 4 reports, text only
    { at: '2026-08-28T19:20:00' },
    { at: '2026-09-05T12:30:00', notes: 'Standard table service, tip on the pre-tax subtotal.' },
    { at: '2026-09-11T20:15:00' },
    { at: '2026-09-17T13:45:00', presets: '18%, 20%, 22%' },
  ],
  [ // Pretend Pizza Co. — 2 reports, 1 photo-backed
    { at: '2026-09-10T17:55:00', photo: 'seed-receipt-5.svg', screenPhoto: 'seed-screen-3.svg', notes: 'Pickup order and the reader still prompted for a tip, calculated on the taxed total.' },
    { at: '2026-09-16T18:20:00' },
  ],
  [ // Mock Mart — 5 reports, text only
    { at: '2026-08-25T10:05:00' },
    { at: '2026-09-01T15:30:00', notes: 'Non-food retail asking for tips at self-checkout.' },
    { at: '2026-09-07T11:12:00' },
    { at: '2026-09-13T16:44:00' },
    { at: '2026-09-18T09:30:00', presets: '15%, 20%, 25%' },
  ],
  [ // Imaginary Ice Cream — 3 reports, no tip screen
    { at: '2026-09-03T14:00:00', notes: 'No tip screen, just paid the menu price.' },
    { at: '2026-09-09T15:25:00' },
    { at: '2026-09-14T13:10:00' },
  ],
  [ // Sample Sushi Spot — 3 reports, 1 photo-backed
    { at: '2026-09-04T19:45:00', photo: 'seed-receipt-2.svg', screenPhoto: 'seed-screen-2.svg', notes: 'Tip suggested on the post-tax total.' },
    { at: '2026-09-12T20:05:00' },
    { at: '2026-09-18T19:30:00' },
  ],
  [ // Placeholder Coffee — 2 reports, text only
    { at: '2026-09-06T08:15:00' },
    { at: '2026-09-15T08:40:00', notes: 'Counter pickup, low presets, no pressure.' },
  ],
  [ // Test Taco Truck — 6 reports, 2 photo-backed
    { at: '2026-08-27T12:20:00' },
    { at: '2026-09-02T12:35:00', photo: 'seed-receipt-3.svg', screenPhoto: 'seed-screen-4.svg', notes: '30% as the lowest option at a taco truck is wild.' },
    { at: '2026-09-08T13:00:00' },
    { at: '2026-09-11T12:45:00' },
    { at: '2026-09-15T18:10:00', photo: 'seed-receipt-6.svg' },
    { at: '2026-09-18T12:30:00', notes: 'Service charge on a takeout window order.' },
  ],
];

let n = 0;
for (let vi = 0; vi < venues.length; vi++) {
  const v = venues[vi];
  const venue = await storage.findOrCreateVenue(v.name, v.city, v.area, { isSeed: true });
  for (const r of reportLists[vi]) {
    const evidenceIds: string[] = [];
    if (r.photo) {
      const ev = evidenceByFile.get(r.photo);
      if (ev) evidenceIds.push(ev.id);
    }
    if (r.screenPhoto) {
      const ev = evidenceByFile.get(r.screenPhoto);
      if (ev) evidenceIds.push(ev.id);
    }
    const report = await storage.createReport({
      venueId: venue.id,
      venueName: v.name,
      city: v.city,
      area: r.area ?? v.area,
      serviceType: r.serviceType ?? v.serviceType,
      screenPresentation: r.screen ?? v.screen,
      presets: r.presets ?? v.presets,
      tipBase: r.tipBase ?? v.tipBase,
      fees: r.fees ?? v.fees,
      guilt: r.guilt ?? 'skip',
      experienceNote: '',
      notes: r.notes ?? '',
      evidenceIds,
      reporterHash: '',
      isSeed: true,
    });
    // Seeds enter as approved so the demo renders; real submissions enter as pending.
    await storage.setReportStatus(report.id, 'approved', 'seed data');
    await storage.logModerationAction(report.id, 'approved', 'seed data');
    // Preserve original seed timestamps.
    n++;
  }
}

await storage.close();
console.log(`Seeded ${n} reports across ${venues.length} venues (${backend}).`);
