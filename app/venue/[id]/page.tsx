import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { getVenueDetail } from '@/lib/score';
import type { PublicEvidence, ScoreComponent, VenueDetail } from '@/lib/score';
import {
  SERVICE_TYPE_LABELS,
  TIP_BASE_LABELS,
  FEE_LABELS,
} from '@/lib/labels';

export const dynamic = 'force-dynamic';

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}

function fmtPct(n: number): string {
  return Number.isInteger(n) ? n + '%' : n.toFixed(1) + '%';
}

/** The machine-readable "[receipt math]" line rides in notes for moderators —
 *  keep it out of the public report display. */
function publicNotes(notes: string): string {
  return notes
    .split('\n')
    .filter((l) => !l.trim().startsWith('[receipt math]'))
    .join('\n')
    .trim();
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const detail = await getVenueDetail(id);
  if (!detail) {
    return { title: 'Venue not found | TipFacts' };
  }
  const { venue, score, approvedCount, unverifiedCount } = detail;
  const state = score
    ? `squeeze score ${score.score}/100`
    : approvedCount > 0
      ? 'awaiting verified evidence'
      : 'no reports yet';
  return {
    title: `${venue.name} tipping — tip presets, tip base, service fee, squeeze score | TipFacts`,
    description: `${venue.name} in ${venue.city}: ${state}. ${approvedCount} approved report${approvedCount === 1 ? '' : 's'}${unverifiedCount ? `, ${unverifiedCount} unverified` : ''}. Objective, photo-verified tipping facts: tip presets, pre-tax vs post-tax tip base, extra service fees, guilt signals. No opinions.`,
  };
}

function EvidenceThumb({ evidence }: { evidence: PublicEvidence }) {
  if (!evidence.redactedPath) return null;
  return (
    <a
      href={evidence.redactedPath}
      target="_blank"
      rel="noreferrer"
      title="Open redacted evidence photo"
    >
      <img
        src={evidence.redactedPath}
        alt={evidence.type === 'receipt' ? 'Redacted receipt photo' : 'Redacted tip screen photo'}
        className="report-photo"
        style={{ maxWidth: 160, marginTop: 4 }}
        loading="lazy"
      />
    </a>
  );
}

/** Muted "photo-verified" marker — typography, not a colored chip. */
function VMark() {
  return <span className="vmark">✓ photo-verified</span>;
}

/**
 * The tip-facts card: the three questions a checker asks, answered in one
 * glanceable card (PRD §5.3 V.1). No chips, no bars — question, big answer,
 * one quiet sub-line.
 */
