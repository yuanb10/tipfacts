# TipFacts — Tipping Facts Database

A crowdsourced web app documenting **objective tipping facts** per venue:
tip-screen presets, pre-tax vs post-tax calculation, counter/table/takeout service,
and extra fees. Facts only — no opinions, no shaming. Seattle first, other cities welcome.

Working title for the project was "TipShame"; the product direction is a neutral
facts database, so the app is branded **TipFacts**.

Privacy rule: **we sell the math, never the receipts.** Receipt originals are
private, PII is redacted before anything is public, and nothing publishes without
uploader confirmation + moderation approval.

## Run it

```bash
npm install
npm run seed   # load 8 fictional Seattle demo venues (clearly marked, easy to wipe)
npm run dev    # -> http://localhost:3000
```

Pages:

- `/` — ranking: search, filter by city / service type, sort by score / reports / name.
- `/submit` — receipt-first report flow: 1) upload evidence, 2) review redaction,
  3) the facts. Nothing publishes until moderation approves.
- `/venue/[id]` — venue detail: evidence-backed Truth Score with "what raised it",
  verified vs community-consensus facts, subjective experiences (never scored),
  redacted evidence gallery.
- `/moderate?key=...` — moderation queue (gated by `MOD_SECRET`, see below).

## Storage: JSON (dev) or Postgres (prod)

Both backends implement the same interface (`lib/storage.ts`).
The backend is selected per invocation: if `DATABASE_URL` is set, Postgres is used;
otherwise the JSON file store.

| Script            | What it does |
| ----------------- | ------------ |
| `npm run migrate` | Apply `scripts/migrate.sql` (Postgres only; no-op message on JSON) |
| `npm run seed`    | Load 8 fictional venues + 28 approved reports (marked `isSeed`) on either backend |
| `npm run wipe`    | Delete all data on either backend (+ remove seed images) |

```bash
# Postgres (example — use your own credentials)
export DATABASE_URL="postgres://USER:PASSWORD@HOST:5432/DBNAME"
npm run migrate && npm run seed
# then run the app with the same DATABASE_URL
```

Environment variables:

- `DATABASE_URL` — Postgres connection string. Unset → JSON file store (`data/db.json`).
- `MOD_SECRET` — shared secret gating `/moderate` and `POST /api/moderate`.
  If unset, moderation shows "not configured". **Set a long random value in prod.**

Rate limiting is durable on both backends (JSON file / `rate_limit_hits` table):
5 submissions per IP hash per rolling hour. Raw IPs are never stored — only
SHA-256 hashes (`reporterHash`, rate-limit keys).

## Evidence pipeline (receipt-first)

1. **Upload** (`POST /api/evidence`, multipart `photo` + `type=receipt|screen`).
   Originals are saved to `data/uploads-private/` — gitignored, never web-served.
2. **OCR + redaction** (if the `tesseract` binary is present; otherwise a manual path).
   Tesseract TSV words → PII boxes (card-number runs incl. spaced
   `4111 1111 1111 1111`, long digit runs, phones, emails, tokens next to
   card/auth/account keywords — over-redaction by default) → blacked-out PNG
   written to `public/uploads/<id>-redacted.png`. Line grouping is geometric
   (y-clustering), because tesseract's `line_num` is unreliable.
   Parsed values (subtotal/tax/tip/total/fees/presets) are extracted, never guessed.
3. **Uploader confirmation** (`POST /api/evidence/[id]/confirm` with
   `{confirmed: true}` + optional corrected `parsed`). The uploader sees
   original vs redacted side by side. Failed/manual OCR requires an explicit
   "I checked this photo for personal info" attestation.
4. **Submission** (`POST /api/submissions`) requires every attached evidence item
   to be `userConfirmed` with `redactionStatus` `confirmed`/`manual`. Reports are
   created `pending`. One photo attaches to one report — reuse is rejected.
5. **Moderation** (`POST /api/moderate`, `MOD_SECRET`-gated) approves/rejects with
   an audit trail (`moderation_actions`). Only approved reports are public.

## Truth score (evidence-only)

Only facts backed by **confirmed, approved evidence** move the score
(`lib/score.ts`):

- Receipt evidence backs: tip base (pre/post-tax) and fees.
- Tip-screen evidence backs: presets, service type, screen presentation.
- +20 post-tax · +15 lowest preset ≥25% (+25 if ≥30%) · +15 counter/takeout prompt ·
  +15 non-food retail prompt · +10 hidden/undeclared surcharge · cap 100.
- No usable evidence → **"Awaiting evidence"** — never a made-up number.
- Unverified community consensus is shown separately, labeled as such.
- Guilt/pressure answers and experience notes are subjective, displayed apart,
  and **never scored**.

## SEO

- Stable venue slugs (`/venue/<slug>--<city-slug>`), per-venue `<title>`/description.
- `/sitemap.xml` (all public venue URLs) and `/robots.txt`.

## Tech choices

- **Next.js (App Router) + React + TypeScript**, plain CSS, no UI framework.
- **No auth, no accounts, no analytics, no external API calls.**
- Tesseract OCR is an optional system dependency (`apt install tesseract-ocr`);
  the app degrades to the manual redaction path without it.
- `.ts`-extension imports in `lib/` + `scripts/` work under both Next
  (`allowImportingTsExtensions` in tsconfig) and plain node type-stripping.

## What's stubbed / TODO before any real launch

- **Uploads**: local disk only. On Vercel the filesystem is ephemeral — migrate to
  S3/R2/Blob storage and store URLs instead of `/uploads/...` paths.
  `data/uploads-private/` must move to private object storage too.
- **Database**: set `DATABASE_URL` to a managed Postgres (e.g. Neon) in prod.
- **Moderation**: single shared `MOD_SECRET`; no per-moderator accounts, no dedup UI,
  no venue-claim flow. Seed data is fictional and clearly labeled — wipe before launch.
- **OCR**: tesseract only; no barcode/QR detection — the confirm step must always
  let the uploader attest or flag those.
- **Rate limiting**: 5/hour/IP-hash; tune for production traffic.

## Data pipeline: merging with the Google Form / Sheet

We also collect reports via a Google Form into a Google Sheet whose cleaned
**Facts** tab has these columns:

`Venue | City | Area | Service type | Screen presentation | Presets | Tip base (pre/post) | Fees | Reports | Truth score (0–100) | Verified? | Last updated`

How app data maps to those columns (do not touch the Form/Sheet from here):

| Facts column        | App source                                              |
| ------------------- | ------------------------------------------------------- |
| Venue               | report `venueName` (grouped, case-insensitive)          |
| City                | report `city`                                           |
| Area                | report `area` (most common value)                        |
| Service type        | report `serviceType` (most common value)                |
| Screen presentation | report `screenPresentation` (most common value)         |
| Presets             | report `presets` (most common raw text)                 |
| Tip base (pre/post) | report `tipBase` (most common value)                    |
| Fees                | report `fees` (union across reports, minus "none")      |
| Reports             | report count per venue                                  |
| Truth score (0–100) | evidence-only score over approved reports (see above)   |
| Verified?           | any confirmed-evidence-backed report → verified         |
| Last updated        | latest report `createdAt`                               |

Merge strategy (not implemented): export app reports as rows, dedupe against
Sheet rows on normalized (venue, city), keep the union of reports, and recompute
the score with the same evidence-only function so both sources score identically.
