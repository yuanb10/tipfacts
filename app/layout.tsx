import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'TipFacts — Who’s squeezing the screen today?',
  description:
    'A crowdsourced database of objective tipping facts per venue: tip screen presets, pre/post-tax calculation, service type, and fees. We sell the math, never the receipts.',
};

function BottomNav() {
  return (
    <nav className="bottom-nav" aria-label="Primary">
      <a href="/">
        <span className="bn-icon" aria-hidden="true">
          🗺️
        </span>
        Rankings
      </a>
      <a href="/submit">
        <span className="bn-icon" aria-hidden="true">
          🧾
        </span>
        Log a report
      </a>
      <a href="/how-it-works">
        <span className="bn-icon" aria-hidden="true">
          📏
        </span>
        How it works
      </a>
    </nav>
  );
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="site-header">
          <div className="container header-inner">
            <a href="/" className="brand">
              <span className="brand-mark" aria-hidden="true">
                %
              </span>
              TipFacts
            </a>
            <nav className="nav" aria-label="Header">
              <a href="/how-it-works">How it works</a>
              <a href="/submit" className="nav-cta">
                Log a report
              </a>
            </nav>
          </div>
        </header>
        <main className="container">{children}</main>
        <footer className="site-footer">
          <div className="container">
            <p className="foot-brand">TipFacts</p>
            <p>
              An independent, non-commercial research project. Facts only — no opinions, no
              shaming. We sell the math, never the receipts. Starting in Seattle; other
              cities welcome.
            </p>
          </div>
        </footer>
        <BottomNav />
      </body>
    </html>
  );
}
