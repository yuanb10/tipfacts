'use client';

import { useEffect, useRef, useState } from 'react';
import type { ReceiptParsed } from '@/lib/storage';
import { bestVenueMatch } from '@/lib/venue-match';

/**
 * Multi-step, receipt-first submission flow (Sprint 1):
 *   Step 1 — Add evidence (receipt / tip-screen photo upload)
 *   Step 2 — Review & confirm each photo (original vs redacted, correct OCR)
 *   Step 3 — The facts (venue + objective fields)
 *   Step 4 — Done (pending moderation)
 *
 * Evidence API contracts (sibling agent):
 *   POST /api/evidence {photo, type} ->
 *     { ok, evidence: { id, type, redactedUrl, redactionStatus, parsed, ocrAvailable } }
 *   POST /api/evidence/[id]/confirm {confirmed, attestedNoPii?, parsed?} ->
 *     { ok, evidence }
 */

type Step = 1 | 2 | 3;
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
}

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

function Stepper({ step }: { step: Step }) {
  const labels = ['Proof', 'Redaction check', 'The facts'];
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

/**
 * Venue picker for step 3: users never type a full venue name from scratch.
 *   - OCR merchant pre-fill: fuzzy-matches the receipt's merchant against
 *     known venues and proposes the best hit for confirmation.
 *   - Type-ahead: debounced search over all listings (shells included).
 *   - Nearby: optional geolocation → venues within ~800m.
 *   - Manual fallback: type a new name; it becomes a pending venue.
 * Selecting a listing posts `venueId`; the manual path posts venueName+city.
 */
function VenuePicker({ merchants }: { merchants: string[] }) {
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

  // OCR merchant pre-fill — once, on mount.
  useEffect(() => {
    if (didPrefill.current) return;
    didPrefill.current = true;
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
    // merchants is fixed for this mount (step 3 renders once per visit).
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

export default function SubmitPage() {
  const [step, setStep] = useState<Step>(1);
  const [items, setItems] = useState<EvidenceItem[]>([]);
  const [uploading, setUploading] = useState<EvidenceKind | null>(null);
  const [step1Error, setStep1Error] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

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
    if (file) void uploadFile(kind, file);
  }

  function removeItem(id: string) {
    setItems((prev) => prev.filter((it) => it.id !== id));
  }

  async function confirmItem(item: EvidenceItem) {
    const needsAttestation = !item.ocrAvailable || !item.redactedUrl;
    if (needsAttestation && !item.attested) {
      patchItem(item.id, {
        error: 'Please check the box to confirm you reviewed the photo for personal info.',
      });
      return;
    }
    patchItem(item.id, { confirming: true, error: '' });
    try {
      const parsed: ReceiptParsed = {
        merchant: item.draft.merchant.trim() || null,
        purchasedAt: null,
        subtotal: numOrNull(item.draft.subtotal),
        tax: numOrNull(item.draft.tax),
        tip: numOrNull(item.draft.tip),
        total: numOrNull(item.draft.total),
        fees: item.draft.fees
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
          .map((label) => ({ label, amount: null })),
        presets: parsePresetList(item.draft.presets),
        tipPercentReported: null,
        rawText: null,
        ocrEngine: 'manual',
        ocrConfidence: null,
      };
      const res = await fetch(`/api/evidence/${item.id}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          confirmed: true,
          attestedNoPii: item.attested || undefined,
          parsed,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        patchItem(item.id, {
          confirming: false,
          error: data.error || 'Could not confirm. Please try again.',
        });
        return;
      }
      const ev = data.evidence ?? {};
      patchItem(item.id, {
        confirming: false,
        confirmed: ev.userConfirmed !== false,
        redactedUrl: ev.redactedUrl ?? ev.redactedPath ?? item.redactedUrl,
        redactionStatus: ev.redactionStatus ?? item.redactionStatus,
        draft: ev.parsed ? draftFromParsed(ev.parsed as SiblingParsed) : item.draft,
      });
    } catch {
      patchItem(item.id, { confirming: false, error: 'Network error. Please try again.' });
    }
  }

  const unconfirmed = items.filter((it) => !it.confirmed);

  function goStep2() {
    if (items.length > 0) setStep(2);
    else setStep(3);
  }

  async function onSubmitFacts(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const form = e.currentTarget;
      const body = new FormData(form);
      body.set('evidenceIds', JSON.stringify(items.filter((it) => it.confirmed).map((it) => it.id)));
      const res = await fetch('/api/submissions', { method: 'POST', body });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data.error || 'Something went wrong. Please try again.');
      } else {
        setDone(true);
        window.scrollTo(0, 0);
      }
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  function resetAll() {
    setStep(1);
    setItems([]);
    setError('');
    setStep1Error('');
    setDone(false);
  }

  // ---------------------------------------------------------- done (step 4)
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

  return (
    <div>
      <p className="eyebrow">Log a report</p>
      <h1 className="page-title">Caught one in the wild?</h1>
      <p className="page-sub">
        Snap the receipt, check our redaction, log the facts. Takes 60 seconds. No account
        needed — and nothing publishes until you confirm the redacted version.
      </p>
      <Stepper step={step} />

      {/* ------------------------------------------------- step 1: evidence */}
      {step === 1 && (
        <div className="form-card">
          {step1Error && <div className="form-error">{step1Error}</div>}

          <p className="hint" style={{ marginTop: 0 }}>
            Photos go through redaction review in step 2 — nothing publishes until you confirm
            the redacted version. Please no staff faces.
          </p>

          {(['receipt', 'screen'] as EvidenceKind[]).map((kind) => (
            <div className="field" key={kind}>
              <span className="field-label">
                {kind === 'receipt' ? 'Receipt photo' : 'Tip-screen photo'}
              </span>
              <label className="btn btn-secondary">
                {uploading === kind ? 'Uploading…' : 'Choose photo'}
                <input
                  type="file"
                  accept="image/*"
                  hidden
                  disabled={uploading !== null}
                  onChange={(e) => onFile(kind, e.target)}
                />
              </label>
            </div>
          ))}

          {items.length > 0 && (
            <div className="field">
              <span className="field-label">Added photos ({items.length})</span>
              {items.map((it) => (
                <div key={it.id} className="fact-row" style={{ alignItems: 'center' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    {it.redactedUrl ? (
                      <img
                        src={it.redactedUrl}
                        alt={`${KIND_LABEL[it.type]} (redacted preview)`}
                        style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 6 }}
                      />
                    ) : (
                      <span className="unverified-chip">queued</span>
                    )}
                    <div>
                      <div>{KIND_LABEL[it.type]}</div>
                      <p className="hint" style={{ margin: 0 }}>
                        {it.redactedUrl
                          ? `redacted preview ready · ${it.redactionStatus}`
                          : 'redaction in progress — preview will appear shortly'}
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => removeItem(it.id)}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="btn-row" style={{ marginTop: 16 }}>
            <button type="button" className="btn btn-primary" onClick={goStep2}>
              {items.length > 0 ? 'Continue to review' : 'Continue without photos'}
            </button>
          </div>
        </div>
      )}

      {/* -------------------------------------------- step 2: review & confirm */}
      {step === 2 && (
        <div>
          {items.map((it, idx) => (
            <div className="form-card" key={it.id} style={{ marginBottom: 16 }}>
              <h2 style={{ fontSize: 18, marginTop: 0 }}>
                {KIND_LABEL[it.type]} ({idx + 1} of {items.length})
              </h2>

              {it.confirmed ? (
                <div className="form-success">
                  <p style={{ margin: 0 }}>
                    <strong>Confirmed.</strong> This photo&apos;s redacted version is approved
                    for the report.
                  </p>
                </div>
              ) : (
                <>
                  <div className="photo-compare">
                    <div>
                      <span className="photo-tag">Only you see this</span>
                      <p className="field-label">Original</p>
                      <img
                        src={`/api/evidence/${it.id}/original`}
                        alt={`${KIND_LABEL[it.type]} original`}
                      />
                    </div>
                    <div>
                      <span className="photo-tag">This is what publishes</span>
                      <p className="field-label">Redacted</p>
                      {it.redactedUrl ? (
                        <img
                          src={it.redactedUrl}
                          alt={`${KIND_LABEL[it.type]} redacted`}
                        />
                      ) : (
                        <p className="hint">
                          Redacted version not available yet — review the original carefully.
                          Confirming will also cover the redacted copy once it&apos;s ready.
                        </p>
                      )}
                    </div>
                  </div>

                  {it.error && <div className="form-error">{it.error}</div>}

                  <div className="field" style={{ marginTop: 12 }}>
                    <span className="field-label">
                      Check the numbers — fix anything the scan got wrong
                    </span>
                    <div className="field">
                      <label className="field-label" htmlFor={`merchant-${it.id}`}>
                        Merchant
                      </label>
                      <input
                        type="text"
                        id={`merchant-${it.id}`}
                        value={it.draft.merchant}
                        maxLength={120}
                        onChange={(e) =>
                          patchItem(it.id, { draft: { ...it.draft, merchant: e.target.value } })
                        }
                      />
                    </div>
                    {(
                      [
                        ['subtotal', 'Subtotal'],
                        ['tax', 'Tax'],
                        ['tip', 'Tip'],
                        ['total', 'Total'],
                      ] as const
                    ).map(([key, label]) => (
                      <div className="field" key={key}>
                        <label className="field-label" htmlFor={`${key}-${it.id}`}>
                          {label}
                        </label>
                        <input
                          type="text"
                          inputMode="decimal"
                          id={`${key}-${it.id}`}
                          value={it.draft[key]}
                          maxLength={20}
                          onChange={(e) =>
                            patchItem(it.id, { draft: { ...it.draft, [key]: e.target.value } })
                          }
                        />
                      </div>
                    ))}
                    <div className="field">
                      <label className="field-label" htmlFor={`presets-${it.id}`}>
                        Tip presets shown
                      </label>
                      <input
                        type="text"
                        id={`presets-${it.id}`}
                        value={it.draft.presets}
                        placeholder="e.g. 20, 25, 30"
                        maxLength={60}
                        onChange={(e) =>
                          patchItem(it.id, { draft: { ...it.draft, presets: e.target.value } })
                        }
                      />
                    </div>
                    <div className="field">
                      <label className="field-label" htmlFor={`fees-${it.id}`}>
                        Fees on the receipt
                      </label>
                      <input
                        type="text"
                        id={`fees-${it.id}`}
                        value={it.draft.fees}
                        placeholder="e.g. service charge, card surcharge"
                        maxLength={120}
                        onChange={(e) =>
                          patchItem(it.id, { draft: { ...it.draft, fees: e.target.value } })
                        }
                      />
                    </div>
                  </div>

                  {!it.ocrAvailable && (
                    <div className="field">
                      <p className="hint">
                        <strong>
                          Automatic redaction isn&apos;t available here — please cover card
                          numbers, names, and barcodes in your photo before uploading.
                        </strong>
                      </p>
                      <label className="checkbox-option">
                        <input
                          type="checkbox"
                          checked={it.attested}
                          onChange={(e) => patchItem(it.id, { attested: e.target.checked })}
                        />
                        I checked this photo for personal info (card numbers, auth codes, contact
                        info, barcodes)
                      </label>
                    </div>
                  )}
                  {!it.redactedUrl && it.ocrAvailable && (
                    <div className="field">
                      <label className="checkbox-option">
                        <input
                          type="checkbox"
                          checked={it.attested}
                          onChange={(e) => patchItem(it.id, { attested: e.target.checked })}
                        />
                        I checked this photo for personal info (card numbers, auth codes, contact
                        info, barcodes)
                      </label>
                    </div>
                  )}

                  <button
                    type="button"
                    className="submit-btn"
                    disabled={it.confirming}
                    onClick={() => confirmItem(it)}
                  >
                    {it.confirming ? 'Confirming…' : 'Confirm this photo'}
                  </button>
                </>
              )}
            </div>
          ))}

          {unconfirmed.length > 0 && (
            <div className="form-error">
              Still unconfirmed: {unconfirmed.map((it) => KIND_LABEL[it.type]).join(', ')}. Photos
              aren&apos;t attached until you confirm each one above.
            </div>
          )}

          <div className="btn-row" style={{ marginTop: 16 }}>
            <button type="button" className="btn btn-secondary" onClick={() => setStep(1)}>
              Back
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={unconfirmed.length > 0}
              onClick={() => setStep(3)}
            >
              Continue to the facts
            </button>
          </div>
        </div>
      )}

      {/* --------------------------------------------------- step 3: the facts */}
      {step === 3 && (
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
            {items.length > 0
              ? `Evidence attached: ${items.length} confirmed photo${items.length > 1 ? 's' : ''}.`
              : 'No photos attached.'}{' '}
            Objective facts only — they feed the score.
          </p>

          <VenuePicker merchants={items.map((it) => it.draft.merchant)} />

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
            />
          </div>

          <div className="field">
            <span className="field-label">Was the tip calculated pre-tax or post-tax?</span>
            <div className="radio-group">
              {[
                ['pre-tax', 'Pre-tax subtotal'],
                ['post-tax', 'Post-tax total'],
                ['not-sure', 'Not sure'],
              ].map(([val, label]) => (
                <label key={val} className="radio-option">
                  <input type="radio" name="tipBase" value={val} />
                  {label}
                </label>
              ))}
            </div>
          </div>

          <div className="field">
            <span className="field-label">Any extra fees?</span>
            <div className="checkbox-group">
              {[
                ['service-charge', 'Service charge'],
                ['card-surcharge', 'Credit-card surcharge'],
                ['none', 'None'],
                ['other', 'Other'],
              ].map(([val, label]) => (
                <label key={val} className="checkbox-option">
                  <input type="checkbox" name="fees" value={val} />
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
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setStep(items.length > 0 ? 2 : 1)}
            >
              Back
            </button>
            <button type="submit" className="submit-btn" disabled={submitting}>
              {submitting ? 'Submitting…' : 'Submit report'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
