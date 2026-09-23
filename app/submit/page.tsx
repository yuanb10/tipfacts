'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import type { ReceiptParsed } from '@/lib/storage';
import { bestVenueMatch } from '@/lib/venue-match';
import { inferTaxBase, tipPercentOf, fmtPct, type TaxBaseGuess } from '@/lib/tip-math';
import RedactionCanvas from '@/components/RedactionCanvas';

/**
 * Two-track contribution flow (PRD C.1 / C.2 / C.4):
 *
 *   Step 0 — track chooser: "Auto: snap a receipt" vs "Manual: type the numbers"
 *
 *   AUTO track:  1 receipt photo (on-device RedactionCanvas; the ORIGINAL
 *     photo never leaves the device, only the redacted export is uploaded) →
 *     2 PII check: user reviews the redacted copy and attests all personal
 *     info is blacked out (extraction is gated on this) → 3 review & submit:
 *     POST /api/receipt/extract receives ONLY the redacted JPEG bytes, then
 *     ONE page shows editable VLM-prefilled values + venue matching + all
 *     report questions; the user confirms/corrects every value (never
 *     auto-published), evidence is confirmed with the attestation at submit
 *     time → done.
 *
 *   MANUAL track: 1 type subtotal / tax / tip / fees; the app computes the tip %
 *     and guesses pre-tax vs post-tax (user confirms) → 2 the facts → done.
 *
 *   Both tracks end in the same facts form: venue (required — search incl. OSM
 *   shells, or create manually), the 3 simple questions (pressured? easy custom
 *   tip? counter/table/takeout?), everything else optional.
 *
 * Evidence API contracts (sibling agent):
 *   POST /api/evidence {photo, type} ->
 *     { ok, evidence: { id, type, redactedUrl, redactionStatus, parsed, ocrAvailable } }
 *   POST /api/evidence/[id]/confirm {confirmed, attestedNoPii?, parsed?} ->
 *     { ok, evidence }
 * Receipt-extract API contract (teammate):
 *   POST /api/receipt/extract (multipart, field `image` = redacted JPEG) ->
 *     200 { ok: true, data: { venue, subtotal, tax, presets, tip,
 *            fees: [{label, amount}], paidTotal, tipPercentage,
 *            taxBase: 'pre'|'post'|'unknown', confidence } } (nulls when unreadable)
 *     503 { ok: false, error, fallback: 'manual' } -> inline manual fallback.
 */

type Track = 'auto' | 'manual';
type EvidenceKind = 'receipt' | 'screen';

interface ParsedDraft {
  merchant: string;
  subtotal: string;
  tax: string;
  tip: string;
  total: string;
  presets: string;
  fees: string;
}

/** Loose shape of the `parsed` object the evidence API returns (may vary). */
interface SiblingParsed {
  merchant?: string | null;
  subtotal?: number | null;
  tax?: number | null;
  tip?: number | null;
  total?: number | null;
  presets?: number[] | null;
  fees?: ({ label: string; amount?: number | null } | string)[] | null;
}

interface EvidenceItem {
  id: string;
  type: EvidenceKind;
  redactedUrl: string | null;
  redactionStatus: string;
  ocrAvailable: boolean;
  confirmed: boolean;
  attested: boolean;
  draft: ParsedDraft;
  error: string;
  confirming: boolean;
  /** The redacted+compressed export from RedactionCanvas — the SAME bytes that
   * were uploaded to /api/evidence. Only these bytes ever go to
   * /api/receipt/extract; the original photo is never sent anywhere. */
  redactedFile: File | null;
}

/** Shape of /api/receipt/extract's `data` payload (nulls for unreadable fields). */
interface ExtractedReceipt {
  venue?: string | null;
  subtotal?: number | null;
  tax?: number | null;
  presets?: number[] | null;
  tip?: number | null;
  fees?: { label: string; amount?: number | null }[] | null;
  paidTotal?: number | null;
  tipPercentage?: number | null;
  taxBase?: 'pre' | 'post' | 'unknown' | null;
  confidence?: 'low' | 'medium' | 'high' | null;
}

/** User-confirmed numbers from the auto track's receipt-read step (all editable strings). */
interface ConfirmedNumbers {
  venue: string;
  subtotal: string;
  tax: string;
  tip: string;
  paidTotal: string;
  tipPct: string;
  presets: string;
  fees: string;
  taxBase: 'pre-tax' | 'post-tax' | 'not-sure';
}

const EMPTY_NUMBERS: ConfirmedNumbers = {
  venue: '',
  subtotal: '',
  tax: '',
  tip: '',
  paidTotal: '',
  tipPct: '',
  presets: '',
  fees: '',
  taxBase: 'not-sure',
};

const EMPTY_DRAFT: ParsedDraft = {
  merchant: '',
  subtotal: '',
  tax: '',
  tip: '',
  total: '',
  presets: '',
  fees: '',
};

const numStr = (v: number | null | undefined): string => (v == null ? '' : String(v));

function draftFromParsed(p: SiblingParsed | null | undefined): ParsedDraft {
  if (!p) return { ...EMPTY_DRAFT };
  return {
    merchant: p.merchant ?? '',
    subtotal: numStr(p.subtotal),
    tax: numStr(p.tax),
    tip: numStr(p.tip),
    total: numStr(p.total),
    presets: (p.presets ?? []).join(', '),
    fees: (p.fees ?? [])
      .map((f) => (typeof f === 'string' ? f : f.label))
      .join(', '),
  };
}

