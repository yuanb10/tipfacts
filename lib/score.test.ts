/**
 * Unit tests for the Squeeze Score v2 rubric (locked 2026-09-22, PRD §5.2 S.2).
 *
 * All fixtures go through the real pipeline — synthetic Report/Evidence
 * objects → aggregateBackedFacts → computeVenueScore — the same path the app
 * uses in getVenueDetail/summarizeVenues. No dependency on data/db.json.
 *
 * NOTE: guilt tipping is the one community-reported (non-photo) signal by
 * design: it fires on ≥2 approved "yes" reports from distinct reporters and
 * does not require confirmed photo evidence (labeled "community-reported").
 */
import { describe, expect, it } from 'vitest';
import type { Evidence, Report } from '@/lib/storage';
import {
  aggregateBackedFacts,
  computeVenueScore,
  parsePresets,
} from './score';

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

let seq = 0;
const nextId = (p: string) => `${p}-${++seq}-test`;

function baseReport(over: Partial<Report> & { id: string }): Report {
  return {
    venueId: 'test-venue',
    venueName: 'Test Venue',
    city: 'Seattle',
    area: '',
    serviceDate: '',
    serviceType: 'table',
    screenPresentation: '',
    presets: '',
    tipBase: '',
    fees: [],
    guilt: 'skip',
    easyOptOut: 'skip',
    experienceNote: '',
    notes: '',
    evidenceIds: [],
    moderationStatus: 'approved',
    moderationNote: '',
    decidedAt: null,
    reporterHash: '',
    isSeed: false,
    createdAt: '2026-09-22T00:00:00.000Z',
    ...over,
  };
}

function confirmedEvidence(
  over: Partial<Evidence> & { id: string; type: 'receipt' | 'screen' },
): Evidence {
  return {
    reportId: null,
    originalPath: 'data/uploads-private/x.png',
    redactedPath: '/uploads/x-redacted.png',
    redactionStatus: 'confirmed',
    userConfirmed: true,
    parsed: null,
    isSeed: false,
    createdAt: '2026-09-22T00:00:00.000Z',
    ...over,
  };
}

function parsedWith(opts: {
  fees?: { label: string; amount: number | null }[];
  presets?: number[];
}): Evidence['parsed'] {
  return {
    merchant: null,
    purchasedAt: null,
    subtotal: null,
    tax: null,
    tip: null,
    total: null,
    fees: opts.fees ?? [],
    presets: opts.presets ?? [],
    tipPercentReported: null,
    rawText: null,
  };
}

/**
 * Mimics the app callers (getVenueDetail, summarizeVenues): only approved
 * reports reach computeVenueScore, evidence passed as an id→evidence map.
 */
function scoreFor(reports: Report[], evidence: Evidence[]) {
  const approved = reports.filter((r) => r.moderationStatus === 'approved');
  const evidenceById = new Map(evidence.map((e) => [e.id, e]));
  return computeVenueScore(approved, evidenceById);
}

function backedFor(reports: Report[], evidence: Evidence[]) {
  const evidenceById = new Map(evidence.map((e) => [e.id, e]));
  return aggregateBackedFacts(reports, evidenceById);
}

/** One approved table-service report with a confirmed screen and given presets text. */
function tableReportWithPresets(presets: string) {
  const evId = nextId('ev-screen');
  const rId = nextId('r');
  const ev = confirmedEvidence({ id: evId, type: 'screen' });
  const r = baseReport({
    id: rId,
    serviceType: 'table',
    screenPresentation: 'handed-over',
    presets,
    evidenceIds: [evId],
  });
  return { r, ev };
}

// ---------------------------------------------------------------------------
// parsePresets sanity
// ---------------------------------------------------------------------------

describe('parsePresets', () => {
  it('parses "20%, 25%, 30%" into [20, 25, 30]', () => {
    expect(parsePresets('20%, 25%, 30%')).toEqual([20, 25, 30]);
  });
});

// ---------------------------------------------------------------------------
// Table service preset tiers (locked rubric: ≤15 → +0; 16–18 → +15; >18 → +30)
// ---------------------------------------------------------------------------

