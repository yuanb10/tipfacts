// Wipe ALL data (venues, reports, evidence, rate-limit hits, moderation log)
// from whichever backend is active: Postgres when DATABASE_URL is set,
// otherwise the local JSON store. Also removes seed placeholder images.
// This is the seed-removal path: after wipe, no fictional data remains.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getStorage } from '../lib/storage.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const storage = getStorage();
const backend = process.env.DATABASE_URL ? 'postgres' : 'json';
await storage.wipeAll();
await storage.close();

const uploads = path.join(ROOT, 'public', 'uploads');
let removedImages = 0;
try {
  for (const f of fs.readdirSync(uploads)) {
    if (f.startsWith('seed-')) {
      fs.unlinkSync(path.join(uploads, f));
      removedImages++;
    }
  }
} catch {
  // uploads dir may not exist — fine
}

console.log(`Wiped all data (${backend} backend); removed ${removedImages} seed image(s).`);
