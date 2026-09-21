import { notFound } from 'next/navigation';
import { readReports, venueDetail } from '@/lib/store';
import { SERVICE_TYPE_LABELS, TIP_BASE_LABELS, SCREEN_LABELS, FEE_LABELS } from '@/lib/labels';

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

export default async function VenuePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const detail = venueDetail(readReports(), id);
  if (!detail) notFound();
  const { venue: v, reports } = detail;

  return (
    <div>
      <a href="/" className="back-link">
        ← All venues
      </a>
      <h1 className="page-title">{v.venueName}</h1>
      <p className="page-sub">
        {v.city}
        {v.area ? ' · ' + v.area : ''} · {v.reports} report{v.reports === 1 ? '' : 's'}
      </p>

      <div className="detail-section">
        <h2>Aggregated facts</h2>
        <dl>
          <div className="fact-row">
            <dt>Truth score</dt>
            <dd>{v.score === null ? 'Few reports — not scored yet' : v.score + ' / 100'}</dd>
          </div>
          <div className="fact-row">
            <dt>Verification</dt>
            <dd>{v.verified ? 'Verified (photo-backed)' : 'Unverified (text-only)'}</dd>
          </div>
          <div className="fact-row">
            <dt>Service type</dt>
            <dd>{SERVICE_TYPE_LABELS[v.serviceType]}</dd>
          </div>
          {v.screenPresentation && SCREEN_LABELS[v.screenPresentation] && (
            <div className="fact-row">
              <dt>Screen presentation</dt>
              <dd>{SCREEN_LABELS[v.screenPresentation]}</dd>
            </div>
          )}
          {v.presets && (
            <div className="fact-row">
              <dt>Tip presets</dt>
              <dd>{v.presets}</dd>
            </div>
          )}
          {v.tipBase && TIP_BASE_LABELS[v.tipBase] && (
            <div className="fact-row">
              <dt>Tip calculated on</dt>
              <dd>{TIP_BASE_LABELS[v.tipBase]}</dd>
            </div>
          )}
          <div className="fact-row">
            <dt>Extra fees</dt>
            <dd>{v.fees.length ? v.fees.map((f) => FEE_LABELS[f] ?? f).join(', ') : 'None reported'}</dd>
          </div>
          <div className="fact-row">
            <dt>Last updated</dt>
            <dd>{fmtDate(v.lastUpdated)}</dd>
          </div>
        </dl>
        <p className="score-explainer">
          Truth score (provisional): starts at 0. +20 post-tax calculation. +15 if the lowest
          preset is ≥25% (+25 if ≥30%). +15 for counter/takeout tip prompts. +15 for non-food
          retail tip prompts. +10 for hidden fees or surcharges. Capped at 100. Venues with
          fewer than 3 reports are not scored.
        </p>
      </div>

      <div className="detail-section">
        <h2>All reports ({reports.length})</h2>
        {reports.map((r) => (
          <div key={r.id} className="report-item">
            <div className="report-meta">
              {fmtDate(r.createdAt)} · {SERVICE_TYPE_LABELS[r.serviceType]}
              {r.verified ? ' · Verified (photo)' : ' · Unverified'}
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
            {r.photoPath && (
              <img src={r.photoPath} alt="Receipt or tip screen photo" className="report-photo" />
            )}
          </div>
        ))}
      </div>

      <div className="btn-row" style={{ marginBottom: 32 }}>
        <a href="/submit" className="btn btn-primary">
          Report this venue
        </a>
      </div>
    </div>
  );
}