function TipFactsCard({ detail }: { detail: VenueDetail }) {
  const { backedFacts } = detail;

  // Guilt sub-facts.
  const guilt = detail.guiltStats;
  const guiltTotal = guilt.yes + guilt.no;
  const guiltPct = guiltTotal > 0 ? Math.round((guilt.yes / guiltTotal) * 100) : null;
  const watchRe = /\bwatch(?:ing|ed)?\b|\bstar(?:e|ing|ed)?\b|\bobserv(?:e|ed|ing)\b/;
  const watchCount = detail.guiltNotes.filter((n) =>
    watchRe.test(n.note.toLowerCase()),
  ).length;
  const optOut = backedFacts.easyOptOut;
  const guiltSubs: string[] = [];
  if (optOut === 'yes') guiltSubs.push('custom or no tip: easy to choose');
  else if (optOut === 'no') guiltSubs.push('custom or no tip: hard to choose');
  if (watchCount > 0)
    guiltSubs.push(
      `staff watched while choosing: mentioned in ${watchCount} report${watchCount === 1 ? '' : 's'}`,
    );

  const fees = backedFacts.fees.filter((f) => f !== 'none');
  const base = backedFacts.tipBase;

  return (
    <section className="tipfacts-card" aria-label="Tip facts">
      {/* Q1 — minimum decent tip */}
      <div className="tipfact">
        <p className="tipfact-q">Minimum decent tip</p>
        {backedFacts.minPreset === null ? (
          <p className="tipfact-empty">No data yet</p>
        ) : (
          <>
            <p className="tipfact-a">{fmtPct(backedFacts.minPreset)}</p>
            <p className="tipfact-sub">
              Lowest preset seen on a verified tip screen — the cheap person&rsquo;s
              answer. <VMark />
              {backedFacts.presets.length > 1 &&
                ` Also seen: ${backedFacts.presets.map(fmtPct).join(', ')}.`}
            </p>
          </>
        )}
      </div>

      {/* Q2 — tip tax base */}
      <div className="tipfact">
        <p className="tipfact-q">Tip calculated on</p>
        {base === '' || base === 'not-sure' ? (
          <p className="tipfact-empty">Unknown — no verified receipt settles it yet</p>
        ) : (
          <>
            <p className="tipfact-a">
              {base === 'post-tax' ? (
                <>
                  Post-tax total <span className="warn-inline">⚠</span>
                </>
              ) : (
                'Pre-tax subtotal'
              )}
            </p>
            <p className="tipfact-sub">
              {base === 'post-tax' ? (
                <>
                  A {backedFacts.minPreset !== null ? fmtPct(backedFacts.minPreset) : 'typical'}{' '}
                  tip here costs more than the same percentage at a pre-tax place.{' '}
                </>
              ) : (
                <>The less costly standard. </>
              )}
              <VMark />
            </p>
          </>
        )}
      </div>

      {/* Q3 — guilt signals */}
      <div className="tipfact">
        <p className="tipfact-q">Felt tipping pressure</p>
        {guiltPct === null ? (
          <p className="tipfact-empty">No data yet</p>
        ) : (
          <>
            <p className="tipfact-a">
              {guiltPct}% <span className="tipfact-a-sub">of {guiltTotal}</span>
            </p>
            <p className="tipfact-sub">
              of {guiltTotal} respondent{guiltTotal === 1 ? '' : 's'} said they felt
              pressure
              {guiltSubs.length > 0 && ` · ${guiltSubs.join(' · ')}`}
            </p>
          </>
        )}
      </div>

      {/* Extra fees — only when verified fees exist */}
      {fees.length > 0 && (
        <div className="tipfact">
          <p className="tipfact-q">Extra fees</p>
          <p className="tipfact-a tipfact-a-sm">
            {fees.map((f) => FEE_LABELS[f] ?? f).join(' · ')}
          </p>
          <p className="tipfact-sub">
            Spotted on verified receipts. <VMark />
          </p>
        </div>
      )}
    </section>
  );
}

/**
 * Squeeze Score, compact: the number, what drives it, and the machinery
 * behind <details> folds. Sits BELOW the tip facts (PRD §5.3 V.1).
 */
