'use client';

import { useEffect, useState } from 'react';
import type { VenueSummary } from '@/lib/store';
import { SERVICE_TYPE_LABELS, TIP_BASE_LABELS, FEE_LABELS } from '@/lib/labels';

interface ApiResponse {
  venues: VenueSummary[];
  cities: string[];
}

function ScoreBadge({ score }: { score: number | null }) {
  if (score === null) {
    return (
      <div className="score-badge few">
        <div className="score-num">Few reports</div>
        <div className="score-label">not scored yet</div>
      </div>
    );
  }
  return (
    <div className="score-badge">
      <div className="score-num">{score}</div>
      <div className="score-label">truth score</div>
    </div>
  );
}

export default function RankingPage() {
  const [venues, setVenues] = useState<VenueSummary[]>([]);
  const [cities, setCities] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [city, setCity] = useState('');
  const [service, setService] = useState('');
  const [sort, setSort] = useState('score');

  useEffect(() => {
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams();
        if (q) params.set('q', q);
        if (city) params.set('city', city);
        if (service) params.set('service', service);
        params.set('sort', sort);
        const res = await fetch('/api/venues?' + params.toString());
        const data: ApiResponse = await res.json();
        setVenues(data.venues);
        setCities(data.cities);
      } catch {
        // keep previous data on transient errors
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [q, city, service, sort]);

  return (
    <div>
      <h1 className="page-title">Tipping facts, venue by venue</h1>
      <p className="page-sub">
        Objective facts about how venues handle tipping — presets, pre/post-tax, fees. No
        opinions, no shaming. Higher truth score = more aggressive tipping practices.
      </p>

      <div className="filters">
        <input
          type="search"
          placeholder="Search venue name…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Search venues"
        />
        <select value={city} onChange={(e) => setCity(e.target.value)} aria-label="Filter by city">
          <option value="">All cities</option>
          {cities.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <select
          value={service}
          onChange={(e) => setService(e.target.value)}
          aria-label="Filter by service type"
        >
          <option value="">All service types</option>
          {Object.entries(SERVICE_TYPE_LABELS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort by">
          <option value="score">Sort: score</option>
          <option value="reports">Sort: reports</option>
          <option value="name">Sort: name</option>
        </select>
      </div>

      {loading && venues.length === 0 ? (
        <div className="empty-state">Loading…</div>
      ) : venues.length === 0 ? (
        <div className="empty-state">
          No venues match. <a href="/submit">Be the first to report one.</a>
        </div>
      ) : (
        <div className="venue-list">
          {venues.map((v) => (
            <a key={v.id} href={'/venue/' + v.id} className="venue-card">
              <div className="venue-top">
                <div>
                  <h2 className="venue-name">{v.venueName}</h2>
                  <p className="venue-loc">
                    {v.city}
                    {v.area ? ' · ' + v.area : ''}
                  </p>
                </div>
                <ScoreBadge score={v.score} />
              </div>
              <div className="venue-facts">
                <span className="fact-chip">{SERVICE_TYPE_LABELS[v.serviceType]}</span>
                {v.presets && <span className="fact-chip">Presets: {v.presets}</span>}
                {v.tipBase && TIP_BASE_LABELS[v.tipBase] && (
                  <span className="fact-chip">{TIP_BASE_LABELS[v.tipBase]}</span>
                )}
                {v.fees.map((f) => (
                  <span key={f} className="fact-chip">
                    {FEE_LABELS[f] ?? f}
                  </span>
                ))}
                <span className="fact-chip">
                  {v.reports} report{v.reports === 1 ? '' : 's'}
                </span>
                {v.verified ? (
                  <span className="verified-chip">Verified</span>
                ) : (
                  <span className="unverified-chip">Unverified</span>
                )}
              </div>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
