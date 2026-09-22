import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { getVenueDetail } from '@/lib/score';
import type { PublicEvidence, ScoreComponent, VenueDetail } from '@/lib/score';
import {
  SERVICE_TYPE_LABELS,
  TIP_BASE_LABELS,
  SCREEN_LABELS,
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

function labelOf(term: string, value: string): string {
  if (term === 'Service type') return SERVICE_TYPE_LABELS[value] ?? value;
  if (term === 'Tip calculated on') return TIP_BASE_LABELS[value] ?? value;
  if (term === 'Screen presentation') return SCREEN_LABELS[value] ?? value;
  if (term === 'Extra fees') {
    return value
      .split(', ')
      .map((f) => FEE_LABELS[f] ?? f)
      .join(', ');
  }
  return value;
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
    ? `truth score ${score.score}/100`
    : approvedCount > 0
      ? 'awaiting verified evidence'
      : 'no reports yet';
  return {
    title: `${venue.name} tipping facts — presets, fees, truth score | TipFacts`,
    description: `${venue.name} in ${venue.city}: ${state}. ${approvedCount} approved report${approvedCount === 1 ? '' : 's'}${unverifiedCount ? `, ${unverifiedCount} unverified` : ''}. Objective, photo-verified tipping facts — no opinions.`,
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

function ScoreBlock({ detail }: { detail: VenueDetail }) {
  const { score, evidence } = detail;
  const byId = new Map(evidence.map((e) => [e.id, e]));
  if (!score) {
    return (
      <div className="detail-section">
        <h2>Why this score</h2>
        <div className="empty-state" style={{ padding: '20px 16px' }}>
          Awaiting evidence — nothing scored yet.
        </div>
        <p className="score-explainer">
          No verified evidence yet — scores only reflect photo-verified facts. Once a
          report is backed by a confirmed receipt or screen photo, its facts start counting
          toward the score.
        </p>
      </div>
    );
  }
  return (
    <div className="detail-section">
      <h2>Why this score</h2>
      <p className="score-explainer" style={{ marginTop: 0 }}>
        Based on {score.evidenceCount} verified photo
        {score.evidenceCount === 1 ? '' : 's'}. Higher = more aggressive tipping practices.
        Only photo-verified facts count.
      </p>
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
      <p className="score-explainer">
        Truth score (provisional): starts at 0. +20 post-tax calculation. +15 if the lowest
        preset is ≥25% (+25 if ≥30%). +15 for counter/takeout tip prompts. +15 for
        non-food retail tip prompts. +10 for hidden fees or surcharges. Capped at 100. Only
        photo-verified facts count.
      </p>
    </div>
  );
}

export default async function VenuePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const detail = await getVenueDetail(id);
  if (!detail) notFound();
  const { venue } = detail;

  const guilt = detail.guiltStats;
  const guiltTotal = guilt.yes + guilt.no;
  const guiltPct = guiltTotal > 0 ? Math.round((guilt.yes / guiltTotal) * 100) : null;

  return (
    <div>
      <a href="/" className="back-link">
        ← All venues
      </a>

      <div className="detail-hero">
        <div className="detail-top">
          <div>
            <p className="eyebrow" style={{ color: '#4b441b' }}>
              Venue file
            </p>
            <h1 className="page-title">{venue.name}</h1>
            <p className="page-sub">
              {venue.city}
              {venue.area ? ' · ' + venue.area : ''} · {detail.approvedCount} approved
              report
              {detail.approvedCount === 1 ? '' : 's'} · updated {fmtDate(detail.lastUpdated)}
            </p>
          </div>
          {detail.score ? (
            <div className="detail-score">
              {detail.score.score}
              <small>truth score / 100</small>
            </div>
          ) : (
            <div
              className="detail-score"
              style={{ fontSize: '1.4rem', letterSpacing: 0, lineHeight: 1.2 }}
            >
              Awaiting
              <br />
              evidence
            </div>
          )}
        </div>
      </div>

      {venue.isSeed && (
        <div className="seed-banner">
          <strong>Fictional seed data.</strong> This venue and its reports are made-up demo
          data for development — not real reports.
        </div>
      )}

      <ScoreBlock detail={detail} />

      <div className="detail-section">
        <h2>Aggregated facts</h2>
        <dl>
          {detail.factRows.map((row) => (
            <div className="fact-row" key={row.term}>
              <dt>
                {row.term}{' '}
                {row.kind === 'verified' ? (
                  <span className="verified-chip" style={{ marginLeft: 4 }}>
                    Verified
                  </span>
                ) : (
                  <span className="unverified-chip" style={{ marginLeft: 4 }}>
                    Community consensus
                  </span>
                )}
              </dt>
              <dd>{labelOf(row.term, row.value)}</dd>
            </div>
          ))}
        </dl>
        <p className="score-explainer">
          “Verified” facts are backed by at least one confirmed receipt or screen photo.
          “Community consensus” facts come from text-only reports and are not scored.
        </p>
      </div>

      {detail.unevidencedReports.length > 0 && (
        <div className="detail-section">
          <h2>Community consensus (unverified)</h2>
          <p className="score-explainer" style={{ marginTop: 0 }}>
            These reports were approved by moderation but have no photo evidence yet — treat
            them as unverified.
          </p>
          {detail.unevidencedReports.map((r) => (
            <div key={r.id} className="report-item">
              <div className="report-meta">
                {fmtDate(r.createdAt)} · {SERVICE_TYPE_LABELS[r.serviceType]}{' '}
                <span className="unverified-chip">Unverified</span>
              </div>
              <div className="venue-facts">
                {r.presets && <span className="fact-chip">Presets: {r.presets}</span>}
                {r.tipBase && TIP_BASE_LABELS[r.tipBase] && (
                  <span className="fact-chip">{TIP_BASE_LABELS[r.tipBase]}</span>
                )}
                {r.screenPresentation && SCREEN_LABELS[r.screenPresentation] && (
                  <span className="fact-chip">{SCREEN_LABELS[r.screenPresentation]}</span>
                )}
                {r.fees.map((f) => (
                  <span key={f} className="fact-chip">
                    {FEE_LABELS[f] ?? f}
                  </span>
                ))}
              </div>
              {r.notes && <p style={{ margin: '8px 0 0' }}>{r.notes}</p>}
            </div>
          ))}
        </div>
      )}

      <div className="detail-section">
        <h2>How people felt (subjective)</h2>
        <p className="score-explainer" style={{ marginTop: 0 }}>
          Subjective and never scored.
        </p>
        {guiltPct === null ? (
          <p className="page-sub">Nobody answered the tipping-pressure question yet.</p>
        ) : (
          <p>
            <strong>{guiltPct}%</strong> of {guiltTotal} respondent{guiltTotal === 1 ? '' : 's'}{' '}
            felt tipping pressure ({guilt.yes} yes, {guilt.no} no
            {guilt.skipped > 0 ? `, ${guilt.skipped} skipped` : ''}).
          </p>
        )}
        {detail.guiltNotes.length > 0 && (
          <>
            <h3 style={{ fontSize: 15, margin: '12px 0 8px' }}>In their words</h3>
            {detail.guiltNotes.map((n) => (
              <div key={n.id} className="report-item">
                <div className="report-meta">{fmtDate(n.createdAt)}</div>
                <p style={{ margin: '4px 0 0' }}>{n.note}</p>
              </div>
            ))}
          </>
        )}
      </div>

      <div className="detail-section">
        <h2>Receipt stats</h2>
        <p className="score-explainer" style={{ marginTop: 0 }}>
          Reported, not truth: what people typed from their receipts — never scored.
        </p>
        <dl>
          <div className="fact-row">
            <dt>Median reported tip</dt>
            <dd>
              {detail.receiptStats.medianReportedTip === null
                ? 'No receipt data'
                : detail.receiptStats.medianReportedTip + '%'}
            </dd>
          </div>
          <div className="fact-row">
            <dt>Fees seen in receipts</dt>
            <dd>
              {detail.receiptStats.feeFrequency.length === 0
                ? 'None reported'
                : detail.receiptStats.feeFrequency
                    .map((f) => `${FEE_LABELS[f.fee] ?? f.fee} ×${f.count}`)
                    .join(', ')}
            </dd>
          </div>
        </dl>
      </div>

      {detail.evidence.length > 0 && (
        <div className="detail-section">
          <h2>Evidence gallery ({detail.evidence.length})</h2>
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
        </div>
      )}

      {detail.changelog.length > 0 && (
        <div className="detail-section">
          <h2>Report history</h2>
          {detail.changelog.map((a) => (
            <div key={a.id} className="report-item">
              <div className="report-meta">
                {fmtDate(a.createdAt)} · {a.action === 'approved' ? 'Approved' : 'Rejected'}
                {a.reportId ? ` · report ${a.reportId.slice(0, 8)}` : ''}
              </div>
              {a.note && <p style={{ margin: '4px 0 0' }}>{a.note}</p>}
            </div>
          ))}
        </div>
      )}

      <div className="btn-row" style={{ marginBottom: 32 }}>
        <a href="/submit" className="btn btn-primary">
          Report this venue
        </a>
      </div>
    </div>
  );
}