function ScoreSection({ detail }: { detail: VenueDetail }) {
  const { score, evidence } = detail;
  const byId = new Map(evidence.map((e) => [e.id, e]));

  if (!score) {
    return (
      <section className="detail-section">
        <h2>Squeeze Score</h2>
        <p className="tipfact-empty" style={{ fontSize: 17 }}>
          Awaiting evidence — nothing scored yet.
        </p>
        <p className="score-explainer">
          Scores only reflect photo-verified facts. Once a report is backed by a
          confirmed receipt or screen photo, its facts start counting.
        </p>
      </section>
    );
  }

  const drivers = [...score.components]
    .filter((c) => c.points > 0)
    .sort((a, b) => b.points - a.points)
    .slice(0, 3);

  return (
    <section className="detail-section">
      <h2>Squeeze Score</h2>
      <p className="score-num">
        {score.score}
        <span className="score-denom"> / 100</span>
      </p>
      <p className="score-explainer" style={{ marginTop: 4 }}>
        Based on {score.evidenceCount} verified photo
        {score.evidenceCount === 1 ? '' : 's'}. Higher = more aggressive tipping
        practices.
      </p>
      {drivers.length > 0 && (
        <ul className="score-drivers">
          {drivers.map((c: ScoreComponent) => (
            <li key={c.key}>
              <span className="pts">+{c.points}</span> {c.label}
            </li>
          ))}
        </ul>
      )}
      <details className="fold">
        <summary>Full breakdown</summary>
        <div style={{ marginTop: 12 }}>
          {score.components.map((c: ScoreComponent) => (
            <div key={c.key} className="score-bar-row">
              <strong>{c.label}</strong>
              <span className="pts">+{c.points}</span>
              <span className="bar" aria-hidden="true">
                <i style={{ width: `${Math.min(100, (c.points / 25) * 100)}%` }} />
              </span>
              {c.evidenceIds.length > 0 && (
                <span
                  style={{
                    gridColumn: '1 / -1',
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: 8,
                    marginTop: 4,
                  }}
                >
                  {c.evidenceIds.map((id) => {
                    const e = byId.get(id);
                    return e ? <EvidenceThumb key={id} evidence={e} /> : null;
                  })}
                </span>
              )}
            </div>
          ))}
        </div>
      </details>
      <details className="fold">
        <summary>How the score works</summary>
        <p className="score-explainer">
          Squeeze Score v2 rubric (locked): starts at 0. Table service — lowest
          preset ≤15%: +0; 16–18%: +15; above 18%: +30. Counter / takeout /
          non-food retail — any tip prompt: +25; no easy custom-tip / no-tip
          option: +10. Tip calculated on the post-tax total: +20. Extra fees —
          first fee: +10, each additional: +5. Corroborated guilt (≥2 approved
          “yes” from distinct reporters): +15, labeled community-reported. Capped
          at 100. Evidence-only: only photo-verified facts move the score.
        </p>
      </details>
    </section>
  );
}

/** One plain sentence per unverified report — no chip soup. */
function reportSentence(r: {
  serviceDate: string;
  createdAt: string;
  serviceType: string;
  presets: string;
  tipBase: string;
  fees: string[];
}): string {
  const parts: string[] = [];
  parts.push(
    r.serviceDate ? `Visited ${fmtDate(r.serviceDate + 'T12:00:00')}` : fmtDate(r.createdAt),
  );
  if (r.serviceType && SERVICE_TYPE_LABELS[r.serviceType])
    parts.push(SERVICE_TYPE_LABELS[r.serviceType]);
  if (r.presets) parts.push(`presets ${r.presets}`);
  if (r.tipBase && TIP_BASE_LABELS[r.tipBase] && r.tipBase !== 'not-sure')
    parts.push(TIP_BASE_LABELS[r.tipBase].toLowerCase());
  for (const f of r.fees) {
    if (FEE_LABELS[f] && f !== 'none') parts.push(FEE_LABELS[f].toLowerCase());
  }
  return parts.join(' · ');
}

