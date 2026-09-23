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

/** Big-answer hero stat for a three-question section. */
function AnswerHero({
  children,
  verified,
}: {
  children: React.ReactNode;
  verified?: boolean;
}) {
  return (
    <div className="answer-hero">
      <div className="answer-hero-value">{children}</div>
      {verified && <span className="verified-chip">Verified</span>}
    </div>
  );
}

function EmptyAnswer({ children }: { children: React.ReactNode }) {
  return (
    <div className="empty-state" style={{ padding: '20px 16px' }}>
      {children}
    </div>
  );
}

/**
 * Question 1 — minimum decent tip: lowest tip preset observed on a
 * photo-verified tip screen ("the cheap person's answer").
 */
function MinPresetSection({ detail }: { detail: VenueDetail }) {
  const { backedFacts } = detail;
  return (
    <div className="detail-section">
      <h2>Minimum decent tip</h2>
      {backedFacts.minPreset === null ? (
        <EmptyAnswer>
          <strong>No preset data yet.</strong> No confirmed tip-screen photo for this
          venue — nothing to compute a minimum from.
        </EmptyAnswer>
      ) : (
        <>
          <AnswerHero verified>
            <span className="answer-big">{fmtPct(backedFacts.minPreset)}</span>
          </AnswerHero>
          <p className="score-explainer">
            The lowest preset observed on a photo-verified tip screen — the cheap
            person&rsquo;s answer: what you can pay without being an a-hole.
            {backedFacts.presets.length > 1 &&
              ` All verified presets seen here: ${backedFacts.presets.map(fmtPct).join(', ')}.`}
          </p>
        </>
      )}
    </div>
  );
}

/**
 * Question 2 — tip tax base: pre-tax or post-tax, reported from approved
 * receipts. Post-tax gets a visible warning.
 */