function numOrNull(s: string): number | null {
  const n = parseFloat(s.replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function parsePresetList(s: string): number[] {
  return s
    .split(/[,\s;]+/)
    .map((t) => parseFloat(t.replace('%', '')))
    .filter((n) => Number.isFinite(n));
}

const KIND_LABEL: Record<EvidenceKind, string> = {
  receipt: 'Receipt photo',
  screen: 'Tip-screen photo',
};

const FEE_OPTIONS: [string, string][] = [
  ['service-charge', 'Service charge'],
  ['card-surcharge', 'Credit-card surcharge'],
  ['none', 'None'],
  ['other', 'Other'],
];

function Stepper({ labels, step }: { labels: string[]; step: number }) {
  return (
    <div className="stepper" aria-label="Progress">
      {labels.map((label, i) => (
        <span key={label} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          {i > 0 && <span className="step-dot">→</span>}
          {i + 1 === step ? (
            <span className="step-now">
              {i + 1} · {label}
            </span>
          ) : (
            <span>
              {i + 1} · {label}
            </span>
          )}
        </span>
      ))}
    </div>
  );
}

/** Lightweight venue shape returned by GET /api/venues/search. */
interface VenueHit {
  id: string;
  name: string;
  city: string;
  area: string;
  address: string;
  lat: number | null;
  lng: number | null;
  category: string;
  source: 'osm' | 'manual';
  distanceMeters?: number;
}

/** A venue preselected via ?venueId= (directory "be the first to report" CTA). */
interface PreselectVenue {
  id: string;
  name: string;
  city: string;
  area: string;
  address: string;
  category: string;
}

/**
 * Venue picker: users never type a full venue name from scratch.
 *   - OCR merchant pre-fill: fuzzy-matches the receipt's merchant against
 *     known venues and proposes the best hit for confirmation.
 *   - VLM venue proposal: passed in via `merchants` as a separate prefill source.
 *   - ?venueId= preselect: the directory's "be the first to report" CTA lands
 *     here with a venue preselected; the user can still change it.
 *   - Type-ahead: debounced search over all listings (shells included).
 *   - Nearby: optional geolocation → venues within ~800m.
 *   - Manual fallback: type a new name; it becomes a pending venue.
 * Selecting a listing posts `venueId`; the manual path posts venueName+city.
 */
function VenuePicker({
  merchants,
  preselect,
}: {
  merchants: string[];
  preselect: PreselectVenue | null;
}) {
  const [selected, setSelected] = useState<VenueHit | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<VenueHit[]>([]);
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'detected' | 'new'; text: string } | null>(null);
  const [nearby, setNearby] = useState<VenueHit[] | null>(null);
  const [locating, setLocating] = useState(false);
  const [locError, setLocError] = useState('');
  const [manualName, setManualName] = useState('');
  const didPrefill = useRef(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Merchant / preselect pre-fill — once, on mount.
  useEffect(() => {
    if (didPrefill.current) return;
    didPrefill.current = true;

    // ?venueId= wins: the directory sent the user here for THIS venue.
    if (preselect) {
      setSelected({
        id: preselect.id,
        name: preselect.name,
        city: preselect.city,
        area: preselect.area,
        address: preselect.address,
        lat: null,
        lng: null,
        category: preselect.category,
        source: 'manual',
      });
      setNotice({
        kind: 'detected',
        text: `Reporting for ${preselect.name} — change it if this isn't the right place.`,
      });
      return;
    }

    const merchant = merchants.map((m) => m.trim()).find(Boolean);
    if (!merchant) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/venues/search?q=' + encodeURIComponent(merchant));
        const data = await res.json();
        if (cancelled) return;
        const venues: VenueHit[] = data.ok ? (data.venues ?? []) : [];
        const best = bestVenueMatch(merchant, venues);
        if (best) {
          setSelected(best.venue);
          setNotice({
            kind: 'detected',
            text: `We detected ${best.venue.name} from your receipt — is this right?`,
          });
        } else {
          setManualName(merchant);
          setNotice({
            kind: 'new',
            text: `We couldn't find "${merchant}" in our listings — we'll add it as a new venue when you submit (pending moderation).`,
          });
        }
      } catch {
        if (!cancelled) setManualName(merchant);
      }
    })();
    return () => {
      cancelled = true;
    };
    // merchants/preselect are fixed for this mount (facts step renders once per visit).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debounced type-ahead.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      setOpen(false);
      return;
    }
    const t = setTimeout(async () => {
      try {
        const res = await fetch('/api/venues/search?q=' + encodeURIComponent(q));
        const data = await res.json();
        if (data.ok) {
          setResults(data.venues ?? []);
          setOpen(true);
        }
      } catch {
        // keep previous results on transient errors
      }
    }, 250);
    return () => clearTimeout(t);
  }, [query]);

  // Close the dropdown on outside click.
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  function choose(v: VenueHit) {
    setSelected(v);
    setQuery('');
    setResults([]);
    setOpen(false);
    setNearby(null);
    setNotice(null);
  }

  function change() {
    setSelected(null);
    setManualName('');
    setNotice(null);
  }

  function useMyLocation() {
    if (!('geolocation' in navigator)) {
      setLocError('Geolocation is not available in this browser.');
      return;
    }
    setLocating(true);
    setLocError('');
    setNearby(null);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          const res = await fetch(
            `/api/venues/search?lat=${pos.coords.latitude}&lng=${pos.coords.longitude}&radius=800`,
          );
          const data = await res.json();
          if (data.ok) setNearby(data.venues ?? []);
        } catch {
          setLocError('Could not load nearby venues — try searching by name.');
        } finally {
          setLocating(false);
        }
      },
      () => {
        setLocError('Location access was denied — you can still search by name.');
        setLocating(false);
      },
      { timeout: 10000 },
    );
  }

  const sub = (v: VenueHit) =>
    [v.address, v.area || v.city, v.category].filter(Boolean).join(' · ');

  return (
    <div>
      <div className="field">
        <span className="field-label">
          Venue <span className="required-mark">*</span>
        </span>
        {notice?.kind === 'detected' && (
          <div className="form-success" style={{ marginBottom: 8 }}>
            <p style={{ margin: 0 }}>{notice.text}</p>
          </div>
        )}
        {notice?.kind === 'new' && <p className="hint">{notice.text}</p>}

        {selected ? (
          <div>
            <input type="hidden" name="venueId" value={selected.id} />
            <div className="venue-chip">
              <div>
                <strong>{selected.name}</strong>
                <div className="hint" style={{ margin: 0 }}>
                  {sub(selected)}
                </div>
              </div>
              <button type="button" className="btn btn-secondary" onClick={change}>
                Change
              </button>
            </div>
          </div>
        ) : (
          <div className="venue-picker" ref={wrapRef}>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onFocus={() => {
                if (results.length) setOpen(true);
              }}
              placeholder="Start typing a venue name…"
              maxLength={80}
              autoComplete="off"
              aria-label="Search venues"
            />
            {open && results.length > 0 && (
              <ul className="venue-results" role="listbox" aria-label="Matching venues">
                {results.map((v) => (
                  <li key={v.id}>
                    <button type="button" role="option" aria-selected="false" onClick={() => choose(v)}>
                      <span className="venue-result-name">{v.name}</span>
                      <span className="venue-result-sub">{sub(v)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {open && query.trim().length >= 2 && results.length === 0 && (
              <p className="hint">
                No matches — keep typing, or fill in the name below and we&apos;ll add it.
              </p>
            )}
          </div>
        )}
      </div>

      {!selected && (
        <>
          <div className="field">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={useMyLocation}
              disabled={locating}
            >
              {locating ? 'Locating…' : 'Use my location'}
            </button>
            {locError && (
              <p className="form-error" style={{ marginTop: 8 }}>
                {locError}
              </p>
            )}
            {nearby && (
              <div style={{ marginTop: 8 }}>
                {nearby.length === 0 ? (
                  <p className="hint">
                    No listed venues within 800m — search by name or add it below.
                  </p>
                ) : (
                  <>
                    <span className="field-label">Nearby</span>
                    <div className="venue-nearby">
                      {nearby.map((v) => (
                        <button
                          key={v.id}
                          type="button"
                          className="venue-nearby-btn"
                          onClick={() => choose(v)}
                        >
                          <span className="venue-result-name">{v.name}</span>
                          <span className="venue-result-sub">
                            {v.distanceMeters != null ? `${v.distanceMeters}m` : ''}
                            {v.distanceMeters != null && sub(v) ? ' · ' : ''}
                            {sub(v)}
                          </span>
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>

          <div className="field">
            <label className="field-label" htmlFor="venueName">
              Venue name <span className="required-mark">*</span>
            </label>
            <input
              type="text"
              id="venueName"
              name="venueName"
              required
              maxLength={120}
              value={manualName}
              onChange={(e) => setManualName(e.target.value)}
              placeholder="e.g. Demo Diner"
            />
            <p className="hint">
              Can&apos;t find it above? Type the full name — we&apos;ll add it as a new venue
              (pending moderation).
            </p>
          </div>

          <div className="field">
            <label className="field-label" htmlFor="city">
              City <span className="required-mark">*</span>
            </label>
            <input
              type="text"
              id="city"
              name="city"
              required
              maxLength={80}
              defaultValue="Seattle"
            />
            <p className="hint">Starting in Seattle — other cities welcome.</p>
          </div>
        </>
      )}

      <div className="field">
        <label className="field-label" htmlFor="area">
          Neighborhood / area
        </label>
        <input type="text" id="area" name="area" maxLength={80} />
        <p className="hint">Optional — leave blank and we&apos;ll fill it in.</p>
      </div>
    </div>
  );
}

/* ------------------------------------------------- step 0: track chooser */

function TrackChooser({
  preselect,
  onPick,
}: {
  preselect: PreselectVenue | null;
  onPick: (t: Track) => void;
}) {
  const card: React.CSSProperties = {
    display: 'block',
    width: '100%',
    textAlign: 'left',
    padding: '20px 18px',
    marginBottom: 12,
    borderRadius: 12,
    border: '1px solid var(--border, #e2e2e2)',
    background: 'var(--card, #fff)',
    cursor: 'pointer',
  };
  return (
    <div className="form-card">
      {preselect && (
        <div className="form-success" style={{ marginBottom: 16 }}>
          <p style={{ margin: 0 }}>
            You&apos;re reporting for <strong>{preselect.name}</strong> — be the first to log
            a report there.
          </p>
        </div>
      )}
      <p className="hint" style={{ marginTop: 0 }}>
        Two ways to log a report. Pick whichever is easier.
      </p>
      <button type="button" style={card} onClick={() => onPick('auto')}>
        <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>📸 Auto: snap a receipt</div>
        <p className="hint" style={{ margin: 0 }}>
          Photograph the receipt, black out private details yourself, and we&apos;ll read the
          numbers for you to confirm. Takes ~60 seconds.
        </p>
      </button>
      <button type="button" style={card} onClick={() => onPick('manual')}>
        <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>
          ✏️ Manual: type the numbers
        </div>
        <p className="hint" style={{ margin: 0 }}>
          No receipt handy? Type the subtotal, tax, and tip — the app does the math.
        </p>
      </button>
    </div>
  );
}

/* ------------------------------------- manual track: type the numbers */

interface ManualNums {
  subtotal: string;
  tax: string;
  tip: string;
  fees: string[];
  base: 'pre-tax' | 'post-tax' | 'not-sure';
  /** True once the user explicitly picked a base — the live guess stops overriding it. */
  baseExplicit: boolean;
}

const EMPTY_MANUAL: ManualNums = {
  subtotal: '',
  tax: '',
  tip: '',
  fees: [],
  base: 'not-sure',
  baseExplicit: false,
};

function ManualNumbersStep({
  initial,
  onContinue,
  onBack,
}: {
  initial: ManualNums;
  onContinue: (m: ManualNums) => void;
  onBack: () => void;
}) {
  const [subtotal, setSubtotal] = useState(initial.subtotal);
  const [tax, setTax] = useState(initial.tax);
  const [tip, setTip] = useState(initial.tip);
  const [fees, setFees] = useState<string[]>(initial.fees);
  const [baseLocked, setBaseLocked] = useState(initial.baseExplicit);
  const [base, setBase] = useState<'pre-tax' | 'post-tax' | 'not-sure'>(initial.base);

  const st = numOrNull(subtotal);
  const tx = numOrNull(tax);
  const tp = numOrNull(tip);
  const pct = tipPercentOf(tp, st);
  const guess: TaxBaseGuess = inferTaxBase(st, tx, tp);

  // Follow the live guess until the user explicitly picks a base themselves.
  useEffect(() => {
    if (!baseLocked) setBase(guess === 'unknown' ? 'not-sure' : guess);
  }, [guess, baseLocked]);

  function toggleFee(v: string) {
    setFees((prev) => (prev.includes(v) ? prev.filter((f) => f !== v) : [...prev, v]));
  }

  function pickBase(v: 'pre-tax' | 'post-tax' | 'not-sure') {
    setBase(v);
    setBaseLocked(true);
  }

  // Everything except the venue (picked next) is optional — never block a
  // motivated contributor, even with all fields blank.

  return (
    <div className="form-card">
      <p className="hint" style={{ marginTop: 0 }}>
        Just the numbers off the receipt — everything is optional except the venue, which
        you&apos;ll pick next.
      </p>

      <div className="field">
        <label className="field-label" htmlFor="m-subtotal">
          Subtotal (before tax)
        </label>
        <input
          type="text"
          inputMode="decimal"
          id="m-subtotal"
          value={subtotal}
          maxLength={20}
          placeholder="e.g. 42.50"
          onChange={(e) => setSubtotal(e.target.value)}
        />
      </div>
      <div className="field">
        <label className="field-label" htmlFor="m-tax">
          Tax
        </label>
        <input
          type="text"
          inputMode="decimal"
          id="m-tax"
          value={tax}
          maxLength={20}
          placeholder="e.g. 4.10"
          onChange={(e) => setTax(e.target.value)}
        />
      </div>
      <div className="field">
        <label className="field-label" htmlFor="m-tip">
          Tip you paid
        </label>
        <input
          type="text"
          inputMode="decimal"
          id="m-tip"
          value={tip}
          maxLength={20}
          placeholder="e.g. 8.50"
          onChange={(e) => setTip(e.target.value)}
        />
      </div>

      {pct != null && (
        <div className="form-success" style={{ marginBottom: 12 }}>
          <p style={{ margin: 0 }}>
            That&apos;s a <strong>{fmtPct(pct)}</strong> tip on the subtotal.
          </p>
        </div>
      )}

      <div className="field">
        <span className="field-label">Any extra fees?</span>
        <div className="checkbox-group">
          {FEE_OPTIONS.map(([val, label]) => (
            <label key={val} className="checkbox-option">
              <input
                type="checkbox"
                checked={fees.includes(val)}
                onChange={() => toggleFee(val)}
              />
              {label}
            </label>
          ))}
        </div>
      </div>

      <div className="field">
        <span className="field-label">Was the tip calculated pre-tax or post-tax?</span>
        {guess === 'unknown' ? (
          <p className="hint">
            We couldn&apos;t tell from these numbers — pick your best guess below (or
            &ldquo;not sure&rdquo;).
          </p>
        ) : (
          <p className="hint">
            Our best guess: <strong>{guess === 'pre-tax' ? 'pre-tax subtotal' : 'post-tax total'}</strong> —
            confirm it below.
          </p>
        )}
        <div className="radio-group">
          {(
            [
              ['pre-tax', 'Pre-tax subtotal'],
              ['post-tax', 'Post-tax total'],
              ['not-sure', 'Not sure'],
            ] as const
          ).map(([val, label]) => (
            <label key={val} className="radio-option">
              <input type="radio" checked={base === val} onChange={() => pickBase(val)} />
              {label}
            </label>
          ))}
        </div>
      </div>

      <div className="btn-row" style={{ marginTop: 16 }}>
        <button type="button" className="btn btn-secondary" onClick={onBack}>
          Back
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => onContinue({ subtotal, tax, tip, fees, base, baseExplicit: baseLocked })}
        >
          Continue
        </button>
      </div>
    </div>
  );
}

/* -------------------- auto track: VLM reads the redacted receipt, user confirms */

type ExtractStatus = 'reading' | 'ready' | 'fallback';

function numbersFromExtracted(d: ExtractedReceipt): ConfirmedNumbers {
  const pct =
    d.tipPercentage ??
    (d.tip != null && d.subtotal != null && d.subtotal > 0
      ? (d.tip / d.subtotal) * 100
      : null);
  return {
    venue: d.venue ?? '',
    subtotal: numStr(d.subtotal),
    tax: numStr(d.tax),
    tip: numStr(d.tip),
    paidTotal: numStr(d.paidTotal),
    tipPct: pct == null ? '' : String(Math.round(pct * 10) / 10),
    presets: (d.presets ?? []).join(', '),
    fees: (d.fees ?? [])
      .map((f) => (f.amount != null ? `${f.label} ($${f.amount})` : f.label))
      .join(', '),
    taxBase:
      d.taxBase === 'pre' ? 'pre-tax' : d.taxBase === 'post' ? 'post-tax' : 'not-sure',
  };
}


/* --------------------------------- auto: single review & submit page.

Runs VLM extraction on mount (gated on the PII attestation from step 2),
then renders ONE page: editable pre-filled receipt values, venue matching,
and all report questions. Confirming evidence is postponed until final
submit — prepareEvidence confirms with attestedNoPii + corrected parsed
values right before POSTing /api/submissions. */

function AutoReviewStep({
  file,
  evidenceId,
  preselect,
  onBack,
  onSubmitted,
}: {
  /** The redacted JPEG — the same bytes already uploaded via /api/evidence. */
  file: File | null;
  /** Evidence id to confirm at submit time (null when no photo was uploaded). */
  evidenceId: string | null;
  preselect: PreselectVenue | null;
  onBack: () => void;
  onSubmitted: () => void;
}) {
  const [status, setStatus] = useState<ExtractStatus>('reading');
  const [fields, setFields] = useState<ConfirmedNumbers>(EMPTY_NUMBERS);
  const [venueHint, setVenueHint] = useState('');
  const [extractError, setExtractError] = useState('');
  const didRun = useRef(false);

  // Call the extraction endpoint ONCE. It receives only the redacted image
  // bytes — the original photo is never sent anywhere. This only runs after
  // the user attested (step 2) that all PII is blacked out.
  useEffect(() => {
    if (didRun.current) return;
    didRun.current = true;
    if (!file) {
      setStatus('fallback');
      return;
    }
    (async () => {
      try {
        const body = new FormData();
        body.append('image', file, 'redacted.jpg');
        const res = await fetch('/api/receipt/extract', { method: 'POST', body });
        const data = await res.json().catch(() => null);
        if (res.ok && data && data.ok && data.data) {
          const extracted = data.data as ExtractedReceipt;
          setFields(numbersFromExtracted(extracted));
          setVenueHint(extracted.venue ?? '');
          setStatus('ready');
        } else {
          const msg =
            (data && (data.error || data.details)) ||
            `Receipt reader returned ${res.status}.`;
          setExtractError(
            process.env.NODE_ENV === 'development'
              ? `Extraction failed: ${msg}`
              : '',
          );
          setStatus('fallback');
        }
      } catch (err) {
        setExtractError(
          process.env.NODE_ENV === 'development'
            ? `Extraction failed: ${err instanceof Error ? err.message : String(err)}`
            : '',
        );
        setStatus('fallback');
      }
    })();
    // file is fixed for this mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function set<K extends keyof ConfirmedNumbers>(k: K, v: ConfirmedNumbers[K]) {
    setFields((prev) => ({ ...prev, [k]: v }));
  }

  // Confirm the evidence (attesting no PII + corrected parsed values) right
  // before the report is submitted.
  async function prepareEvidence(): Promise<
    { ids: string[] } | { error: string }
  > {
    if (!evidenceId) return { ids: [] };
    try {
      const parsed: Partial<ReceiptParsed> = {
        merchant: venueHint || undefined,
        subtotal: numOrNull(fields.subtotal),
        tax: numOrNull(fields.tax),
        tip: numOrNull(fields.tip),
        total: numOrNull(fields.paidTotal),
      };
      const res = await fetch(`/api/evidence/${evidenceId}/confirm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirmed: true, attestedNoPii: true, parsed }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        return { error: data?.error || 'Could not confirm the receipt photo.' };
      }
      return { ids: [evidenceId] };
    } catch {
      return { error: 'Network error confirming the receipt photo.' };
    }
  }

  function retry() {
    didRun.current = false;
    setStatus('reading');
    setExtractError('');
    // Re-run the effect by toggling a key-less re-mount trick: easiest is to
    // just re-invoke via state. We flip didRun and re-run manually.
    if (!file) {
      setStatus('fallback');
      return;
    }
    didRun.current = true;
    (async () => {
      try {
        const body = new FormData();
        body.append('image', file, 'redacted.jpg');
        const res = await fetch('/api/receipt/extract', { method: 'POST', body });
        const data = await res.json().catch(() => null);
        if (res.ok && data && data.ok && data.data) {
          const extracted = data.data as ExtractedReceipt;
          setFields(numbersFromExtracted(extracted));
          setVenueHint(extracted.venue ?? '');
          setStatus('ready');
        } else {
          setStatus('fallback');
        }
      } catch {
        setStatus('fallback');
      }
    })();
  }

  if (status === 'reading') {
    return (
      <div className="form-card">
        <h2 style={{ fontSize: 18, marginTop: 0 }}>Reading your receipt</h2>
        <p className="hint">
          This takes a few seconds. Only the redacted copy you approved is being
          read — the original never left your device.
        </p>
        <div className="btn-row" style={{ marginTop: 16 }}>
          <button type="button" className="btn btn-secondary" onClick={onBack}>
            Back
          </button>
        </div>
      </div>
    );
  }

  const receiptBlock = (
    <div className="field">
      <span className="field-label">Receipt values — fix anything wrong</span>
      {status === 'ready' ? (
        <p className="hint" style={{ marginTop: 0 }}>
          Pre-filled from your redacted photo. Nothing publishes until you submit.
        </p>
      ) : (
        <div className="form-error" style={{ marginBottom: 12 }}>
          <p style={{ margin: 0 }}>
            Couldn&apos;t read the receipt automatically — enter the numbers below.
            Your receipt photo stays attached to the report.
          </p>
          {extractError && (
            <p className="hint" style={{ margin: '8px 0 0' }}>
              {extractError}
            </p>
          )}
          <button
            type="button"
            className="btn btn-secondary"
            style={{ marginTop: 8 }}
            onClick={retry}
          >
            Try reading again
          </button>
        </div>
      )}

      {(
        [
          ['subtotal', 'Subtotal'],
          ['tax', 'Tax'],
          ['tip', 'Tip'],
          ['paidTotal', 'Paid total'],
        ] as const
      ).map(([key, label]) => (
        <div className="field" key={key}>
          <label className="field-label" htmlFor={`ar-${key}`}>
            {label}
          </label>
          <input
            type="text"
            inputMode="decimal"
            id={`ar-${key}`}
            value={fields[key]}
            maxLength={20}
            onChange={(e) => set(key, e.target.value)}
          />
        </div>
      ))}

      <div className="field">
        <label className="field-label" htmlFor="ar-tippct">
          Tip percentage
        </label>
        <input
          type="text"
          inputMode="decimal"
          id="ar-tippct"
          value={fields.tipPct}
          maxLength={10}
          placeholder="e.g. 20"
          onChange={(e) => set('tipPct', e.target.value)}
        />
      </div>

      <div className="field">
        <label className="field-label" htmlFor="ar-presets">
          Tip presets shown
        </label>
        <input
          type="text"
          id="ar-presets"
          value={fields.presets}
          maxLength={60}
          placeholder="e.g. 20, 25, 30"
          onChange={(e) => set('presets', e.target.value)}
        />
      </div>

      <div className="field">
        <label className="field-label" htmlFor="ar-fees">
          Fees on the receipt
        </label>
        <input
          type="text"
          id="ar-fees"
          value={fields.fees}
          maxLength={120}
          placeholder="e.g. service charge"
          onChange={(e) => set('fees', e.target.value)}
        />
      </div>

      <div className="field">
        <span className="field-label">Was the tip calculated pre-tax or post-tax?</span>
        <div className="radio-group">
          {(
            [
              ['pre-tax', 'Pre-tax subtotal'],
              ['post-tax', 'Post-tax total'],
              ['not-sure', 'Not sure'],
            ] as const
          ).map(([val, label]) => (
            <label key={val} className="radio-option">
              <input
                type="radio"
                checked={fields.taxBase === val}
                onChange={() => set('taxBase', val)}
              />
              {label}
            </label>
          ))}
        </div>
      </div>
    </div>
  );

  return (
    <FactsForm
      track="auto"
      merchants={venueHint ? [venueHint] : []}
      preselect={preselect}
      confirmedCount={evidenceId ? 1 : 0}
      prefillPresets={fields.presets}
      prefillTipBase={fields.taxBase}
      showFees
      manualFees={[]}
      buildFactsLine={(tipBase) => buildFactsLine(fields, tipBase)}
      confirmedIds={[]}
      receiptBlock={receiptBlock}
      prepareEvidence={prepareEvidence}
      venueKey={venueHint}
      onBack={onBack}
      onSubmitted={onSubmitted}
    />
  );
}

/* --------------------------------- shared final step: the facts + 3 questions */

function FactsForm({
  track,
  merchants,
  preselect,
  confirmedCount,
  prefillPresets,
  prefillTipBase,
  showFees,
  manualFees,
  buildFactsLine,
  confirmedIds,
  receiptBlock,
  prepareEvidence,
  venueKey,
  onBack,
  onSubmitted,
}: {
  track: Track;
  merchants: string[];
  preselect: PreselectVenue | null;
  confirmedCount: number;
  prefillPresets: string;
  prefillTipBase: 'pre-tax' | 'post-tax' | 'not-sure' | '';
  showFees: boolean;
  manualFees: string[];
  buildFactsLine: (tipBase: string) => string;
  confirmedIds: string[];
  /** Auto track: editable VLM-prefilled receipt values, rendered above venue. */
  receiptBlock?: React.ReactNode;
  /** Auto track: confirm evidence (PII attested + parsed values) at submit time. */
  prepareEvidence?: () => Promise<{ ids: string[] } | { error: string }>;
  /** Auto track: remount VenuePicker when the VLM venue hint arrives. */
  venueKey?: string;
  onBack: () => void;
  onSubmitted: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  async function onSubmitFacts(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const form = e.currentTarget;
      const body = new FormData(form);
      // Auto track confirms the evidence (with the corrected receipt values)
      // right before submitting; manual track passes already-confirmed ids.
      let evidenceIds = confirmedIds;
      if (prepareEvidence) {
        const prepared = await prepareEvidence();
        if ('error' in prepared) {
          setError(prepared.error);
          setSubmitting(false);
          return;
        }
        evidenceIds = prepared.ids;
      }
      body.set('evidenceIds', JSON.stringify(evidenceIds));
      // Manual track captured fees in the numbers step; auto track uses the
      // checkboxes below.
      if (track === 'manual') manualFees.forEach((f) => body.append('fees', f));
      // The /api/submissions contract has no numeric fields, so confirmed
      // receipt math rides along as a machine-readable line in notes —
      // visible to moderators, never auto-published.
      const userNotes = String(body.get('notes') ?? '').trim();
      const line = buildFactsLine(String(body.get('tipBase') ?? ''));
      body.set('notes', [userNotes, line].filter(Boolean).join('\n\n'));
      const res = await fetch('/api/submissions', { method: 'POST', body });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data.error || 'Something went wrong. Please try again.');
      } else {
        onSubmitted();
        window.scrollTo(0, 0);
      }
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="form-card" onSubmit={onSubmitFacts}>
      {/* Honeypot anti-spam field: invisible to humans */}
      <input
        type="text"
        name="website"
        className="honeypot"
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
      />

      {error && <div className="form-error">{error}</div>}

      <p className="hint" style={{ marginTop: 0 }}>
        {confirmedCount > 0
          ? `Evidence attached: ${confirmedCount} confirmed photo${confirmedCount > 1 ? 's' : ''}.`
          : 'No photos attached.'}{' '}
        Objective facts only — they feed the score.
      </p>

      <VenuePicker key={venueKey ?? 'manual'} merchants={merchants} preselect={preselect} />
      {receiptBlock}

      <div className="field">
        <span className="field-label">
          Service type <span className="required-mark">*</span>
        </span>
        <div className="radio-group">
          {[
            ['counter', 'Counter service'],
            ['table', 'Table service'],
            ['takeout', 'Takeout / pickup'],
            ['nonfood', 'Non-food retail'],
          ].map(([val, label]) => (
            <label key={val} className="radio-option">
              <input type="radio" name="serviceType" value={val} required />
              {label}
            </label>
          ))}
        </div>
      </div>

      <div className="field">
        <span className="field-label">Tip-screen presentation</span>
        <div className="radio-group">
          {[
            ['staff-held', 'Staff held the screen facing me while I chose'],
            ['handed-over', 'Screen handed to me or left on the counter'],
            ['no-screen', 'No tip screen — no tip prompt at all'],
            ['not-sure', 'Not sure'],
          ].map(([val, label]) => (
            <label key={val} className="radio-option">
              <input type="radio" name="screenPresentation" value={val} />
              {label}
            </label>
          ))}
        </div>
      </div>

      <div className="field">
        <label className="field-label" htmlFor="presets">
          What the tip screen showed
        </label>
        <input
          type="text"
          id="presets"
          name="presets"
          placeholder="e.g. 20%, 25%, 30%"
          maxLength={120}
          defaultValue={prefillPresets}
        />
      </div>

      <div className="field">
        <span className="field-label">Was the tip calculated pre-tax or post-tax?</span>
        <div className="radio-group">
          {(
            [
              ['pre-tax', 'Pre-tax subtotal'],
              ['post-tax', 'Post-tax total'],
              ['not-sure', 'Not sure'],
            ] as const
          ).map(([val, label]) => (
            <label key={val} className="radio-option">
              <input
                type="radio"
                name="tipBase"
                value={val}
                defaultChecked={prefillTipBase === val}
              />
              {label}
            </label>
          ))}
        </div>
      </div>

      {showFees && (
        <div className="field">
          <span className="field-label">Any extra fees?</span>
          <div className="checkbox-group">
            {FEE_OPTIONS.map(([val, label]) => (
              <label key={val} className="checkbox-option">
                <input type="checkbox" name="fees" value={val} />
                {label}
              </label>
            ))}
          </div>
        </div>
      )}

      <div className="field">
        <span className="field-label">
          Was it easy to choose a custom tip or no tip? (e.g. a clear custom/zero option,
          not buried or guilt-tripped)
        </span>
        <div className="radio-group">
          {[
            ['yes', 'Yes, easy'],
            ['no', 'No, hard or missing'],
            ['skip', 'Skip'],
          ].map(([val, label]) => (
            <label key={val} className="radio-option">
              <input type="radio" name="easyOptOut" value={val} />
              {label}
            </label>
          ))}
        </div>
      </div>

      <div className="field">
        <span className="field-label">
          Did you feel pressured while choosing your tip? (e.g. staff watching you select)
        </span>
        <div className="radio-group">
          {[
            ['yes', 'Yes'],
            ['no', 'No'],
            ['skip', 'Skip'],
          ].map(([val, label]) => (
            <label key={val} className="radio-option">
              <input type="radio" name="guilt" value={val} />
              {label}
            </label>
          ))}
        </div>
      </div>

      <div className="field">
        <label className="field-label" htmlFor="experienceNote">
          How it felt
        </label>
        <textarea id="experienceNote" name="experienceNote" maxLength={1000} />
        <p className="hint">
          How it felt — shown in a separate subjective section, never affects the score. No
          staff names.
        </p>
      </div>

      <div className="field">
        <label className="field-label" htmlFor="notes">
          Anything else
        </label>
        <textarea id="notes" name="notes" maxLength={1000} />
        <p className="hint">Suggestions, feedback, anything we missed.</p>
      </div>

      <div className="btn-row">
        <button type="button" className="btn btn-secondary" onClick={onBack}>
          Back
        </button>
        <button type="submit" className="submit-btn" disabled={submitting}>
          {submitting ? 'Submitting…' : 'Submit report'}
        </button>
      </div>
    </form>
  );
}

/* ------------------------------------------------------- facts line builder */

/**
 * The /api/submissions contract has no numeric fields, so confirmed receipt
 * math rides along as a machine-readable line appended to `notes` — visible to
 * moderators, never auto-published.
 */
function buildFactsLine(
  src: { subtotal: string; tax: string; tip: string; paidTotal: string; tipPct: string } | null,
  tipBase: string,
): string {
  if (!src) return '';
  const bits: string[] = [];
  const push = (k: string, v: string) => {
    const t = v.trim();
    if (t) bits.push(`${k}=${t}`);
  };
  push('subtotal', src.subtotal);
  push('tax', src.tax);
  push('tip', src.tip);
  push('paid', src.paidTotal);
  const p = src.tipPct.trim().replace(/%$/, '');
  if (p) bits.push(`tipPct=${p}%`);
  if (tipBase) bits.push(`base=${tipBase}`);
  return bits.length ? '[receipt math] ' + bits.join(' · ') : '';
}

/* ------------------------------------------------------------------ page */

function SubmitInner() {
  const searchParams = useSearchParams();
  const [track, setTrack] = useState<Track | null>(null);
  const [preselect, setPreselect] = useState<PreselectVenue | null>(null);
  const [autoStep, setAutoStep] = useState<1 | 2 | 3>(1);
  const [manualStep, setManualStep] = useState<1 | 2>(1);
  const [items, setItems] = useState<EvidenceItem[]>([]);
  const [uploading, setUploading] = useState<EvidenceKind | null>(null);
  const [step1Error, setStep1Error] = useState('');
  const [editing, setEditing] = useState<{ kind: EvidenceKind; file: File } | null>(null);
  const [piiAttested, setPiiAttested] = useState(false);
  const [manual, setManual] = useState<ManualNums>({ ...EMPTY_MANUAL });
  const [done, setDone] = useState(false);

  // ?venueId= preselect (directory "be the first to report" CTA).
  useEffect(() => {
    const id = searchParams.get('venueId');
    if (!id) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/venues/' + encodeURIComponent(id));
        const data = await res.json();
        if (cancelled) return;
        if (res.ok && data.ok && data.venue) {
          const v = data.venue;
          setPreselect({
            id: String(v.id ?? id),
            name: String(v.name ?? ''),
            city: String(v.city ?? ''),
            area: String(v.area ?? ''),
            address: String(v.address ?? ''),
            category: String(v.category ?? ''),
          });
        }
      } catch {
        // No preselect on errors — the picker falls back to search/manual.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [searchParams]);

  const patchItem = (id: string, patch: Partial<EvidenceItem>) =>
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)));

  async function uploadFile(kind: EvidenceKind, file: File) {
    setStep1Error('');
    setUploading(kind);
    try {
      const body = new FormData();
      body.append('photo', file);
      body.append('type', kind);
      const res = await fetch('/api/evidence', { method: 'POST', body });
      const data = await res.json();
      if (!res.ok || !data.ok || !data.evidence) {
        setStep1Error(data.error || 'Upload failed. Please try again.');
        return;
      }
      const ev = data.evidence;
      setItems((prev) => [
        ...prev,
        {
          id: String(ev.id),
          type: kind,
          redactedUrl: ev.redactedUrl ?? null,
          redactionStatus: String(ev.redactionStatus ?? 'pending'),
          ocrAvailable: ev.ocrAvailable !== false,
          confirmed: false,
          attested: false,
          draft: draftFromParsed(ev.parsed as SiblingParsed | null | undefined),
          error: '',
          confirming: false,
          // Stash the redacted export: the extract step sends these same bytes
          // to /api/receipt/extract. The original photo never leaves the device.
          redactedFile: file,
        },
      ]);
    } catch {
      setStep1Error('Network error. Please try again.');
    } finally {
      setUploading(null);
    }
  }

  function onFile(kind: EvidenceKind, input: HTMLInputElement | null) {
    const file = input?.files?.[0];
    if (input) input.value = '';
    // Open the on-device redaction editor instead of uploading the raw file.
    if (file) setEditing({ kind, file });
  }

  function removeItem(id: string) {
    setItems((prev) => prev.filter((it) => it.id !== id));
  }


  const unconfirmed = items.filter((it) => !it.confirmed);
  const confirmedIds = items.filter((it) => it.confirmed).map((it) => it.id);

  // Evidence confirmation is postponed until final submit (AutoReviewStep's
  // prepareEvidence confirms with the PII attestation + corrected values).
  const withFile = items.filter((it) => it.redactedFile);
  const extractTarget =
    withFile.find((it) => it.type === 'receipt') ?? withFile[0] ?? null;

  function resetAll() {
    setTrack(null);
    setAutoStep(1);
    setManualStep(1);
    setItems([]);
    setStep1Error('');
    setManual({ ...EMPTY_MANUAL });
    setDone(false);
  }

  /* ---------------------------------------------------------- done screen */
  if (done) {
    return (
      <div>
        <p className="eyebrow">Log a report</p>
        <h1 className="page-title">Report logged.</h1>
        <div className="form-success">
          <h2>Thanks — your report is pending moderation.</h2>
          <p>It will appear in the rankings once approved. One more while you&apos;re at it?</p>
          <div className="btn-row">
            <a href="/" className="btn btn-primary">
              See the rankings
            </a>
            <button className="btn btn-secondary" onClick={resetAll}>
              Submit another
            </button>
          </div>
        </div>
      </div>
    );
  }

  /* ------------------------------------------------- auto: step 1 evidence */
  /* ------------------------------------------- auto: step 1 receipt upload */
  function renderEvidenceStep() {
    const receipt = items.find((it) => it.type === 'receipt') ?? null;
    return (
      <div className="form-card">
        {step1Error && <div className="form-error">{step1Error}</div>}

        <p className="hint" style={{ marginTop: 0 }}>
          Upload your receipt photo. You&apos;ll black out private details yourself right
          after picking it — the original never leaves your device. Nothing publishes
          until you review and confirm it. Please no staff faces.
        </p>

        {!receipt ? (
          <div className="field">
            <span className="field-label">Receipt photo</span>
            <label className="btn btn-secondary">
              {uploading === 'receipt' ? 'Uploading…' : 'Choose photo'}
              <input
                type="file"
                accept="image/*"
                hidden
                disabled={uploading !== null}
                onChange={(e) => onFile('receipt', e.target)}
              />
            </label>
          </div>
        ) : (
          <div className="field">
            <span className="field-label">Receipt photo added</span>
            <div className="fact-row" style={{ alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                {receipt.redactedUrl ? (
                  <img
                    src={receipt.redactedUrl}
                    alt="Receipt (redacted preview)"
                    style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 6 }}
                  />
                ) : (
                  <span className="unverified-chip">queued</span>
                )}
                <p className="hint" style={{ margin: 0 }}>
                  {receipt.redactedUrl
                    ? `redacted preview ready · ${receipt.redactionStatus}`
                    : 'redaction in progress — preview will appear shortly'}
                </p>
              </div>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => removeItem(receipt.id)}
              >
                Remove
              </button>
            </div>
          </div>
        )}

        <div className="btn-row" style={{ marginTop: 16 }}>
          <button type="button" className="btn btn-secondary" onClick={() => setTrack(null)}>
            Switch track
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setAutoStep(receipt ? 2 : 3)}
          >
            {receipt ? 'Continue to PII check' : 'Continue without photos'}
          </button>
        </div>
      </div>
    );
  }

  /* ------------------------------------------- auto: step 2 PII check */
  function renderPiiStep() {
    const receipt = items.find((it) => it.type === 'receipt') ?? null;
    if (!receipt) {
      // No photo — nothing to check; skip ahead.
      setAutoStep(3);
      return null;
    }
    return (
      <div className="form-card">
        <p className="hint" style={{ marginTop: 0 }}>
          This is the redacted copy that will be attached to your report — and the only
          version our receipt reader ever sees. Look it over carefully.
        </p>

        {receipt.redactedUrl ? (
          <img
            src={receipt.redactedUrl}
            alt="Redacted receipt preview"
            style={{ width: '100%', borderRadius: 8, border: '1px solid var(--border)' }}
          />
        ) : (
          <p className="hint">Redacted preview is still being prepared…</p>
        )}

        <label className="checkbox-option" style={{ marginTop: 16 }}>
          <input
            type="checkbox"
            checked={piiAttested}
            onChange={(e) => setPiiAttested(e.target.checked)}
          />
          I blacked out all personal information on this photo — card details, names,
          authorization codes, contact info, and barcodes.
        </label>

        <div className="btn-row" style={{ marginTop: 16 }}>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setAutoStep(1)}
          >
            Back
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!piiAttested}
            onClick={() => setAutoStep(3)}
          >
            Looks good — read my receipt
          </button>
        </div>
      </div>
    );
  }


  const AUTO_LABELS = ['Receipt photo', 'PII check', 'Review & submit'];
  const MANUAL_LABELS = ['Numbers', 'The facts'];

  return (
    <div>
      <p className="eyebrow">Log a report</p>
      <h1 className="page-title">Caught one in the wild?</h1>

      {/* on-device redaction editor: picked photo -> user blacks out PII ->
          only the redacted+compressed export is uploaded */}
      {editing && (
        <RedactionCanvas
          file={editing.file}
          kindLabel={KIND_LABEL[editing.kind]}
          onCancel={() => setEditing(null)}
          onDone={(redacted) => {
            const kind = editing.kind;
            setEditing(null);
            void uploadFile(kind, redacted);
          }}
        />
      )}

      {track === null && (
        <>
          <p className="page-sub">
            Snap the receipt or type the numbers — takes 60 seconds. No account needed.
          </p>
          <TrackChooser preselect={preselect} onPick={(t) => setTrack(t)} />
        </>
      )}

      {track === 'auto' && (
        <>
          <p className="page-sub">
            Snap the receipt, check our redaction, confirm the numbers, log the facts.
          </p>
          <Stepper labels={AUTO_LABELS} step={autoStep} />
          {autoStep === 1 && renderEvidenceStep()}
          {autoStep === 2 && renderPiiStep()}
          {autoStep === 3 && (
            <AutoReviewStep
              file={extractTarget?.redactedFile ?? null}
              evidenceId={extractTarget?.id ?? null}
              preselect={preselect}
              onBack={() => setAutoStep(items.length > 0 ? 2 : 1)}
              onSubmitted={() => setDone(true)}
            />
          )}
        </>
      )}

      {track === 'manual' && (
        <>
          <p className="page-sub">
            Type the numbers off the receipt — the app does the math. No account needed.
          </p>
          <Stepper labels={MANUAL_LABELS} step={manualStep} />
          {manualStep === 1 && (
            <ManualNumbersStep
              initial={manual}
              onContinue={(m) => {
                setManual(m);
                setManualStep(2);
              }}
              onBack={() => setTrack(null)}
            />
          )}
          {manualStep === 2 && (
            <FactsForm
              track="manual"
              merchants={[]}
              preselect={preselect}
              confirmedCount={0}
              prefillPresets=""
              prefillTipBase={manual.base === 'not-sure' ? '' : manual.base}
              showFees={false}
              manualFees={manual.fees}
              buildFactsLine={(tipBase) => {
                const pct = tipPercentOf(numOrNull(manual.tip), numOrNull(manual.subtotal));
                return buildFactsLine(
                  {
                    subtotal: manual.subtotal,
                    tax: manual.tax,
                    tip: manual.tip,
                    paidTotal: '',
                    tipPct: pct == null ? '' : String(Math.round(pct * 10) / 10),
                  },
                  tipBase,
                );
              }}
              confirmedIds={[]}
              onBack={() => setManualStep(1)}
              onSubmitted={() => setDone(true)}
            />
          )}
        </>
      )}
    </div>
  );
}

export default function SubmitPage() {
  return (
    <Suspense
      fallback={
        <div>
          <p className="eyebrow">Log a report</p>
          <h1 className="page-title">Caught one in the wild?</h1>
        </div>
      }
    >
      <SubmitInner />
    </Suspense>
  );
}