export default async function VenuePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const detail = await getVenueDetail(id);
  if (!detail) notFound();
  const { venue } = detail;

  const hasNoData = detail.approvedCount === 0;
  const serviceTypeLabel = detail.backedFacts.serviceType
    ? SERVICE_TYPE_LABELS[detail.backedFacts.serviceType]
    : null;

  return (
    <div>
      <a href="/" className="back-link">
        ← All venues
      </a>

      {/* Plain header — the score now lives below the tip facts (PRD V.1). */}
      <p className="eyebrow">Venue file</p>
      <h1 className="page-title">{venue.name}</h1>
      <p className="page-sub">
        {serviceTypeLabel ? `${serviceTypeLabel} · ` : ''}
        {venue.city}
        {detail.approvedCount} report{detail.approvedCount === 1 ? '' : 's'} · updated{' '}
        {fmtDate(detail.lastUpdated)}
      </p>

      {venue.isSeed && (
        <div className="seed-banner">
          <strong>Fictional seed data.</strong> This venue and its reports are made-up demo
          data for development — not real reports.
        </div>
      )}

      {hasNoData ? (
        <div className="no-data-cta">
          <p>
            <strong>No tipping data yet — be the first to report.</strong> Snap the tip
            screen or your receipt and put this venue on the record.
          </p>
          <a href={`/submit?venueId=${encodeURIComponent(id)}`} className="btn btn-primary">
            Report this venue
          </a>
        </div>
      ) : (
        <>
          {/* The three questions first */}
          <TipFactsCard detail={detail} />

          {/* Score below the answers */}
          <ScoreSection detail={detail} />

          {/* Receipt stats (PRD V.2) — quiet rows */}
          <section className="detail-section">
            <h2>From receipts</h2>
            <p className="score-explainer" style={{ marginTop: 0 }}>
              Reported, not truth: what people typed from their receipts.
            </p>
            <div className="report-line">
              <strong>Median reported tip:</strong>{' '}
              {detail.receiptStats.medianReportedTip === null
                ? 'no receipt data'
                : `${detail.receiptStats.medianReportedTip}%`}
            </div>
            <div className="report-line">
              <strong>Fees seen in receipts:</strong>{' '}
              {detail.receiptStats.feeFrequency.length === 0
                ? 'none reported'
                : detail.receiptStats.feeFrequency
                    .map((f) => `${(FEE_LABELS[f.fee] ?? f.fee).toLowerCase()} ×${f.count}`)
                    .join(', ')}
            </div>
          </section>

          {detail.unevidencedReports.length > 0 && (
            <section className="detail-section">
              <h2>Community reports · unverified</h2>
              <p className="score-explainer" style={{ marginTop: 0 }}>
                Approved by moderation but no photo evidence yet — treat as unverified.
              </p>
              {detail.unevidencedReports.map((r) => (
                <div key={r.id} className="report-line">
                  {reportSentence(r)}
                  {publicNotes(r.notes) && (
                    <p className="report-note">{publicNotes(r.notes)}</p>
                  )}
                </div>
              ))}
            </section>
          )}
        </>
      )}

      <section className="detail-section" id="subjective">
        <h2>How people felt · subjective</h2>
        <p className="score-explainer" style={{ marginTop: 0 }}>
          Never scored. Individual experiences, quoted verbatim.
        </p>
        {detail.guiltNotes.length === 0 ? (
          <p className="page-sub">No pressure notes yet.</p>
        ) : (
          detail.guiltNotes.map((n) => (
            <div key={n.id} className="report-line">
              <span className="report-meta">{fmtDate(n.createdAt)}</span>
              <p className="report-note">{n.note}</p>
            </div>
          ))
        )}
      </section>

      {detail.evidence.length > 0 && (
        <section className="detail-section">
          <h2>Evidence ({detail.evidence.length})</h2>
          <p className="score-explainer" style={{ marginTop: 0 }}>
            Redacted photos only — personal data was blacked out and confirmed by the
            uploader.
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
            {detail.evidence.map((e) => (
              <div key={e.id} style={{ maxWidth: 200 }}>
                <EvidenceThumb evidence={e} />
                <div className="report-meta" style={{ marginTop: 4 }}>
                  {e.type === 'receipt' ? 'Receipt' : 'Tip screen'} · {fmtDate(e.createdAt)}
                  {e.isSeed ? ' · seed' : ''}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {detail.changelog.length > 0 && (
        <details className="fold section-fold">
          <summary>Report history ({detail.changelog.length})</summary>
          <div style={{ marginTop: 8 }}>
            {detail.changelog.map((a) => (
              <div key={a.id} className="report-line">
                <span className="report-meta">
                  {fmtDate(a.createdAt)} · {a.action === 'approved' ? 'Approved' : 'Rejected'}
                  {a.reportId ? ` · report ${a.reportId.slice(0, 8)}` : ''}
                </span>
                {a.note && <p className="report-note">{a.note}</p>}
              </div>
            ))}
          </div>
        </details>
      )}

      <p className="quiet-foot">
        Is this your business?{' '}
        <a href={`/submit?venueId=${encodeURIComponent(id)}`}>
          Dispute a fact with counter-evidence
        </a>{' '}
        — reviewed under the same evidence-only standard. No payment can alter a score.
      </p>

      <div className="btn-row" style={{ marginBottom: 32 }}>
        <a href={`/submit?venueId=${encodeURIComponent(id)}`} className="btn btn-primary">
          Report this venue
        </a>
      </div>
    </div>
  );
}