function TipBaseSection({ detail }: { detail: VenueDetail }) {
  const { backedFacts } = detail;
  const base = backedFacts.tipBase;
  return (
    <div className="detail-section">
      <h2>Tip calculated on</h2>
      {base === '' || base === 'not-sure' ? (
        <EmptyAnswer>
          <strong>Unknown.</strong>{' '}
          {base === 'not-sure'
            ? 'Reporters were not sure whether this venue calculates tips pre-tax or post-tax — no confirmed receipt settles it yet.'
            : 'No confirmed receipt data on the tip tax base yet — no approved receipt verifies it.'}
        </EmptyAnswer>
      ) : (
        <>
          <AnswerHero verified>{TIP_BASE_LABELS[base] ?? base}</AnswerHero>
          {base === 'post-tax' && (
            <div className="warning-callout" role="alert">
              <strong>Warning: post-tax tipping.</strong> This venue calculates the tip
              on the post-tax total, so a {detail.backedFacts.minPreset !== null ? fmtPct(detail.backedFacts.minPreset) : 'typical'} tip here costs more than the same percentage at a pre-tax venue. Verified from approved receipts.
            </div>
          )}
          {base === 'pre-tax' && (
            <p className="score-explainer">
              Tips are calculated on the pre-tax subtotal here — the less costly
              standard. Verified from approved receipts.
            </p>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Question 3 — guilt signals: % who felt pressured, whether custom/no-tip was
 * easy to choose, staff-watching mentions (data-supported only).
 */
function GuiltSignalsSection({ detail }: { detail: VenueDetail }) {
  const guilt = detail.guiltStats;
  const guiltTotal = guilt.yes + guilt.no;
  const guiltPct = guiltTotal > 0 ? Math.round((guilt.yes / guiltTotal) * 100) : null;

  const watchRe = /\bwatch(?:ing|ed)?\b|\bstar(?:e|ing|ed)?\b|\bobserv(?:e|ed|ing)\b/;
  const watchCount = detail.guiltNotes.filter((n) =>
    watchRe.test(n.note.toLowerCase()),
  ).length;

  const optOut = detail.backedFacts.easyOptOut;
  const hasAnyData =
    guiltPct !== null || optOut !== 'skip' || watchCount > 0 || detail.guiltNotes.length > 0;

  return (
    <div className="detail-section">
      <h2>Guilt signals</h2>
      {!hasAnyData ? (
        <EmptyAnswer>
          <strong>No pressure data yet.</strong> Nobody has answered the
          tipping-pressure question for this venue.
        </EmptyAnswer>
      ) : (
        <>
          <AnswerHero>
            {guiltPct === null ? (
              <span className="page-sub">No answers yet</span>
            ) : (
              <span className="answer-big">{guiltPct}%</span>
            )}
          </AnswerHero>
          {guiltPct !== null && (
            <p className="score-explainer">
              of {guiltTotal} respondent{guiltTotal === 1 ? '' : 's'} said they felt
              tipping pressure ({guilt.yes} yes, {guilt.no} no
              {guilt.skipped > 0 ? `, ${guilt.skipped} skipped` : ''}). Factual,
              unscored unless corroborated — see the score breakdown below.
            </p>
          )}
          <dl style={{ marginTop: 12 }}>
            <div className="fact-row">
              <dt>Easy to choose a custom tip or no tip</dt>
              <dd>
                {optOut === 'skip' ? (
                  'Unknown — no confirmed screen data'
                ) : (
                  <>
                    {optOut === 'yes' ? 'Yes' : 'No'}{' '}
                    <span className="verified-chip" style={{ marginLeft: 4 }}>
                      Verified
                    </span>
                  </>
                )}
              </dd>
            </div>
            {watchCount > 0 && (
              <div className="fact-row">
                <dt>Staff watching while choosing</dt>
                <dd>
                  Mentioned in {watchCount} approved report
                  {watchCount === 1 ? '' : 's'}{' '}
                  <span className="unverified-chip" style={{ marginLeft: 4 }}>
                    Subjective
                  </span>
                </dd>
              </div>
            )}
          </dl>
          {detail.guiltNotes.length > 0 && (
            <p className="score-explainer">
              Individual experiences are quoted in{' '}
              <a href="#subjective">How people felt (subjective)</a> — never scored.
            </p>
          )}
        </>
      )}
    </div>
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
        Squeeze Score v2 rubric (locked): starts at 0. Table service — lowest preset
        ≤15%: +0; 16–18%: +15; above 18%: +30. Counter / takeout / non-food retail —
        any tip prompt: +25; no easy custom-tip / no-tip option: +10. Tip calculated
        on the post-tax total: +20. Extra fees — first fee: +10, each additional: +5.
        Corroborated guilt (≥2 approved “yes” from distinct reporters): +15, labeled
        community-reported. Capped at 100. Evidence-only: only photo-verified facts
        move the score.
      </p>
    </div>
  );
}

export default async function VenuePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const detail = await getVenueDetail(id);
  if (!detail) notFound();
  const { venue } = detail;

  const hasNoData = detail.approvedCount === 0;

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
              <small>squeeze score / 100</small>
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

      {hasNoData && (
        <div className="no-data-cta">
          <p>
            <strong>No tipping data yet — be the first to report.</strong> Snap the tip
            screen or your receipt and put this venue on the record.
          </p>
          <a href={`/submit?venueId=${encodeURIComponent(id)}`} className="btn btn-primary">
            Report this venue
          </a>
        </div>
      )}

      {/* The three questions a checker asks, answered first */}
      <MinPresetSection detail={detail} />
      <TipBaseSection detail={detail} />
      <GuiltSignalsSection detail={detail} />

      {/* Score sits BELOW the three answers */}
      <ScoreBlock detail={detail} />

      {detail.approvedCount > 0 && (
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
      )}

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
                {r.serviceDate ? `Visited ${fmtDate(r.serviceDate + 'T12:00:00')}` : fmtDate(r.createdAt)} · {SERVICE_TYPE_LABELS[r.serviceType]}{' '}
                <span className="unverified-chip">Unverified</span>
              </div>
              <div className="venue-facts">
                {r.presets && <span className="fact-chip">Lowest tip: {r.presets}</span>}
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
              {publicNotes(r.notes) && (
                <p style={{ margin: '8px 0 0' }}>{publicNotes(r.notes)}</p>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="detail-section" id="subjective">
        <h2>How people felt (subjective)</h2>
        <p className="score-explainer" style={{ marginTop: 0 }}>
          Subjective and never scored. Individual experiences, quoted verbatim.
        </p>
        {detail.guiltNotes.length === 0 ? (
          <p className="page-sub">No pressure notes yet.</p>
        ) : (
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

      <div className="detail-section">
        <h2>Is this your business?</h2>
        <p className="score-explainer" style={{ marginTop: 0 }}>
          See a fact that&rsquo;s wrong? Merchants can dispute a fact by submitting
          counter-evidence — a current tip-screen or receipt photo that shows it
          differently. Disputes are reviewed with the same evidence-only standard; no
          payment can alter or suppress a score.
        </p>
        <div className="btn-row" style={{ marginTop: 12 }}>
          <a
            href={`/submit?venueId=${encodeURIComponent(id)}`}
            className="btn btn-secondary"
          >
            Dispute a fact (submit counter-evidence)
          </a>
        </div>
      </div>

      <div className="btn-row" style={{ marginBottom: 32 }}>
        <a href={`/submit?venueId=${encodeURIComponent(id)}`} className="btn btn-primary">
          Report this venue
        </a>
      </div>
    </div>
  );
}
