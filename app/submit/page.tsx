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
 *     photo never leaves the device, only the redacted export is uploaded) +
 *     PII check on the same screen: the redacted copy is shown back and the
 *     user attests all personal info is blacked out (extraction is gated on
 *     this) → 2 review & submit: POST /api/receipt/extract receives ONLY the
 *     redacted JPEG bytes, then ONE page shows editable VLM-prefilled values +
 *     venue matching + all report questions; the user confirms/corrects every
 *     value (never auto-published), evidence is confirmed with the attestation
 *     at submit time → done.
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
  /** Local object URL for the redacted export — the preview source when the
   * server has no redacted copy (e.g. no OCR available locally). */
  localPreviewUrl: string;
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

const FEE_LABELS: Record<string, string> = Object.fromEntries(FEE_OPTIONS);

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
  // The search box doubles as the new-venue name: pick a match and we file
  // under that listing; keep what you typed and we add it as a new venue.
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<VenueHit[]>([]);
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'detected' | 'new'; text: string } | null>(null);
  const [nearby, setNearby] = useState<VenueHit[] | null>(null);
  const [locating, setLocating] = useState(false);
  const [locError, setLocError] = useState('');
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
          setQuery(merchant);
          setNotice({
            kind: 'new',
            text: `We couldn't find "${merchant}" in our listings — we'll add it as a new venue when you submit.`,
          });
        }
      } catch {
        if (!cancelled) setQuery(merchant);
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
    setQuery(selected?.name ?? '');
    setSelected(null);
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
            <input type="hidden" name="venueName" value={selected.name} />
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
              name="venueName"
              required
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onFocus={() => {
                if (results.length) setOpen(true);
              }}
              placeholder="Start typing a venue name…"
              maxLength={80}
              autoComplete="off"
              aria-label="Venue name — search our listings or type a new one"
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
                No matches — what you&apos;ve typed will be added as a new venue.
              </p>
            )}
            <p className="hint" style={{ marginTop: 4 }}>
              Pick a match, or keep typing — a new venue is added on submit.
            </p>
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
                    No listed venues within 800m — search by name, or keep what
                    you&apos;ve typed to add it as new.
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
    </div>
  );
}

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
  /** Edited on the review page (not asked on the numbers step). */
  paidTotal: string;
  /** Tip % override — empty means "show the live-computed %". */
  tipPct: string;
  fees: string[];
  base: 'pre-tax' | 'post-tax' | 'not-sure';
  /** True once the user explicitly picked a base — the live guess stops overriding it. */
  baseExplicit: boolean;
}

const EMPTY_MANUAL: ManualNums = {
  subtotal: '',
  tax: '',
  tip: '',
  paidTotal: '',
  tipPct: '',
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
          onClick={() => onContinue({ ...initial, subtotal, tax, tip, fees, base, baseExplicit: baseLocked })}
        >
          Continue
        </button>
      </div>
    </div>
  );
}

/* -------- shared receipt-values editor (both tracks' final review page).

Subtotal / tax / tip / extra fees / paid total / tip % (pre-tax), editable.
Auto track pre-fills it from the VLM; manual track pre-fills it from the
numbers typed on the previous step, so both tracks ask the same questions. */

interface ReceiptValueFields {
  subtotal: string;
  tax: string;
  tip: string;
  paidTotal: string;
}