describe('table service preset tiers', () => {
  it('lowest preset 15% contributes +0 (no component fires)', () => {
    const { r, ev } = tableReportWithPresets('15%, 18%, 20%');
    expect(backedFor([r], [ev]).minPreset).toBe(15);
    expect(scoreFor([r], [ev])).toBeNull();
  });

  it('lowest preset 15% stays +0 even when other components fire', () => {
    const { r, ev } = tableReportWithPresets('15%, 18%, 20%');
    // Two corroborated guilt reports add +15; the 15% preset must add nothing.
    const g1 = baseReport({ id: nextId('r'), guilt: 'yes', reporterHash: 'h1' });
    const g2 = baseReport({ id: nextId('r'), guilt: 'yes', reporterHash: 'h2' });
    const score = scoreFor([r, g1, g2], [ev]);
    expect(score?.score).toBe(15);
    expect(score?.components.map((c) => c.key)).toEqual(['guilt-corroborated']);
  });

  it('lowest preset 16% → +15', () => {
    const { r, ev } = tableReportWithPresets('16%, 20%, 25%');
    const score = scoreFor([r], [ev]);
    expect(score?.score).toBe(15);
    expect(score?.components).toHaveLength(1);
    expect(score?.components[0]).toMatchObject({ key: 'table-preset', points: 15 });
  });

  it('lowest preset 18% → +15', () => {
    const { r, ev } = tableReportWithPresets('18%, 20%, 25%');
    const score = scoreFor([r], [ev]);
    expect(score?.score).toBe(15);
    expect(score?.components[0]).toMatchObject({ key: 'table-preset', points: 15 });
  });

  it('lowest preset 18.5% → +30', () => {
    const { r, ev } = tableReportWithPresets('18.5%, 22%');
    const score = scoreFor([r], [ev]);
    expect(score?.score).toBe(30);
    expect(score?.components[0]).toMatchObject({ key: 'table-preset', points: 30 });
  });

  it('lowest preset 19% → +30', () => {
    const { r, ev } = tableReportWithPresets('19%, 22%, 30%');
    const score = scoreFor([r], [ev]);
    expect(score?.score).toBe(30);
    expect(score?.components[0]).toMatchObject({ key: 'table-preset', points: 30 });
  });

  it('no preset data → +0 (no component fires)', () => {
    const { r, ev } = tableReportWithPresets('');
    expect(backedFor([r], [ev]).minPreset).toBeNull();
    expect(scoreFor([r], [ev])).toBeNull();
  });

  it('presets parsed from confirmed screen evidence feed minPreset', () => {
    const evId = nextId('ev-screen');
    const rId = nextId('r');
    const ev = confirmedEvidence({
      id: evId,
      type: 'screen',
      parsed: parsedWith({ presets: [16, 20] }),
    });
    const r = baseReport({
      id: rId,
      serviceType: 'table',
      screenPresentation: 'handed-over',
      presets: '',
      evidenceIds: [evId],
    });
    const score = scoreFor([r], [ev]);
    expect(score?.score).toBe(15);
    expect(score?.components[0]).toMatchObject({ key: 'table-preset', points: 15 });
  });
});

// ---------------------------------------------------------------------------
// Counter / takeout / non-food (+25 any tip prompt; +10 no easy opt-out)
// ---------------------------------------------------------------------------

describe('counter / takeout / non-food', () => {
  function counterReport(
    serviceType: 'counter' | 'takeout' | 'nonfood',
    over: Partial<Report> = {},
  ) {
    const evId = nextId('ev-screen');
    const rId = nextId('r');
    const ev = confirmedEvidence({ id: evId, type: 'screen' });
    const r = baseReport({
      id: rId,
      serviceType,
      screenPresentation: 'handed-over',
      evidenceIds: [evId],
      ...over,
    });
    return { r, ev };
  }

  it('counter with a tip prompt → +25', () => {
    const { r, ev } = counterReport('counter');
    const score = scoreFor([r], [ev]);
    expect(score?.score).toBe(25);
    expect(score?.components[0]).toMatchObject({
      key: 'counter-takeout-prompt',
      points: 25,
    });
  });

  it('takeout with a tip prompt → +25', () => {
    const { r, ev } = counterReport('takeout');
    expect(scoreFor([r], [ev])?.score).toBe(25);
  });

  it('non-food with a tip prompt → +25 (nonfood-prompt key)', () => {
    const { r, ev } = counterReport('nonfood');
    const score = scoreFor([r], [ev]);
    expect(score?.score).toBe(25);
    expect(score?.components[0]).toMatchObject({ key: 'nonfood-prompt', points: 25 });
  });

  it('no-screen presentation → +0 (no component fires)', () => {
    const { r, ev } = counterReport('counter', { screenPresentation: 'no-screen' });
    expect(scoreFor([r], [ev])).toBeNull();
  });

  it("easyOptOut 'no' → +10 more (total 35)", () => {
    const { r, ev } = counterReport('counter', { easyOptOut: 'no' });
    const score = scoreFor([r], [ev]);
    expect(score?.score).toBe(35);
    expect(score?.components).toHaveLength(2);
    expect(score?.components[1]).toMatchObject({ key: 'no-easy-optout', points: 10 });
  });

  it("easyOptOut 'yes' → +0 more (total 25)", () => {
    const { r, ev } = counterReport('counter', { easyOptOut: 'yes' });
    const score = scoreFor([r], [ev]);
    expect(score?.score).toBe(25);
    expect(score?.components.map((c) => c.key)).toEqual(['counter-takeout-prompt']);
  });
});

