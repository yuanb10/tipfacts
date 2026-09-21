# TipFacts — Tipping Facts Database

A minimal crowdsourced web app documenting **objective tipping facts** per venue:
tip-screen presets, pre-tax vs post-tax calculation, counter/table/takeout service,
and extra fees. Facts only — no opinions, no shaming. Seattle first, other cities welcome.

Working title for the project was "TipShame"; the product direction is a neutral
facts database, so the app is branded **TipFacts**.

## Run it

```bash
npm install
npm run seed   # load 8 fictional Seattle demo venues (easy to wipe)
npm run dev    # -> http://localhost:3000
```

- `npm run wipe` — delete all reports (and seed images); the ranking page goes empty.
- `npm run build` / `npm start` — production build, Vercel-deployable as-is.

Pages:

- `/` — ranking: search, filter by city / service type, sort by score / reports / name.
  Click a venue for its detail page.
- `/submit` — the 11-field report form (mirrors the Google Form).
- `/venue/[id]` — venue detail: aggregated facts, truth score, verification status,
  and every individual report.

## Tech choices

- **Next.js (App Router) + React + TypeScript**, plain CSS, no UI framework.
- **JSON file store** (`data/db.json`) instead of SQLite — zero native dependencies,
  boring and simple for a 1–2 day scope. Reads/writes are synchronous per request,
  which is fine at this scale.
- **Photos** are stored locally under `public/uploads/` and served statically.
- **No auth, no accounts, no analytics, no external API calls.**

### Anti-spam (basic)

- Rate limit: 5 submissions per IP per rolling hour (in-memory, in
  `app/api/venues/route.ts`).
- Honeypot field (`website`) — invisible to humans; bots that fill it get a fake
  success and nothing is saved.

## Truth score (provisional)

Implemented exactly as specified in `lib/store.ts` (`truthScore`):

- Start at 0.
- +20 if the tip is calculated on the **post-tax** total.
- +15 if the lowest preset is ≥25% (+25 instead if ≥30%).
- +15 if a counter/takeout tip prompt exists.
- +15 if a non-food retail tip prompt exists.
- +10 if a hidden/undeclared fee or surcharge is reported.
- Capped at 100.

Rules around it:

- Fewer than 3 reports → the venue shows **"Few reports"** instead of a firm score.
- Photo-backed reports count as **verified**; text-only as **unverified**
  (displayed as a badge, not factored into the score).
- Reports are grouped by venue name + city (case/whitespace-insensitive).
  Categorical facts use the most common value (ties → most recent report);
  presets use the lowest value seen across reports; fees are unioned.

## What's stubbed / TODO before any real launch

- **Uploads**: local disk only. On Vercel the filesystem is ephemeral — migrate to
  S3/R2/Blob storage and store URLs instead of `/uploads/...` paths.
- **Database**: `data/db.json` does not survive redeploys and won't handle
  concurrent writes. Migrate to Postgres (e.g. Neon) before real traffic.
- **Moderation**: no review queue, no dedup UI, no venue-claim flow. Seed data is
  fictional and clearly labeled ("Demo Diner" etc.) — wipe before launch.
- **PII**: photo uploads are stored as-is. The Google Form flow promises manual
  blurring; the app has no redaction step yet.
- **Rate limiting** is in-memory — it resets on redeploy and is per-instance.

## Data pipeline: merging with the Google Form / Sheet

We also collect reports via a Google Form into a Google Sheet whose cleaned
**Facts** tab has these columns:

`Venue | City | Area | Service type | Screen presentation | Presets | Tip base (pre/post) | Fees | Reports | Truth score (0–100) | Verified? | Last updated`

How app data maps to those columns (do not touch the Form/Sheet from here):

| Facts column        | App source                                              |
| ------------------- | ------------------------------------------------------- |
| Venue               | report `venueName` (grouped, case-insensitive)          |
| City                | report `city`                                           |
| Area                | report `area` (most common value)                       |
| Service type        | report `serviceType` (most common value)                |
| Screen presentation | report `screenPresentation` (most common value)         |
| Presets             | report `presets` (most common raw text)                 |
| Tip base (pre/post) | report `tipBase` (most common value)                    |
| Fees                | report `fees` (union across reports, minus "none")      |
| Reports             | report count per venue                                  |
| Truth score (0–100) | `truthScore()` over the aggregated facts (see above)    |
| Verified?           | any photo-backed report → verified                      |
| Last updated        | latest report `createdAt`                               |

Merge strategy (not implemented): export app reports as rows, dedupe against
Sheet rows on normalized (venue, city), keep the union of reports, and recompute
the score with the same `truthScore()` function so both sources score identically.
