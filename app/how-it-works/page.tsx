import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'How the Truth Score works | TipFacts',
  description:
    'How TipFacts turns photo-verified tipping facts into a Truth Score — the rules, the math, and what never counts.',
};

const RULES: { points: string; title: string; body: string }[] = [
  {
    points: '+20',
    title: 'Tip calculated on the post-tax total',
    body: 'A 20% tip on the after-tax total quietly costs more than 20%. If the screen prices the tip off the post-tax number, that’s +20.',
  },
  {
    points: '+25',
    title: 'Lowest preset at 30% or more',
    body: 'When the smallest suggested tip starts at 30%, the screen is doing the deciding for you. (+15 if the lowest preset is 25–29%.)',
  },
  {
    points: '+15',
    title: 'Tip prompt at a counter or takeout window',
    body: 'Table service tipping makes sense. A tip screen for handing you a bag across a counter is pressure, not gratitude.',
  },
  {
    points: '+15',
    title: 'Tip prompt at non-food retail',
    body: 'Buying socks shouldn’t come with a guilt trip. Tip screens outside food service get +15.',
  },
  {
    points: '+10',
    title: 'Hidden fees or surcharges',
    body: 'Service charges, card surcharges, “wellness fees” — anything that inflates the bill beyond tax and tip.',
  },
];

export default function HowItWorksPage() {
  return (
    <div>
      <p className="eyebrow">The rulebook</p>
      <h1 className="page-title">
        How the <span className="hl">Truth Score</span> works
      </h1>
      <p className="page-sub">
        Every venue starts at 0. Photo-verified facts add points; the score caps at 100.
        Higher score = more aggressive tipping practices. Simple, auditable, boring on
        purpose — the drama is in the data.
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
            <dt>How pressured people felt</dt>
            <dd>Subjective, never scored</dd>
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