// ---------------------------------------------------------------------------
// Post-tax tip calculation (+20; pre-tax → +0)
// ---------------------------------------------------------------------------

describe('post-tax tip calculation', () => {
  function receiptReport(tipBase: Report['tipBase'], confirmed = true) {
    const evId = nextId('ev-receipt');
    const rId = nextId('r');
    const ev = confirmedEvidence({ id: evId, type: 'receipt' });
    if (!confirmed) ev.redactionStatus = 'pending';
    const r = baseReport({ id: rId, tipBase, evidenceIds: [evId] });
    return { r, ev };
  }

  it('post-tax with confirmed receipt → +20', () => {
    const { r, ev } = receiptReport('post-tax');
    const score = scoreFor([r], [ev]);
    expect(score?.score).toBe(20);
    expect(score?.components[0]).toMatchObject({ key: 'post-tax', points: 20 });
  });

  it('pre-tax → +0 (no component fires)', () => {
    const { r, ev } = receiptReport('pre-tax');
    expect(scoreFor([r], [ev])).toBeNull();
  });

  it('post-tax on an unconfirmed receipt → +0 (evidence-only)', () => {
    const { r, ev } = receiptReport('post-tax', false);
    expect(scoreFor([r], [ev])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Extra fee ladder: first +10, each additional +5
// ---------------------------------------------------------------------------

describe('extra fee ladder', () => {
  function feesReport(fees: string[]) {
    const evId = nextId('ev-receipt');
    const rId = nextId('r');
    const ev = confirmedEvidence({ id: evId, type: 'receipt' });
    const r = baseReport({ id: rId, fees, evidenceIds: [evId] });
    return { r, ev };
  }

  it('0 fees → +0 (no component fires)', () => {
    const { r, ev } = feesReport([]);
    expect(scoreFor([r], [ev])).toBeNull();
  });

  it('1 fee → +10', () => {
    const { r, ev } = feesReport(['service-charge']);
    const score = scoreFor([r], [ev]);
    expect(score?.score).toBe(10);
    expect(score?.components[0]).toMatchObject({ key: 'fees', points: 10 });
  });

  it('2 fees → +15', () => {
    const { r, ev } = feesReport(['service-charge', 'card-surcharge']);
    const score = scoreFor([r], [ev]);
    expect(score?.score).toBe(15);
    expect(score?.components[0]).toMatchObject({ key: 'fees', points: 15 });
  });

  it('3 fees → +20', () => {
    const { r, ev } = feesReport(['service-charge', 'card-surcharge', 'other']);
    const score = scoreFor([r], [ev]);
    expect(score?.score).toBe(20);
    expect(score?.components[0]).toMatchObject({ key: 'fees', points: 20 });
  });

  it("'none' fee chips are ignored → +0", () => {
    const { r, ev } = feesReport(['none']);
    expect(scoreFor([r], [ev])).toBeNull();
  });

  it('a parsed receipt fee label maps to a fee key (service charge → +10)', () => {
    const evId = nextId('ev-receipt');
    const rId = nextId('r');
    const ev = confirmedEvidence({
      id: evId,
      type: 'receipt',
      parsed: parsedWith({ fees: [{ label: 'Service Charge 5%', amount: null }] }),
    });
    const r = baseReport({ id: rId, evidenceIds: [evId] });
    const score = scoreFor([r], [ev]);
    expect(score?.score).toBe(10);
    expect(score?.components[0]).toMatchObject({ key: 'fees', points: 10 });
  });
});

// ---------------------------------------------------------------------------
// Corroborated guilt tipping (+15; ≥2 approved "yes" from distinct reporters)
// ---------------------------------------------------------------------------

describe('corroborated guilt tipping', () => {
  it('two approved "yes" from distinct reporterHash → +15', () => {
    const g1 = baseReport({ id: nextId('r'), guilt: 'yes', reporterHash: 'h1' });
    const g2 = baseReport({ id: nextId('r'), guilt: 'yes', reporterHash: 'h2' });
    const score = scoreFor([g1, g2], []);
    expect(score?.score).toBe(15);
    expect(score?.components[0]).toMatchObject({
      key: 'guilt-corroborated',
      points: 15,
    });
  });

  it('two "yes" with the same reporterHash → +0 (not independent)', () => {
    const g1 = baseReport({ id: nextId('r'), guilt: 'yes', reporterHash: 'h1' });
    const g2 = baseReport({ id: nextId('r'), guilt: 'yes', reporterHash: 'h1' });
    expect(scoreFor([g1, g2], [])).toBeNull();
  });

  it('only one "yes" → +0', () => {
    const g1 = baseReport({ id: nextId('r'), guilt: 'yes', reporterHash: 'h1' });
    expect(scoreFor([g1], [])).toBeNull();
  });

  it('"yes" + "no" → +0', () => {
    const g1 = baseReport({ id: nextId('r'), guilt: 'yes', reporterHash: 'h1' });
    const g2 = baseReport({ id: nextId('r'), guilt: 'no', reporterHash: 'h2' });
    expect(scoreFor([g1, g2], [])).toBeNull();
  });

  it('unapproved "yes" reports do not count → +0', () => {
    const g1 = baseReport({
      id: nextId('r'),
      guilt: 'yes',
      reporterHash: 'h1',
      moderationStatus: 'pending',
    });
    const g2 = baseReport({ id: nextId('r'), guilt: 'yes', reporterHash: 'h2' });
    // Mimics the app caller: only approved reports reach computeVenueScore.
    expect(scoreFor([g1, g2], [])).toBeNull();
  });

  it('empty reporterHash falls back to distinct report IDs → +15', () => {
    const g1 = baseReport({ id: nextId('r'), guilt: 'yes', reporterHash: '' });
    const g2 = baseReport({ id: nextId('r'), guilt: 'yes', reporterHash: '' });
    const score = scoreFor([g1, g2], []);
    expect(score?.score).toBe(15);
    expect(score?.components[0]).toMatchObject({
      key: 'guilt-corroborated',
      points: 15,
    });
  });
});

// ---------------------------------------------------------------------------
// Cap at 100
// ---------------------------------------------------------------------------

describe('score cap', () => {
  it('a venue maxing every component totals 85 — never above the 100 cap', () => {
    // table preset >18% (+30) + post-tax receipt (+20) + 3 fees (+20) +
    // corroborated guilt (+15) = 85. No rubric combination can exceed 100.
    const evScreenId = nextId('ev-screen');
    const evReceiptId = nextId('ev-receipt');
    const evScreen = confirmedEvidence({ id: evScreenId, type: 'screen' });
    const evReceipt = confirmedEvidence({
      id: evReceiptId,
      type: 'receipt',
      parsed: parsedWith({ fees: [{ label: 'Card surcharge', amount: null }] }),
    });
    const main = baseReport({
      id: nextId('r'),
      serviceType: 'table',
      screenPresentation: 'handed-over',
      presets: '20%, 25%, 30%',
      tipBase: 'post-tax',
      fees: ['service-charge', 'other'],
      evidenceIds: [evScreenId, evReceiptId],
    });
    const g1 = baseReport({ id: nextId('r'), guilt: 'yes', reporterHash: 'h1' });
    const g2 = baseReport({ id: nextId('r'), guilt: 'yes', reporterHash: 'h2' });

    const score = scoreFor([main, g1, g2], [evScreen, evReceipt]);
    expect(score?.score).toBe(85);
    expect(score?.score).toBeLessThanOrEqual(100);
    const summed = (score?.components ?? []).reduce((s, c) => s + c.points, 0);
    expect(summed).toBe(85);
    expect(score?.components.map((c) => c.key).sort()).toEqual(
      ['fees', 'guilt-corroborated', 'post-tax', 'table-preset'].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// Evidence-only: unverified reports never move the score
// ---------------------------------------------------------------------------

describe('evidence-only rule', () => {
  it('a report with no confirmed evidence contributes nothing → no score', () => {
    const r = baseReport({
      id: nextId('r'),
      serviceType: 'table',
      screenPresentation: 'handed-over',
      presets: '20%, 25%, 30%',
      tipBase: 'post-tax',
      fees: ['service-charge'],
      evidenceIds: [],
    });
    expect(scoreFor([r], [])).toBeNull();
  });

  it('evidence that is not uploader-confirmed is ignored → no score', () => {
    const evId = nextId('ev-screen');
    const ev = confirmedEvidence({ id: evId, type: 'screen' });
    ev.userConfirmed = false; // seen but never confirmed by the uploader
    const r = baseReport({
      id: nextId('r'),
      serviceType: 'counter',
      screenPresentation: 'handed-over',
      evidenceIds: [evId],
    });
    expect(scoreFor([r], [ev])).toBeNull();
  });
});
