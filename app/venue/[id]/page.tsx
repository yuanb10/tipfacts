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

/** "They ask X% · People pay Y–Z%" — the one thing a customer opens the page for. */
function AskPayCard({ detail }: { detail: VenueDetail }) {
  const ask = detail.backedFacts.minPreset;
  const pay = detail.receiptStats.tipRange;
  const lo = pay === null ? null : Math.round(pay.min);
  const hi = pay === null ? null : Math.round(pay.max);
  return (
    <section className="askpay-card" aria-label="What to tip here">
      <div className="askpay-col">
        <p className="askpay-label">They ask</p>
        {ask === null ? (
          <p className="askpay-empty">No data yet</p>
        ) : (
          <>
            <p className="askpay-num">{fmtPct(ask)}</p>
            <p className="askpay-sub">lowest preset on the tip screen</p>
          </>
        )}
      </div>
      <div className="askpay-divider" aria-hidden="true" />
      <div className="askpay-col">
        <p className="askpay-label">People pay</p>
        {pay === null || lo === null || hi === null ? (
          <p className="askpay-empty">No data yet</p>
        ) : (
          <>
            <p className="askpay-num">{lo === hi ? `${lo}%` : `${lo}–${hi}%`}</p>
            <p className="askpay-sub">
              from {pay.count} receipt{pay.count === 1 ? '' : 's'}
            </p>
          </>
        )}
      </div>
    </section>
  );
}

/** The fine print: tip math, extra fees, pressure. Only rows with data. */
function FinePrint({ detail }: { detail: VenueDetail }) {
  const base = detail.backedFacts.tipBase;
  const fees = detail.backedFacts.fees.filter((f) => f !== 'none');
  const guilt = detail.guiltStats;
  const guiltTotal = guilt.yes + guilt.no;
  const guiltPct = guiltTotal > 0 ? Math.round((guilt.yes / guiltTotal) * 100) : null;

  const rows: { label: string; value: React.ReactNode }[] = [];
  if (base === 'post-tax')
    rows.push({
      label: 'Tip math',
      value: (
        <>
          Post-tax total <span className="warn-inline">⚠</span>
        </>
      ),
    });
  else if (base === 'pre-tax') rows.push({ label: 'Tip math', value: 'Pre-tax subtotal' });
  if (fees.length > 0)
    rows.push({ label: 'Extra fees', value: fees.map((f) => FEE_LABELS[f] ?? f).join(' · ') });
  if (guiltPct !== null)
    rows.push({ label: 'Felt pressure', value: `${guiltPct}% of ${guiltTotal}` });
  if (rows.length === 0) return null;

  return (
    <section className="detail-section" aria-label="The fine print">
      <h2>The fine print</h2>
      {rows.map((r) => (
        <div key={r.label} className="watch-row">
          <span className="watch-label">{r.label}</span>
          <span className="watch-value">{r.value}</span>
        </div>
      ))}
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
        {venue.city} · {detail.approvedCount} report{detail.approvedCount === 1 ? '' : 's'} · updated{' '}
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
          {/* 1 — what they ask vs what people pay */}
          <AskPayCard detail={detail} />

          {/* 2 — the squeeze score */}
          <ScoreSection detail={detail} />

          {/* 3 — anything shady, at a glance */}
          <FinePrint detail={detail} />
        </>
      )}

      {/* Proof — the photos */}
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

      {detail.unevidencedReports.length > 0 && (
        <details className="fold section-fold">
          <summary>
            Community reports · unverified ({detail.unevidencedReports.length})
          </summary>
          <div style={{ marginTop: 8 }}>
            {detail.unevidencedReports.map((r) => (
              <div key={r.id} className="report-line">
                {reportSentence(r)}
                {publicNotes(r.notes) && (
                  <p className="report-note">{publicNotes(r.notes)}</p>
                )}
              </div>
            ))}
          </div>
        </details>
      )}

      <details className="fold section-fold">
        <summary>How people felt · subjective ({detail.guiltNotes.length})</summary>
        <div style={{ marginTop: 8 }}>
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
        </div>
      </details>

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
