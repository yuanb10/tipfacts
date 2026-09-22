import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'How the Squeeze Score works | TipFacts',
  description:
    'How TipFacts turns photo-verified tipping facts into a Squeeze Score — the rules, the math, and what never counts.',
};

const RULES: { points: string; title: string; body: string }[] = [
  {
    points: '+30',
    title: 'Table service, lowest preset above 18%',
    body: 'Anything above 18% for table service is crazy. (+15 if the lowest preset is 16–18%. At or under 15%? +0 — that’s fair.)',
  },
  {
    points: '+25',
    title: 'Tip prompt at counter, takeout, or non-food retail',
    body: 'Services that should never charge a tip get +25 for the prompt alone. Handing you a bag or ringing up socks isn’t table service.',
  },
  {
    points: '+10',
    title: 'No easy custom-tip / no-tip option',
    body: 'If the screen makes it hard to pick custom or zero — buried, tiny, or missing — that’s another +10 on top.',
  },
  {
    points: '+20',
    title: 'Tip calculated on the post-tax total',
    body: 'A 20% tip on the after-tax total quietly costs more than 20%. If the screen prices the tip off the post-tax number, that’s +20.',
  },
  {
    points: '+10/+5',
    title: 'Extra fees',
    body: 'Service charges, card surcharges, “wellness fees” — +10 for the first, +5 for each additional one.',
  },
  {
    points: '+15',
    title: 'Corroborated guilt tipping',
    body: 'One person feeling pressured is a story. Two or more independent visitors reporting pressure is a pattern — +15. Always labeled as community-reported, never photo evidence.',
  },
];

export default function HowItWorksPage() {
  return (
    <div>
      <p className="eyebrow">The rulebook</p>
      <h1 className="page-title">
        How the <span className="hl">Squeeze Score</span> works
      </h1>
      <p className="page-sub">
        Every venue starts at 0. Verified facts add points; corroborated community reports
        add a little too; the score caps at 100. Higher score = more aggressive tipping
        practices. Simple, auditable, boring on purpose — the drama is in the data.
      </p>

      <div className="detail-section">
        <h2>The scoring rules</h2>
        <div className="how-grid">
          {RULES.map((r) => (
            <div key={r.title} className="score-rule">
              <span className="pts">{r.points}</span>
              <p>
                <strong>{r.title}</strong>
                {r.body}
              </p>
            </div>
          ))}
        </div>
      </div>

      <div className="detail-section">
        <h2>What counts — and what doesn’t</h2>
        <dl>
          <div className="fact-row">
            <dt>Photo-verified facts</dt>
            <dd>Count toward the score</dd>
          </div>
          <div className="fact-row">
            <dt>Text-only community reports</dt>
            <dd>Shown as consensus, never scored</dd>
          </div>
          <div className="fact-row">
            <dt>Guilt tipping</dt>
            <dd>Scored only when 2+ visitors corroborate it — always labeled community-reported</dd>
          </div>
          <div className="fact-row">
            <dt>Receipt amounts people typed</dt>
            <dd>Reported, not truth — never scored</dd>
          </div>
        </dl>
        <p className="score-explainer">
          Every photo goes through redaction review before anything publishes — personal
          data gets blacked out and the uploader confirms the redacted version. We sell
          the math, never the receipts.
        </p>
      </div>

      <div className="btn-row" style={{ marginBottom: 32 }}>
        <a href="/submit" className="btn btn-primary">
          Log a report
        </a>
        <a href="/" className="btn btn-secondary">
          See the rankings
        </a>
      </div>
    </div>
  );
}
