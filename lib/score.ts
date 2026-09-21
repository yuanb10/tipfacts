/**
 * TipFacts Sprint 1 scoring.
 *
 * The Truth Score is computed ONLY from photo-verified facts: evidence that the
 * uploader confirmed (userConfirmed === true && redactionStatus === 'confirmed').
 * Evidence-type → fact mapping:
 *   - tipBase              ← confirmed RECEIPT evidence
 *   - presets / minPreset  ← confirmed SCREEN evidence (report presets string + parsed.presets)
 *   - counter/takeout prompt, nonfood prompt ← confirmed SCREEN evidence
 *   - fees                 ← confirmed RECEIPT evidence (report fees + parsed fee labels)
 * Median *reported* tip % is labeled "reported" and is NEVER part of the score.
 */

import type {
  Evidence,
  ModerationAction,
  Report,
  ServiceType,
  TipBase,
  Venue,
} from '@/lib/storage';
import { getStorage } from '@/lib/storage';

export interface ScoreComponent {
  key: 'post-tax' | 'min-preset' | 'counter-takeout-prompt' | 'nonfood-prompt' | 'hidden-fee';
  points: number;
  label: string;
  evidenceIds: string[];
}

export interface VenueScore {
  score: number;
  components: ScoreComponent[];
  evidenceCount: number;
}

