// Applies scripts/migrate.sql to the Postgres database in DATABASE_URL.
// No-op (with a message) when DATABASE_URL is not set — the JSON store needs
// no migration.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const url = process.env.DATABASE_URL;
if (!url) {
  console.log('DATABASE_URL not set — JSON store needs no migration. Nothing to do.');
  process.exit(0);
}

const { Client } = await import('pg');
const sql = fs.readFileSync(path.join(__dirname, 'migrate.sql'), 'utf8');

const client = new Client({
  connectionString: url,
  ssl: /localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: false },
});
await client.connect();
try {
  await client.query(sql);
  console.log('Migration applied.');
} finally {
  await client.end();
}
