import fs from 'fs';
import path from 'path';

export type ServiceType = 'counter' | 'table' | 'takeout' | 'nonfood';
export type TipBase = 'pre-tax' | 'post-tax' | 'not-sure';

export interface Report {
  id: string;
  venueName: string;
  city: string;
  area: string;
  serviceType: ServiceType;
  screenPresentation: string;
  presets: string;
  tipBase: TipBase | '';
  fees: string[];
  photoPath: string | null;
  notes: string;
  email: string;
  verified: boolean; // photo-backed
  createdAt: string; // ISO
}

export interface VenueSummary {
  id: string; // slugified venue + city
  venueName: string;
  city: string;
  area: string;
  serviceType: ServiceType;
  screenPresentation: string;
  presets: string;
  tipBase: TipBase | '';
  fees: string[];
  reports: number;
  verified: boolean;
  score: number | null; // null = "few reports" (< 3 reports)
  lastUpdated: string;
}

const DB_PATH = path.join(process.cwd(), 'data', 'db.json');

export function readReports(): Report[] {
  try {
    const raw = fs.readFileSync(DB_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Report[]) : [];
  } catch {
    return [];
  }
}

export function writeReports(reports: Report[]): void {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(reports, null, 2), 'utf8');
}

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function slugify(s: string): string {
  return normalize(s)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Most common value; ties broken toward the most recent report. */
function mode<T>(values: T[]): T | '' {
  const counts = new Map<string, { v: T; n: number; last: number }>();
  values.forEach((v, i) => {
    const k = JSON.stringify(v);
    const e = counts.get(k) ?? { v, n: 0, last: 0 };
    e.n += 1;
    e.last = i;
    counts.set(k, e);
  });
  let best: { v: T; n: number; last: number } | null = null;
  for (const e of counts.values()) {
    if (!best || e.n > best.n || (e.n === best.n && e.last > best.last)) best = e;
  }
  return best ? best.v : ('' as unknown as T);
}

/** Extract percentage numbers from free text like "20%, 25%, 30%". */
export function parsePresets(text: string): number[] {
  const out: number[] = [];
  const re = /(\d+(?:\.\d+)?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const n = parseFloat(m[1]);
    if (n > 0 && n < 100) out.push(n);
  }
  return out;
}

export interface ScoreInputs {
  tipBase: TipBase | '';
  serviceType: ServiceType;
  screenPresentation: string;
  minPreset: number | null;
  fees: string[];
}

/**
 * Provisional Truth Score, implemented exactly as specified:
 * - Start at 0
 * - +20 if post-tax calculation
 * - +15 if lowest preset >= 25% (+25 instead if >= 30%)
 * - +15 if counter/takeout prompt exists
 * - +15 if non-food retail prompt exists
 * - +10 if hidden/undeclared fee or surcharge
 * - Cap at 100
 * ("prompt exists" = a tip screen was presented, i.e. not "no-screen".)
 */
export function truthScore(args: ScoreInputs): number {
  let s = 0;
  if (args.tipBase === 'post-tax') s += 20;
  if (args.minPreset !== null) {
    if (args.minPreset >= 30) s += 25;
    else if (args.minPreset >= 25) s += 15;
  }
  const promptExists = args.screenPresentation !== 'no-screen';
  if ((args.serviceType === 'counter' || args.serviceType === 'takeout') && promptExists) s += 15;
  if (args.serviceType === 'nonfood' && promptExists) s += 15;
  const feeSet = new Set(args.fees);
  if (feeSet.has('service-charge') || feeSet.has('card-surcharge') || feeSet.has('other')) s += 10;
  return Math.min(100, s);
}

export function summarize(reports: Report[]): VenueSummary[] {
  const groups = new Map<string, Report[]>();
  for (const r of reports) {
    const key = normalize(r.venueName) + '|' + normalize(r.city);
    const arr = groups.get(key) ?? [];
    arr.push(r);
    groups.set(key, arr);
  }

  const out: VenueSummary[] = [];
  for (const rs of groups.values()) {
    const sorted = [...rs].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const latest = sorted[sorted.length - 1];

    const serviceType = (mode(sorted.map((r) => r.serviceType)) || 'table') as ServiceType;
    const tipBase = (mode(sorted.map((r) => r.tipBase).filter(Boolean)) || '') as TipBase | '';
    const screenPresentation = (mode(
      sorted.map((r) => r.screenPresentation).filter(Boolean),
    ) || '') as string;
    const presets = (mode(sorted.map((r) => r.presets).filter((p) => p.trim())) || '') as string;
    const area = (mode(sorted.map((r) => r.area).filter((a) => a.trim())) || '') as string;

    const feeSet = new Set<string>();
    for (const r of sorted) {
      for (const f of r.fees) {
        if (f && f !== 'none') feeSet.add(f);
      }
    }
    const fees = [...feeSet];

    const allPresets = sorted.flatMap((r) => parsePresets(r.presets));
    const minPreset = allPresets.length > 0 ? Math.min(...allPresets) : null;

    const verified = sorted.some((r) => r.verified);
    const score =
      sorted.length >= 3
        ? truthScore({ tipBase, serviceType, screenPresentation, minPreset, fees })
        : null;

    out.push({
      id: slugify(latest.venueName) + '--' + slugify(latest.city),
      venueName: latest.venueName.trim(),
      city: latest.city.trim(),
      area,
      serviceType,
      screenPresentation,
      presets,
      tipBase,
      fees,
      reports: sorted.length,
      verified,
      score,
      lastUpdated: latest.createdAt,
    });
  }
  return out;
}

export function venueDetail(
  reports: Report[],
  id: string,
): { venue: VenueSummary; reports: Report[] } | null {
  const venue = summarize(reports).find((v) => v.id === id);
  if (!venue) return null;
  const rs = reports
    .filter((r) => slugify(r.venueName) + '--' + slugify(r.city) === id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { venue, reports: rs };
}
