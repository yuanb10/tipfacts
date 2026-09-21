import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'TipFacts — Tipping Facts Database',
  description:
    'A crowdsourced database of objective tipping facts per venue: tip screen presets, pre/post-tax calculation, service type, and fees. Facts only, no opinions.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="site-header">
          <div className="container header-inner">
            <a href="/" className="brand">
              TipFacts
            </a>
            <nav className="nav">
              <a href="/">Rankings</a>
              <a href="/submit" className="nav-cta">
                Submit a report
              </a>
            </nav>
          </div>
        </header>
        <main className="container">{children}</main>
        <footer className="site-footer">
          <div className="container">
            <p>
              TipFacts is an independent, non-commercial research project. Facts only — no
              opinions, no shaming. Starting in Seattle; other cities welcome.
            </p>
          </div>
        </footer>
      </body>
    </html>
  );
}