export interface VenueCard {
  venue: Venue;
  score: VenueScore | null;
  approvedCount: number;
  unverifiedCount: number; // approved but zero confirmed evidence
  lastUpdated: string; // ISO
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

/** Most common value; ties broken toward the most recent entry (callers pass
 *  values in chronological order). */
export function mode<T>(values: T[]): T | '' {
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

/** Photo-verified: uploader confirmed AND redaction finalized. */
export function isConfirmed(e: Evidence | null | undefined): e is Evidence {
  return !!e && e.userConfirmed === true && e.redactionStatus === 'confirmed';
}

const BACKING_FEE_KEYS = new Set(['service-charge', 'card-surcharge', 'other']);

/** Map a parsed receipt fee label to a canonical fee key. */
export function feeKeyFromLabel(label: string): string {
  const l = label.toLowerCase();
  if (l.includes('service')) return 'service-charge';
  if (l.includes('card') || l.includes('credit') || l.includes('surcharge')) return 'card-surcharge';
  return 'other';
}

/** Normalizes a fee chip value to a canonical key (already canonical or parsed label). */
function feeKey(value: string): string {
  if (BACKING_FEE_KEYS.has(value) || value === 'none') return value;
  return feeKeyFromLabel(value);
}

export interface BackedFacts {
  tipBase: TipBase | '';
  minPreset: number | null;
  presets: number[]; // all backed preset values, for display
  serviceType: ServiceType | '';
  screenPresentation: string;
  fees: string[];
  receiptEvidenceIds: string[];
  screenEvidenceIds: string[];
  confirmedEvidenceIds: string[];
}

/**
 * Aggregate evidence-backed facts across approved reports.
 * Only facts backed by ≥1 confirmed evidence of the matching type count.
 * `reports` should be in chronological order (oldest first) for tie-breaking.
 */
export function aggregateBackedFacts(
  reports: Report[],
  evidenceById: Map<string, Evidence>,
): BackedFacts {
  const tipBasePool: TipBase[] = [];
  const presetPool: number[] = [];
  const servicePool: ServiceType[] = [];
  const screenPool: string[] = [];
  const feePool: string[] = [];
  const receiptEvidenceIds: string[] = [];
  const screenEvidenceIds: string[] = [];

  for (const r of reports) {
    const confirmed = r.evidenceIds
      .map((id) => evidenceById.get(id))
      .filter(isConfirmed);
    const receipts = confirmed.filter((e) => e.type === 'receipt');
    const screens = confirmed.filter((e) => e.type === 'screen');

    if (receipts.length > 0) {
      for (const e of receipts) {
        receiptEvidenceIds.push(e.id);
        for (const f of e.parsed?.fees ?? []) {
          feePool.push(feeKey(f.label));
        }
      }
      if (r.tipBase) tipBasePool.push(r.tipBase);
      for (const f of r.fees) {
        if (f && f !== 'none') feePool.push(feeKey(f));
      }
    }

    if (screens.length > 0) {
      for (const e of screens) {
        screenEvidenceIds.push(e.id);
        for (const p of e.parsed?.presets ?? []) {
          if (p > 0 && p < 100) presetPool.push(p);
        }
      }
      servicePool.push(r.serviceType);
      if (r.screenPresentation) screenPool.push(r.screenPresentation);
      presetPool.push(...parsePresets(r.presets));
    }
  }

  const dedupe = (arr: string[]) => [...new Set(arr)];

  return {
    tipBase: (mode(tipBasePool) || '') as TipBase | '',
    minPreset: presetPool.length > 0 ? Math.min(...presetPool) : null,
    presets: [...new Set(presetPool)].sort((a, b) => a - b),
    serviceType: (mode(servicePool) || '') as ServiceType | '',
    screenPresentation: (mode(screenPool) || '') as string,
    fees: dedupe(feePool.filter((f) => f && f !== 'none')),
    receiptEvidenceIds: dedupe(receiptEvidenceIds),
    screenEvidenceIds: dedupe(screenEvidenceIds),
    confirmedEvidenceIds: dedupe([...receiptEvidenceIds, ...screenEvidenceIds]),
  };
}

/**
 * Provisional Truth Score, kept exactly as specified:
 *   start 0
 *   +20 post-tax calculation
 *   +15 if lowest preset >= 25% (+25 instead if >= 30%)
 *   +15 counter/takeout prompt (serviceType counter|takeout AND screen != 'no-screen')
 *   +15 non-food retail prompt (serviceType nonfood AND screen != 'no-screen')
 *   +10 hidden/undeclared surcharge (fees include service-charge|card-surcharge|other)
 *   cap 100
 * Returns null ("awaiting evidence") when no evidence-backed component fires.
 */
export function computeVenueScore(
  approvedReports: Report[],
  evidenceById: Map<string, Evidence>,
): VenueScore | null {
  const b = aggregateBackedFacts(approvedReports, evidenceById);
  const components: ScoreComponent[] = [];

  if (b.tipBase === 'post-tax') {
    components.push({
      key: 'post-tax',
      points: 20,
      label: 'Tip calculated on the post-tax total',
      evidenceIds: b.receiptEvidenceIds,
    });
  }
  if (b.minPreset !== null && b.minPreset >= 25) {
    components.push({
      key: 'min-preset',
      points: b.minPreset >= 30 ? 25 : 15,
      label: `Lowest tip preset is ${b.minPreset}%`,
      evidenceIds: b.screenEvidenceIds,
    });
  }
  const promptExists = b.screenPresentation !== 'no-screen';
  if ((b.serviceType === 'counter' || b.serviceType === 'takeout') && promptExists) {
    components.push({
      key: 'counter-takeout-prompt',
      points: 15,
      label: 'Tip prompt presented at counter / takeout',
      evidenceIds: b.screenEvidenceIds,
    });
  }
  if (b.serviceType === 'nonfood' && promptExists) {
    components.push({
      key: 'nonfood-prompt',
      points: 15,
      label: 'Tip prompt presented at non-food retail',
      evidenceIds: b.screenEvidenceIds,
    });
  }
  if (b.fees.some((f) => BACKING_FEE_KEYS.has(f))) {
    components.push({
      key: 'hidden-fee',
      points: 10,
      label: 'Hidden or undeclared fee / surcharge',
      evidenceIds: b.receiptEvidenceIds,
    });
  }

  if (components.length === 0) return null;

  const score = Math.min(
    100,
    components.reduce((sum, c) => sum + c.points, 0),
  );
  const evidenceCount = new Set(components.flatMap((c) => c.evidenceIds)).size;
  return { score, components, evidenceCount };
}

/**
 * Median of parsed.tipPercentReported across confirmed receipt evidence.
 * This is *reported* data, never truth — never scored.
 */
export function medianReportedTip(
  approvedReports: Report[],
  evidenceById: Map<string, Evidence>,
): number | null {
  const values: number[] = [];
  for (const r of approvedReports) {
    for (const id of r.evidenceIds) {
      const e = evidenceById.get(id);
      if (isConfirmed(e) && e.type === 'receipt') {
        const p = e.parsed?.tipPercentReported;
        if (typeof p === 'number' && Number.isFinite(p) && p >= 0) values.push(p);
      }
    }
  }
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * How often each fee key appears across confirmed receipt evidence
 * (parsed fee labels only — reported evidence, not scored).
 */
export function feeFrequency(
  approvedReports: Report[],
  evidenceById: Map<string, Evidence>,
): { fee: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const r of approvedReports) {
    for (const id of r.evidenceIds) {
      const e = evidenceById.get(id);
      if (isConfirmed(e) && e.type === 'receipt') {
        const keys = new Set((e.parsed?.fees ?? []).map((f) => feeKey(f.label)));
        for (const k of keys) {
          if (!k || k === 'none') continue;
          counts.set(k, (counts.get(k) ?? 0) + 1);
        }
      }
    }
  }
  return [...counts.entries()]
    .map(([fee, count]) => ({ fee, count }))
    .sort((a, b) => b.count - a.count || a.fee.localeCompare(b.fee));
}

export function guiltStats(approvedReports: Report[]): { yes: number; no: number; skipped: number } {
  const out = { yes: 0, no: 0, skipped: 0 };
  for (const r of approvedReports) {
    if (r.guilt === 'yes') out.yes += 1;
    else if (r.guilt === 'no') out.no += 1;
    else out.skipped += 1;
  }
  return out;
}

/** Reports that have zero confirmed evidence attached (approved but unevidenced). */
export function hasConfirmedEvidence(r: Report, evidenceById: Map<string, Evidence>): boolean {
  return r.evidenceIds.some((id) => isConfirmed(evidenceById.get(id)));
}

export function summarizeVenues(
  venues: Venue[],
  approvedReports: Report[],
  evidenceById: Map<string, Evidence>,
): VenueCard[] {
  const byVenue = new Map<string, Report[]>();
  for (const r of approvedReports) {
    const arr = byVenue.get(r.venueId) ?? [];
    arr.push(r);
    byVenue.set(r.venueId, arr);
  }
  for (const arr of byVenue.values()) {
    arr.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  return venues.map((venue) => {
    const rs = byVenue.get(venue.id) ?? [];
    const unverifiedCount = rs.filter((r) => !hasConfirmedEvidence(r, evidenceById)).length;
    const lastUpdated =
      rs.length > 0 ? rs[rs.length - 1].createdAt : venue.createdAt;
    return {
      venue,
      score: computeVenueScore(rs, evidenceById),
      approvedCount: rs.length,
      unverifiedCount,
      lastUpdated,
    };
  });
}

/** Community consensus (all approved reports, evidence-backed or not) for display labels. */
export interface ConsensusFacts {
  serviceType: ServiceType | '';
  screenPresentation: string;
  presetsText: string;
  tipBase: TipBase | '';
  fees: string[];
}

export function aggregateConsensus(reports: Report[]): ConsensusFacts {
  const sorted = [...reports].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const feeSet = new Set<string>();
  for (const r of sorted) {
    for (const f of r.fees) {
      if (f && f !== 'none') feeSet.add(feeKey(f));
    }
  }
  return {
    serviceType: (mode(sorted.map((r) => r.serviceType)) || '') as ServiceType | '',
    screenPresentation: (mode(sorted.map((r) => r.screenPresentation).filter(Boolean)) || '') as string,
    presetsText: (mode(sorted.map((r) => r.presets).filter((p) => p.trim())) || '') as string,
    tipBase: (mode(sorted.map((r) => r.tipBase).filter(Boolean)) || '') as TipBase | '',
    fees: [...feeSet],
  };
}

// ---------------------------------------------------------------------------
// Venue detail assembly (shared by the venue page and the venue API route)
// ---------------------------------------------------------------------------

export interface SanitizedReport {
  id: string;
  venueId: string;
  venueName: string;
  city: string;
  area: string;
  serviceType: ServiceType;
  screenPresentation: string;
  presets: string;
  tipBase: TipBase | '';
  fees: string[];
  guilt: 'yes' | 'no' | 'skip';
  experienceNote: string;
  notes: string;
  moderationStatus: 'approved';
  decidedAt: string | null;
  isSeed: boolean;
  createdAt: string;
  confirmedEvidenceIds: string[];
}

export interface PublicEvidence {
  id: string;
  reportId: string | null;
  type: 'receipt' | 'screen';
  redactedPath: string | null;
  redactionStatus: string;
  parsed: Evidence['parsed'];
  isSeed: boolean;
  createdAt: string;
}

export interface FactRow {
  term: string;
  value: string;
  /** 'verified' = backed by confirmed evidence; 'consensus' = community consensus only */
  kind: 'verified' | 'consensus';
}

export interface VenueDetail {
  venue: Venue;
  score: VenueScore | null;
  approvedCount: number;
  unverifiedCount: number;
  backedFacts: BackedFacts;
  consensusFacts: ConsensusFacts;
  factRows: FactRow[];
  reports: SanitizedReport[]; // newest first
  unevidencedReports: SanitizedReport[]; // newest first
  evidence: PublicEvidence[];
  guiltStats: { yes: number; no: number; skipped: number };
  guiltNotes: { id: string; note: string; createdAt: string }[];
  receiptStats: { medianReportedTip: number | null; feeFrequency: { fee: string; count: number }[] };
  changelog: ModerationAction[];
  lastUpdated: string;
}

export function sanitizeReport(r: Report, evidenceById: Map<string, Evidence>): SanitizedReport {
  return {
    id: r.id,
    venueId: r.venueId,
    venueName: r.venueName,
    city: r.city,
    area: r.area,
    serviceType: r.serviceType,
    screenPresentation: r.screenPresentation,
    presets: r.presets,
    tipBase: r.tipBase,
    fees: r.fees,
    guilt: r.guilt,
    experienceNote: r.experienceNote,
    notes: r.notes,
    moderationStatus: 'approved',
    decidedAt: r.decidedAt,
    isSeed: r.isSeed,
    createdAt: r.createdAt,
    confirmedEvidenceIds: r.evidenceIds.filter((id) => isConfirmed(evidenceById.get(id))),
  };
}

export function sanitizeEvidence(e: Evidence): PublicEvidence {
  return {
    id: e.id,
    reportId: e.reportId,
    type: e.type,
    redactedPath: e.redactedPath,
    redactionStatus: e.redactionStatus,
    parsed: e.parsed,
    isSeed: e.isSeed,
    createdAt: e.createdAt,
  };
}

function fmtPresets(nums: number[]): string {
  return nums.map((n) => (Number.isInteger(n) ? n + '%' : n.toFixed(1) + '%')).join(', ');
}

export function buildFactRows(backed: BackedFacts, consensus: ConsensusFacts): FactRow[] {
  const rows: FactRow[] = [];
  if (backed.serviceType) {
    rows.push({ term: 'Service type', value: backed.serviceType, kind: 'verified' });
  } else if (consensus.serviceType) {
    rows.push({ term: 'Service type', value: consensus.serviceType, kind: 'consensus' });
  }
  if (backed.screenPresentation) {
    rows.push({ term: 'Screen presentation', value: backed.screenPresentation, kind: 'verified' });
  } else if (consensus.screenPresentation) {
    rows.push({
      term: 'Screen presentation',
      value: consensus.screenPresentation,
      kind: 'consensus',
    });
  }
  if (backed.presets.length > 0) {
    rows.push({ term: 'Tip presets', value: fmtPresets(backed.presets), kind: 'verified' });
  } else if (consensus.presetsText) {
    rows.push({ term: 'Tip presets', value: consensus.presetsText, kind: 'consensus' });
  }
  if (backed.tipBase) {
    rows.push({ term: 'Tip calculated on', value: backed.tipBase, kind: 'verified' });
  } else if (consensus.tipBase) {
    rows.push({ term: 'Tip calculated on', value: consensus.tipBase, kind: 'consensus' });
  }
  const fees = backed.fees.length > 0 ? backed.fees : consensus.fees;
  rows.push({
    term: 'Extra fees',
    value: fees.length > 0 ? fees.join(', ') : 'None reported',
    kind: backed.fees.length > 0 ? 'verified' : 'consensus',
  });
  return rows;
}

export async function getVenueDetail(id: string): Promise<VenueDetail | null> {
  const store = getStorage();

  const venue = await store.getVenue(id);
  if (!venue) return null;

  const approved = (await store.listReports({ venueId: id, status: 'approved' })).sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );

  const evidenceById = new Map<string, Evidence>();
  const evidenceLists = await Promise.all(
    approved.map((r) => store.listEvidenceForReport(r.id)),
  );
  for (const list of evidenceLists) {
    for (const e of list) evidenceById.set(e.id, e);
  }

  const score = computeVenueScore(approved, evidenceById);
  const backed = aggregateBackedFacts(approved, evidenceById);
  const consensus = aggregateConsensus(approved);

  const sanitized = approved
    .map((r) => sanitizeReport(r, evidenceById))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const unevidencedReports = sanitized.filter((r) => r.confirmedEvidenceIds.length === 0);
  const evidence = [...evidenceById.values()]
    .filter(isConfirmed)
    .map(sanitizeEvidence)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const changelogLists = await Promise.all(
    approved.map((r) => store.listModerationActions(r.id)),
  );
  const changelog = changelogLists
    .flat()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const guiltNotes = approved
    .filter((r) => r.experienceNote.trim())
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((r) => ({ id: r.id, note: r.experienceNote.trim(), createdAt: r.createdAt }));

  return {
    venue,
    score,
    approvedCount: approved.length,
    unverifiedCount: unevidencedReports.length,
    backedFacts: backed,
    consensusFacts: consensus,
    factRows: buildFactRows(backed, consensus),
    reports: sanitized,
    unevidencedReports,
    evidence,
    guiltStats: guiltStats(approved),
    guiltNotes,
    receiptStats: {
      medianReportedTip: medianReportedTip(approved, evidenceById),
      feeFrequency: feeFrequency(approved, evidenceById),
    },
    changelog,
    lastUpdated:
      approved.length > 0 ? approved[approved.length - 1].createdAt : venue.createdAt,
  };
}
