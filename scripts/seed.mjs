// Seed script: writes data/db.json with fictional demo venues + placeholder receipt images.
// All venue names are obviously fake ("Demo Diner" etc.) so seed data is easy to spot.
// Wipe everything with: npm run wipe
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'db.json');
const UPLOADS = path.join(ROOT, 'public', 'uploads');

function rid() {
  return crypto.randomBytes(8).toString('hex');
}

// Simple placeholder "receipt" SVG so seeded photo-backed reports render an image.
function receiptSvg(store, lines, tipLine) {
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

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
fs.mkdirSync(UPLOADS, { recursive: true });

const seedImages = [
  ['seed-receipt-1.svg', 'DEMO DINER', [['Subtotal', '$41.00'], ['Tax', '$4.31']], '20% 25% 30%'],
  ['seed-receipt-2.svg', 'SAMPLE SUSHI', [['Subtotal', '$58.50'], ['Tax', '$6.14']], '20% 22% 25%'],
  ['seed-receipt-3.svg', 'TEST TACO TRUCK', [['Subtotal', '$12.75'], ['Tax', '$1.34']], '30% 35% 40%'],
];
for (const [name, store, lines, tip] of seedImages) {
  fs.writeFileSync(path.join(UPLOADS, name), receiptSvg(store, lines, tip), 'utf8');
}

function R(venue, createdAt, fields) {
  const photoPath = fields.photoPath ?? null;
  return {
    id: rid(),
    venueName: venue.name,
    city: venue.city,
    area: fields.area ?? venue.area,
    serviceType: fields.serviceType ?? venue.serviceType,
    screenPresentation: fields.screenPresentation ?? venue.screen,
    presets: fields.presets ?? venue.presets,
    tipBase: fields.tipBase ?? venue.tipBase,
    fees: fields.fees ?? venue.fees,
    photoPath,
    notes: fields.notes ?? '',
    email: '',
    verified: photoPath !== null,
    createdAt,
  };
}

const venues = [
  {
    name: 'Demo Diner',
    city: 'Seattle',
    area: 'Capitol Hill',
    serviceType: 'counter',
    screen: 'staff-held',
    presets: '20%, 25%, 30%',
    tipBase: 'post-tax',
    fees: ['service-charge'],
  },
  {
    name: 'Fictional Pho House',
    city: 'Seattle',
    area: 'International District',
    serviceType: 'table',
    screen: 'handed-over',
    presets: '18%, 20%, 22%',
    tipBase: 'pre-tax',
    fees: ['none'],
  },
  {
    name: 'Pretend Pizza Co.',
    city: 'Seattle',
    area: 'Ballard',
    serviceType: 'takeout',
    screen: 'handed-over',
    presets: '25%, 30%, 35%',
    tipBase: 'post-tax',
    fees: ['card-surcharge'],
  },
  {
    name: 'Mock Mart',
    city: 'Seattle',
    area: 'Downtown',
    serviceType: 'nonfood',
    screen: 'staff-held',
    presets: '15%, 20%, 25%',
    tipBase: 'pre-tax',
    fees: ['none'],
  },
  {
    name: 'Imaginary Ice Cream',
    city: 'Seattle',
    area: 'Fremont',
    serviceType: 'counter',
    screen: 'no-screen',
    presets: '',
    tipBase: 'pre-tax',
    fees: ['none'],
  },
  {
    name: 'Sample Sushi Spot',
    city: 'Bellevue',
    area: 'Downtown Bellevue',
    serviceType: 'table',
    screen: 'staff-held',
    presets: '20%, 22%, 25%',
    tipBase: 'post-tax',
    fees: ['none'],
  },
  {
    name: 'Placeholder Coffee',
    city: 'Tacoma',
    area: 'Downtown',
    serviceType: 'counter',
    screen: 'handed-over',
    presets: '18%, 20%',
    tipBase: 'pre-tax',
    fees: ['none'],
  },
  {
    name: 'Test Taco Truck',
    city: 'Seattle',
    area: 'South Lake Union',
    serviceType: 'takeout',
    screen: 'staff-held',
    presets: '30%, 35%, 40%',
    tipBase: 'pre-tax',
    fees: ['service-charge'],
  },
];

const reports = [];
const d = (s) => new Date(s).toISOString();

// Demo Diner — 3 reports, 2 photo-backed
reports.push(
  R(venues[0], d('2026-09-02T12:10:00'), {
    photoPath: '/uploads/seed-receipt-1.svg',
    notes: 'Cashier held the tablet the whole time. Post-tax total used for the tip math.',
  }),
  R(venues[0], d('2026-09-08T18:40:00'), { presets: '20 / 25 / 30' }),
  R(venues[0], d('2026-09-15T13:05:00'), {
    photoPath: '/uploads/seed-receipt-1.svg',
    notes: 'Same as last time. 3% service charge printed on the receipt.',
  }),
);

// Fictional Pho House — 4 reports, text only
reports.push(
  R(venues[1], d('2026-08-28T19:20:00'), {}),
  R(venues[1], d('2026-09-05T12:30:00'), { notes: 'Standard table service, tip on the pre-tax subtotal.' }),
  R(venues[1], d('2026-09-11T20:15:00'), {}),
  R(venues[1], d('2026-09-17T13:45:00'), { presets: '18%, 20%, 22%' }),
);

// Pretend Pizza Co. — 2 reports (few reports), 1 photo-backed
reports.push(
  R(venues[2], d('2026-09-10T17:55:00'), {
    photoPath: '/uploads/seed-receipt-2.svg',
    notes: 'Pickup order and the reader still prompted for a tip, calculated on the taxed total.',
  }),
  R(venues[2], d('2026-09-16T18:20:00'), {}),
);

// Mock Mart — 5 reports, text only
reports.push(
  R(venues[3], d('2026-08-25T10:05:00'), {}),
  R(venues[3], d('2026-09-01T15:30:00'), { notes: 'Non-food retail asking for tips at self-checkout.' }),
  R(venues[3], d('2026-09-07T11:12:00'), {}),
  R(venues[3], d('2026-09-13T16:44:00'), {}),
  R(venues[3], d('2026-09-18T09:30:00'), { presets: '15%, 20%, 25%' }),
);

// Imaginary Ice Cream — 3 reports, no tip screen at all
reports.push(
  R(venues[4], d('2026-09-03T14:00:00'), { notes: 'No tip screen, just paid the menu price.' }),
  R(venues[4], d('2026-09-09T15:25:00'), {}),
  R(venues[4], d('2026-09-14T13:10:00'), {}),
);

// Sample Sushi Spot — 3 reports, 1 photo-backed
reports.push(
  R(venues[5], d('2026-09-04T19:45:00'), {
    photoPath: '/uploads/seed-receipt-2.svg',
    notes: 'Tip suggested on the post-tax total.',
  }),
  R(venues[5], d('2026-09-12T20:05:00'), {}),
  R(venues[5], d('2026-09-18T19:30:00'), {}),
);

// Placeholder Coffee — 2 reports (few reports), text only
reports.push(
  R(venues[6], d('2026-09-06T08:15:00'), {}),
  R(venues[6], d('2026-09-15T08:40:00'), { notes: 'Counter pickup, low presets, no pressure.' }),
);

// Test Taco Truck — 6 reports, 2 photo-backed
reports.push(
  R(venues[7], d('2026-08-27T12:20:00'), {}),
  R(venues[7], d('2026-09-02T12:35:00'), {
    photoPath: '/uploads/seed-receipt-3.svg',
    notes: '30% as the lowest option at a taco truck is wild.',
  }),
  R(venues[7], d('2026-09-08T13:00:00'), {}),
  R(venues[7], d('2026-09-11T12:45:00'), {}),
  R(venues[7], d('2026-09-15T18:10:00'), { photoPath: '/uploads/seed-receipt-3.svg' }),
  R(venues[7], d('2026-09-18T12:30:00'), { notes: 'Service charge on a takeout window order.' }),
);

fs.writeFileSync(DB_PATH, JSON.stringify(reports, null, 2), 'utf8');
console.log(`Seeded ${reports.length} reports across ${venues.length} venues -> ${DB_PATH}`);
