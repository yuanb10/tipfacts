import { getStorage } from '@/lib/storage';
import type { Report, Evidence, ModerationAction } from '@/lib/storage';
import { SERVICE_TYPE_LABELS, TIP_BASE_LABELS, SCREEN_LABELS, FEE_LABELS } from '@/lib/labels';
import ModerationControls from './actions';

export const dynamic = 'force-dynamic';

function fmtMoney(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  return `$${Number(v).toFixed(2)}`;
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-US', {
      timeZone: 'America/Los_Angeles',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function labelOf(map: Record<string, string>, key: string | undefined | null): string {
  if (!key) return '—';
  return map[key] ?? key;
}

async function loadQueue() {
  const store = getStorage();
  const pending = await store.listReports({ status: 'pending' });
  pending.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const withEvidence = await Promise.all(
    pending.map(async (r) => ({
      report: r,
      evidence: await store.listEvidenceForReport(r.id),
    }))
  );
  // Recently decided: newest decidedAt first, then latest action per report.
  const decided = await store.listReports({ status: ['approved', 'rejected'] });
  decided.sort((a, b) => (b.decidedAt ?? '').localeCompare(a.decidedAt ?? ''));
  const recent = await Promise.all(
    decided.slice(0, 15).map(async (r) => {
      const actions = await store.listModerationActions(r.id);
      actions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const latest: ModerationAction | undefined = actions[0];
      return {
        report: r,
        action: latest?.action ?? r.moderationStatus,
        note: latest?.note ?? r.moderationNote,
        at: latest?.createdAt ?? r.decidedAt,
      };
    })
  );
  return { withEvidence, recent };
}

function FactChips({ report }: { report: Report }) {
  const chips: string[] = [
    labelOf(SERVICE_TYPE_LABELS, report.serviceType),
    labelOf(SCREEN_LABELS, report.screenPresentation),
    labelOf(TIP_BASE_LABELS, report.tipBase),
    ...report.fees.map((f) => labelOf(FEE_LABELS, f)),
  ].filter(Boolean);
  if (report.presets) chips.push(`Screen: ${report.presets}`);
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, margin: '8px 0' }}>
      {chips.map((c, i) => (
        <span key={i} className="fact-chip">{c}</span>
      ))}
    </div>
  );
}