function ReceiptValuesBlock({
  idPrefix,
  values,
  onValuesChange,
  tipPct,
  onTipPctChange,
  fees,
  onFeesChange,
  hint,
  feeHint,
  emptyFeeHint,
  renderFeeInputs,
}: {
  idPrefix: string;
  values: ReceiptValueFields;
  onValuesChange: (v: ReceiptValueFields) => void;
  /** Kept separate so the manual track can show a live-computed % until the
      user overrides it. */
  tipPct: string;
  onTipPctChange: (v: string) => void;
  fees: string[];
  onFeesChange: (f: string[]) => void;
  /** Hint under the "Receipt values" label. */
  hint: React.ReactNode;
  /** Hint under the fee chips. */
  feeHint: string;
  /** Shown when no fees are set. */
  emptyFeeHint: string;
  /** Auto track posts fees via hidden inputs; manual appends them at submit. */
  renderFeeInputs: boolean;
}) {
  const set =
    (k: keyof ReceiptValueFields) => (e: React.ChangeEvent<HTMLInputElement>) =>
      onValuesChange({ ...values, [k]: e.target.value });
  const activeFees = fees.filter((f) => f !== 'none');
  return (
    <div className="field">
      <span className="field-label">Receipt values — fix anything wrong</span>
      {hint}

      {(
        [
          ['subtotal', 'Subtotal'],
          ['tax', 'Tax'],
          ['tip', 'Tip'],
        ] as const
      ).map(([key, label]) => (
        <div className="field" key={key}>
          <label className="field-label" htmlFor={`${idPrefix}-${key}`}>
            {label}
          </label>
          <input
            type="text"
            inputMode="decimal"
            id={`${idPrefix}-${key}`}
            value={values[key]}
            maxLength={20}
            onChange={set(key)}
          />
        </div>
      ))}

      <div className="field">
        <span className="field-label">Extra fees</span>
        {renderFeeInputs &&
          activeFees.map((v) => <input key={v} type="hidden" name="fees" value={v} />)}
        <div className="chip-row">
          {activeFees.map((v) => (
            <span key={v} className="chip-option">
              {FEE_LABELS[v] ?? v}
              <button
                type="button"
                aria-label={`Remove ${FEE_LABELS[v] ?? v}`}
                onClick={() => onFeesChange(fees.filter((f) => f !== v))}
                style={{
                  marginLeft: 6,
                  border: 'none',
                  background: 'none',
                  cursor: 'pointer',
                  fontSize: 14,
                  lineHeight: 1,
                  color: 'inherit',
                  padding: '2px 4px',
                }}
              >
                ×
              </button>
            </span>
          ))}
          <select
            value=""
            aria-label="Add a fee"
            onChange={(e) => {
              const v = e.target.value;
              if (v)
                onFeesChange(
                  fees.includes(v) ? fees : [...fees.filter((f) => f !== 'none'), v],
                );
            }}
            style={{
              padding: '8px 10px',
              borderRadius: 999,
              border: '1px dashed var(--line)',
              background: 'none',
              color: 'var(--ink)',
              fontSize: 14,
              cursor: 'pointer',
            }}
          >
            <option value="">+ Add fee…</option>
            {FEE_OPTIONS.filter(([v]) => v !== 'none' && !fees.includes(v)).map(
              ([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ),
            )}
          </select>
        </div>
        {activeFees.length === 0 && (
          <p className="hint" style={{ margin: '4px 0 0' }}>
            {emptyFeeHint}
          </p>
        )}
        <p className="hint">{feeHint}</p>
      </div>

      <div className="field">
        <label className="field-label" htmlFor={`${idPrefix}-paidTotal`}>
          Paid total
        </label>
        <input
          type="text"
          inputMode="decimal"
          id={`${idPrefix}-paidTotal`}
          value={values.paidTotal}
          maxLength={20}
          onChange={set('paidTotal')}
        />
      </div>

      <div className="field">
        <label className="field-label" htmlFor={`${idPrefix}-tipPct`}>
          Tip percentage (pre-tax)
        </label>
        <input
          type="text"
          inputMode="decimal"
          id={`${idPrefix}-tipPct`}
          value={tipPct}
          maxLength={10}
          placeholder="e.g. 20"
          onChange={(e) => onTipPctChange(e.target.value)}
        />
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

/** Map a VLM-extracted fee label onto the report's fixed fee checkboxes. */
function vlmFeeToValues(label: string): string[] {
  const l = label.toLowerCase();
  if (/service|svc\b/.test(l)) return ['service-charge'];
  if (/card|credit|surcharge|processing|convenience/.test(l)) return ['card-surcharge'];
  return ['other'];
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
  previewUrl,
  preselect,
  onBack,
  onSubmitted,
}: {
  /** The redacted JPEG — the same bytes already uploaded via /api/evidence. */
  file: File | null;
  /** Evidence id to confirm at submit time (null when no photo was uploaded). */
  evidenceId: string | null;
  /** Preview of the redacted copy (server copy, else the on-device export). */
  previewUrl: string | null;
  preselect: PreselectVenue | null;
  onBack: () => void;
  onSubmitted: () => void;
}) {
  const [status, setStatus] = useState<ExtractStatus>('reading');
  const [fields, setFields] = useState<ConfirmedNumbers>(EMPTY_NUMBERS);
  const [venueHint, setVenueHint] = useState('');
  const [minTip, setMinTip] = useState('');
  const [feeValues, setFeeValues] = useState<string[]>([]);
  const [extractError, setExtractError] = useState('');
  const didRun = useRef(false);

  // Call the extraction endpoint. It receives only the redacted image
  // bytes — the original photo is never sent anywhere. This only runs after
  // the user attested (step 1) that all PII is blacked out.
  async function runExtraction() {
    if (!file) {
      setStatus('fallback');
      return;
    }
    try {
      const body = new FormData();
      body.append('image', file, 'redacted.jpg');
      const res = await fetch('/api/receipt/extract', { method: 'POST', body });
      const data = await res.json().catch(() => null);
      if (res.ok && data && data.ok && data.data) {
        const extracted = data.data as ExtractedReceipt;
        setFields(numbersFromExtracted(extracted));
        setVenueHint(extracted.venue ?? '');
        const presets = extracted.presets ?? [];
        setMinTip(presets.length ? String(Math.min(...presets)) : '');
        setFeeValues([
          ...new Set((extracted.fees ?? []).flatMap((f) => vlmFeeToValues(f.label))),
        ]);
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
        setMinTip('');
        setFeeValues([]);
        setStatus('fallback');
      }
    } catch (err) {
      setExtractError(
        process.env.NODE_ENV === 'development'
          ? `Extraction failed: ${err instanceof Error ? err.message : String(err)}`
          : '',
      );
      setMinTip('');
      setFeeValues([]);
      setStatus('fallback');
    }
  }

  useEffect(() => {
    if (didRun.current) return;
    didRun.current = true;
    void runExtraction();
    // file is fixed for this mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function set<K extends keyof ConfirmedNumbers>(k: K, v: ConfirmedNumbers[K]) {
    setFields((prev) => ({ ...prev, [k]: v }));
  }

  // Confirm the evidence (attesting no PII + corrected parsed values) right
  // before the report is submitted. The merchant recorded on the evidence is
  // the venue the user finally picked — their correction of the VLM hint.
  async function prepareEvidence(
    venueName: string,
  ): Promise<{ ids: string[] } | { error: string }> {
    if (!evidenceId) return { ids: [] };
    try {
      const parsed: Partial<ReceiptParsed> = {
        merchant: venueName || venueHint || undefined,
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
    setStatus('reading');
    setExtractError('');
    setMinTip('');
    setFeeValues([]);
    void runExtraction();
  }

  if (status === 'reading') {
    return (
      <div className="form-card">
        <h2 style={{ fontSize: 18, marginTop: 0 }}>Reading your receipt</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '16px 0' }}>
          <div className="spinner" aria-hidden="true" />
          <p className="hint" style={{ margin: 0 }}>
            This takes a few seconds. Only the redacted copy you approved is being
            read — the original never left your device.
          </p>
        </div>
        <div className="btn-row" style={{ marginTop: 16 }}>
          <button type="button" className="btn btn-secondary" onClick={onBack}>
            Back
          </button>
        </div>
      </div>
    );
  }

  const receiptBlock = (
    <>
      {status !== 'ready' && (
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
      <ReceiptValuesBlock
        idPrefix="ar"
        values={{
          subtotal: fields.subtotal,
          tax: fields.tax,
          tip: fields.tip,
          paidTotal: fields.paidTotal,
        }}
        onValuesChange={(v) => setFields((prev) => ({ ...prev, ...v }))}
        tipPct={fields.tipPct}
        onTipPctChange={(v) => set('tipPct', v)}
        fees={feeValues}
        onFeesChange={setFeeValues}
        hint={
          status === 'ready' ? (
            <p className="hint" style={{ marginTop: 0 }}>
              Pre-filled from your redacted photo. Nothing publishes until you submit.
            </p>
          ) : null
        }
        feeHint="Detected on your receipt — fix it if wrong."
        emptyFeeHint="None detected on the receipt."
        renderFeeInputs
      />
    </>
  );

  return (
    <>
      {previewUrl && (
        <div className="form-card" style={{ marginBottom: 16 }}>
          <span className="field-label">Attached receipt (redacted)</span>
          <img
            src={previewUrl}
            alt="Redacted receipt attached to this report"
            style={{
              display: 'block',
              maxWidth: '100%',
              maxHeight: '60vh',
              width: 'auto',
              margin: '8px auto 0',
              borderRadius: 8,
              border: '1px solid var(--line)',
            }}
          />
        </div>
      )}
      <FactsForm
        track="auto"
        merchants={venueHint ? [venueHint] : []}
        preselect={preselect}
        confirmedCount={evidenceId ? 1 : 0}
        prefillMinTip={minTip}
        prefillTipBase={fields.taxBase}
        manualFees={[]}
        buildFactsLine={(tipBase) => buildFactsLine(fields, tipBase)}
        confirmedIds={[]}
        receiptBlock={receiptBlock}
        prepareEvidence={prepareEvidence}
        venueKey={venueHint}
        onBack={onBack}
        onSubmitted={onSubmitted}
      />
    </>
  );
}

/* --------------------------------- shared final step: the facts + 3 questions */

function FactsForm({
  track,
  merchants,
  preselect,
  confirmedCount,
  prefillMinTip,
  prefillTipBase,
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
  prefillMinTip: string;
  prefillTipBase: 'pre-tax' | 'post-tax' | 'not-sure' | '';
  manualFees: string[];
  buildFactsLine: (tipBase: string) => string;
  confirmedIds: string[];
  /** Auto track: editable VLM-prefilled receipt values, rendered after venue. */
  receiptBlock?: React.ReactNode;
  /** Auto track: confirm evidence (PII attested + parsed values) at submit time. */
  prepareEvidence?: (venueName: string) => Promise<{ ids: string[] } | { error: string }>;
  /** Auto track: remount VenuePicker when the VLM venue hint arrives. */
  venueKey?: string;
  onBack: () => void;
  onSubmitted: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  // Local YYYY-MM-DD for the service-date default/max (no timezone shift).
  const todayStr = (() => {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  })();

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
        const prepared = await prepareEvidence(
          String(body.get('venueName') ?? '').trim(),
        );
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
      body.set('notes', buildFactsLine(String(body.get('tipBase') ?? '')));
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

      <div className="field">
        <label className="field-label" htmlFor="serviceDate">
          Service date
        </label>
        <input
          type="date"
          id="serviceDate"
          name="serviceDate"
          defaultValue={todayStr}
          max={todayStr}
        />
        <p className="hint">When did you visit? Defaults to today.</p>
      </div>

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
        <label className="field-label" htmlFor="minTip">
          Lowest tip % suggested
        </label>
        <input
          type="text"
          inputMode="decimal"
          id="minTip"
          name="presets"
          placeholder="e.g. 18"
          maxLength={6}
          defaultValue={prefillMinTip}
        />
        <p className="hint">
          {prefillMinTip ? 'Pre-filled from your receipt — fix it if wrong. ' : ''}
          The smallest tip percentage this place suggested. Leave blank if there
          wasn&apos;t one.
        </p>
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
          Anything else? (optional)
        </label>
        <textarea id="experienceNote" name="experienceNote" maxLength={1000} />
        <p className="hint">
          How it felt, or feedback for us — shown with your report, never affects
          the score. No staff names.
        </p>
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
  src: {
    subtotal: string;
    tax: string;
    tip: string;
    paidTotal: string;
    tipPct: string;
    fees?: string;
  } | null,
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
  push('fees', src.fees ?? '');
  if (tipBase) bits.push(`base=${tipBase}`);
  return bits.length ? '[receipt math] ' + bits.join(' · ') : '';
}

/* ------------------------------------------------------------------ page */

function SubmitInner() {
  const searchParams = useSearchParams();
  const [track, setTrack] = useState<Track | null>(null);
  const [preselect, setPreselect] = useState<PreselectVenue | null>(null);
  const [autoStep, setAutoStep] = useState<1 | 2>(1);
  const [manualStep, setManualStep] = useState<1 | 2>(1);
  const [items, setItems] = useState<EvidenceItem[]>([]);
  const [uploading, setUploading] = useState<EvidenceKind | null>(null);
  const [step1Error, setStep1Error] = useState('');
  const [editing, setEditing] = useState<{ kind: EvidenceKind; file: File } | null>(null);
  // The original picked photo, kept so "Re-do blackout" can reopen the
  // canvas without asking the user to pick the file again.
  const [originalReceipt, setOriginalReceipt] = useState<File | null>(null);
  const [piiAttested, setPiiAttested] = useState(false);
  const [manual, setManual] = useState<ManualNums>({ ...EMPTY_MANUAL });
  const [done, setDone] = useState(false);

  const receiptId = items.find((it) => it.type === 'receipt')?.id ?? null;
  // A removed or replaced receipt invalidates any earlier PII attestation, so
  // a newly picked photo can never inherit an old checkbox confirmation.
  useEffect(() => {
    setPiiAttested(false);
  }, [receiptId]);

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
          // Local preview: the server only has a redacted copy when OCR ran.
          localPreviewUrl: URL.createObjectURL(file),
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
    if (file) {
      if (kind === 'receipt') setOriginalReceipt(file);
      setEditing({ kind, file });
    }
  }

  function removeItem(id: string) {
    setItems((prev) => {
      const doomed = prev.find((it) => it.id === id);
      if (doomed) URL.revokeObjectURL(doomed.localPreviewUrl);
      return prev.filter((it) => it.id !== id);
    });
  }


  const unconfirmed = items.filter((it) => !it.confirmed);
  const confirmedIds = items.filter((it) => it.confirmed).map((it) => it.id);

  // Manual track: live-computed tip % for the review page. Stays live until
  // the user overrides the % input, which writes manual.tipPct.
  const manualComputedPct = (() => {
    const p = tipPercentOf(numOrNull(manual.tip), numOrNull(manual.subtotal));
    return p == null ? '' : String(Math.round(p * 10) / 10);
  })();

  // Evidence confirmation is postponed until final submit (AutoReviewStep's
  // prepareEvidence confirms with the PII attestation + corrected values).
  const withFile = items.filter((it) => it.redactedFile);
  const extractTarget =
    withFile.find((it) => it.type === 'receipt') ?? withFile[0] ?? null;

  function resetAll() {
    setItems((prev) => {
      prev.forEach((it) => URL.revokeObjectURL(it.localPreviewUrl));
      return [];
    });
    setOriginalReceipt(null);
    setEditing(null);
    setTrack(null);
    setAutoStep(1);
    setManualStep(1);
    setStep1Error('');
    setPiiAttested(false);
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
          <h2>Thanks — your report is live.</h2>
          <p>It&apos;s in the directory now. One more while you&apos;re at it?</p>
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

  /* ------------------------------------------- auto: step 1 receipt + PII check */
  function renderEvidenceStep() {
    const receipt = items.find((it) => it.type === 'receipt') ?? null;
    // Prefer the server's redacted copy; fall back to the on-device export
    // (the server only makes its own copy when OCR is available).
    const previewUrl = receipt ? (receipt.redactedUrl ?? receipt.localPreviewUrl) : null;
    return (
      <div className="form-card">
        {step1Error && <div className="form-error">{step1Error}</div>}

        <p className="hint" style={{ marginTop: 0 }}>
          Upload your receipt photo. You&apos;ll black out private details yourself right
          after picking it — the original never leaves your device. Then confirm the
          redaction below. Nothing publishes until you review and submit. Please no
          staff faces.
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
            <span className="field-label">
              Redacted copy — this is what gets attached and read
            </span>
            {previewUrl ? (
              <img
                src={previewUrl}
                alt="Receipt (redacted preview)"
                style={{
                  display: 'block',
                  maxWidth: '100%',
                  maxHeight: '60vh',
                  width: 'auto',
                  margin: '0 auto',
                  borderRadius: 8,
                  border: '1px solid var(--line)',
                }}
              />
            ) : (
              <p className="hint">Redacted preview is still being prepared…</p>
            )}
            <label className="checkbox-option" style={{ marginTop: 12 }}>
              <input
                type="checkbox"
                checked={piiAttested}
                disabled={!previewUrl}
                onChange={(e) => setPiiAttested(e.target.checked)}
              />
              I blacked out all personal information on this photo — card details, names,
              authorization codes, contact info, and barcodes.
            </label>
            <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={!originalReceipt}
                onClick={() => {
                  if (!originalReceipt) return;
                  removeItem(receipt.id);
                  setEditing({ kind: 'receipt', file: originalReceipt });
                }}
              >
                Re-do blackout
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  removeItem(receipt.id);
                  setOriginalReceipt(null);
                }}
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
            disabled={!receipt || !piiAttested}
            onClick={() => setAutoStep(2)}
          >
            {receipt ? 'Looks good — read my receipt' : 'Add a receipt photo to continue'}
          </button>
        </div>
      </div>
    );
  }


  const AUTO_LABELS = ['Receipt photo', 'Review & submit'];
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
          {autoStep === 2 && (
            <AutoReviewStep
              file={extractTarget?.redactedFile ?? null}
              evidenceId={extractTarget?.id ?? null}
              previewUrl={
                extractTarget
                  ? (extractTarget.redactedUrl ?? extractTarget.localPreviewUrl)
                  : null
              }
              preselect={preselect}
              onBack={() => setAutoStep(1)}
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
              prefillMinTip=""
              prefillTipBase={manual.base === 'not-sure' ? '' : manual.base}
              manualFees={manual.fees}
              buildFactsLine={(tipBase) =>
                buildFactsLine(
                  {
                    subtotal: manual.subtotal,
                    tax: manual.tax,
                    tip: manual.tip,
                    paidTotal: manual.paidTotal,
                    tipPct: manual.tipPct || manualComputedPct,
                  },
                  tipBase,
                )
              }
              receiptBlock={
                <ReceiptValuesBlock
                  idPrefix="mr"
                  values={{
                    subtotal: manual.subtotal,
                    tax: manual.tax,
                    tip: manual.tip,
                    paidTotal: manual.paidTotal,
                  }}
                  onValuesChange={(v) =>
                    setManual((m) => ({
                      ...m,
                      subtotal: v.subtotal,
                      tax: v.tax,
                      tip: v.tip,
                      paidTotal: v.paidTotal,
                    }))
                  }
                  tipPct={manual.tipPct || manualComputedPct}
                  onTipPctChange={(v) => setManual((m) => ({ ...m, tipPct: v }))}
                  fees={manual.fees}
                  onFeesChange={(f) => setManual((m) => ({ ...m, fees: f }))}
                  hint={
                    <p className="hint" style={{ marginTop: 0 }}>
                      From the numbers you typed — fix anything wrong.
                    </p>
                  }
                  feeHint="From the numbers you typed — fix it if wrong."
                  emptyFeeHint="No extra fees."
                  renderFeeInputs={false}
                />
              }
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