function EvidenceCard({ evidence }: { evidence: Evidence }) {
  const isReceipt = evidence.type === 'receipt';
  const parsed = evidence.parsed;
  return (
    <div className="detail-section" style={{ marginTop: 12 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <span className="fact-chip">{isReceipt ? '🧾 Receipt' : '🖥️ Tip screen'}</span>
        <span className="fact-chip">Redaction: {evidence.redactionStatus}</span>
        {evidence.userConfirmed && <span className="verified-chip">Uploader confirmed</span>}
      </div>
      <p className="report-meta" style={{ marginTop: 8 }}>
        {isReceipt ? 'backs: tip base + fees' : 'backs: presets + prompt'}
      </p>
      {evidence.redactedPath ? (
        <img
          src={evidence.redactedPath}
          alt={`${evidence.type} evidence (redacted)`}
          className="report-photo"
          style={{ maxWidth: 320 }}
        />
      ) : (
        <p className="report-meta">No redacted copy available.</p>
      )}
      {parsed ? (
        <dl style={{ marginTop: 8 }}>
          <div className="fact-row"><dt>Merchant</dt><dd>{parsed.merchant ?? '—'}</dd></div>
          <div className="fact-row"><dt>Subtotal</dt><dd>{fmtMoney(parsed.subtotal)}</dd></div>
          <div className="fact-row"><dt>Tax</dt><dd>{fmtMoney(parsed.tax)}</dd></div>
          <div className="fact-row"><dt>Tip</dt><dd>{fmtMoney(parsed.tip)}</dd></div>
          <div className="fact-row"><dt>Total</dt><dd>{fmtMoney(parsed.total)}</dd></div>
          {parsed.fees.map((f, i) => (
            <div className="fact-row" key={i}><dt>Fee: {f.label}</dt><dd>{fmtMoney(f.amount)}</dd></div>
          ))}
          {parsed.presets.length > 0 && (
            <div className="fact-row"><dt>Presets</dt><dd>{parsed.presets.map((p) => `${p}%`).join(', ')}</dd></div>
          )}
          {parsed.tipPercentReported != null && (
            <div className="fact-row"><dt>Tip % reported</dt><dd>{parsed.tipPercentReported}%</dd></div>
          )}
        </dl>
      ) : (
        <p className="report-meta">No parsed values.</p>
      )}
    </div>
  );
}

function ReportCard({ report, evidence, modKey }: { report: Report; evidence: Evidence[]; modKey: string }) {
  const guiltText = report.guilt === 'yes' ? 'Yes — felt pressured' : report.guilt === 'no' ? 'No' : 'Skipped';
  return (
    <section className="detail-section">
      <h2>{report.venueName} <span style={{ fontWeight: 400, color: 'var(--muted)' }}>· {report.city}</span></h2>
      <p className="report-meta">
        Submitted {fmtDate(report.createdAt)} · {report.id}{report.area ? ` · ${report.area}` : ''}
      </p>
      <FactChips report={report} />
      <dl>
        <div className="fact-row"><dt>Guilt / pressure</dt><dd>{guiltText}</dd></div>
      </dl>
      {report.experienceNote && (
        <p style={{ fontSize: 14 }}><strong>Experience:</strong> {report.experienceNote}</p>
      )}
      {report.notes && (
        <p style={{ fontSize: 14 }}><strong>Notes:</strong> {report.notes}</p>
      )}
      {evidence.length === 0 && <p className="report-meta">No evidence attached.</p>}
      {evidence.map((e) => (
        <EvidenceCard key={e.id} evidence={e} />
      ))}
      <div style={{ marginTop: 12 }}>
        <ModerationControls modKey={modKey} reportId={report.id} />
      </div>
    </section>
  );
}

export default async function ModeratePage({
  searchParams,
}: {
  searchParams: Promise<{ key?: string | string[] }>;
}) {
  const secret = process.env.MOD_SECRET;
  const params = await searchParams;
  const rawKey = params.key;
  const key = Array.isArray(rawKey) ? rawKey[0] : rawKey;

  if (!secret) {
    return (
      <main className="page">
        <h1 className="page-title">Moderation</h1>
        <p className="page-sub">Moderation is not configured (set MOD_SECRET).</p>
      </main>
    );
  }
  if (!key || key !== secret) {
    return (
      <main className="page">
        <h1 className="page-title">Moderation</h1>
        <p className="page-sub">Access denied.</p>
      </main>
    );
  }

  const { withEvidence, recent } = await loadQueue();

  return (
    <main className="page">
      <p className="eyebrow">Backstage</p>
      <h1 className="page-title">Moderation queue</h1>
      <p className="page-sub">
        {withEvidence.length === 0
          ? 'Nothing waiting for review.'
          : `${withEvidence.length} report${withEvidence.length === 1 ? '' : 's'} pending review (newest first).`}
      </p>

      {withEvidence.length === 0 ? (
        <div className="empty-state">
          <h2>All caught up 🎉</h2>
          <p>No pending reports. Nice work.</p>
        </div>
      ) : (
        withEvidence.map(({ report, evidence }) => (
          <ReportCard key={report.id} report={report} evidence={evidence} modKey={key} />
        ))
      )}

      <h2 style={{ fontSize: '1.5rem', margin: '32px 0 12px' }}>Recently decided</h2>
      {recent.length === 0 ? (
        <p className="page-sub">No decisions yet.</p>
      ) : (
        <div className="detail-section">
          {recent.map(({ report, action, note, at }) => (
            <div className="report-item" key={report.id}>
              <div className="report-meta">
                {report.venueName} · {report.city} · {fmtDate(at)}
              </div>
              <div>
                <span className={action === 'approved' ? 'verified-chip' : 'unverified-chip'}>
                  {action === 'approved' ? 'Approved' : 'Rejected'}
                </span>
                {note && <span style={{ marginLeft: 8, fontSize: 14 }}>{note}</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
