'use client';

import { useEffect, useState } from 'react';
import type { VenueCard } from '@/lib/score';
import { SERVICE_TYPE_LABELS } from '@/lib/labels';

interface ApiResponse {
  venues: VenueCard[];
  cities: string[];
}

function scoreLevel(score: number): 'hot' | 'mid' | 'low' {
  if (score >= 70) return 'hot';
  if (score >= 40) return 'mid';
  return 'low';
}

function ScoreBadge({
  score,
  approvedCount,
}: {
  score: VenueCard['score'];
  approvedCount: number;
}) {
  if (score != null) {
    return (
      <div className={`score-badge ${scoreLevel(score.score)}`} title={`Squeeze score ${score.score} of 100`}>
        <div className="score-num">{score.score}</div>
        <div className="score-label">squeeze score</div>
      </div>
    );
  }
  if (approvedCount > 0) {
    return (
      <div className="score-badge few">
        <div className="score-num">Awaiting evidence</div>
        <div className="score-label">not scored yet</div>
      </div>
    );
  }
  return (
    <div className="score-badge few">
      <div className="score-num">No reports yet</div>
      <div className="score-label">not scored yet</div>
    </div>
  );
}

export default function RankingPage() {
  const [venues, setVenues] = useState<VenueCard[]>([]);
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
      <div className="hero">
        <p className="eyebrow">The tipping-pressure database</p>
        <h1 className="page-title">
          Who’s <span className="hl">squeezing</span>
          <br />
          the screen today?
        </h1>
        <p className="page-sub">
          Objective facts about how venues handle tipping — presets, pre/post-tax math,
          counter vs. table, hidden fees. Higher squeeze score = more aggressive tipping
          practices. Only photo-verified facts move the score.
        </p>
      </div>

      <div className="filters">
        <div className="search-wrap">
          <span className="search-icon" aria-hidden="true">
            ⌕
          </span>
          <input
            type="search"
            placeholder="Search a venue…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Search venues"
          />
        </div>
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

      <div className="list-head">
        <h2>The leaderboard</h2>
        <span className="count">
          {venues.length} venue{venues.length === 1 ? '' : 's'}
        </span>
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
            <a key={v.venue.id} href={'/venue/' + v.venue.id} className="venue-card">
              <div className="venue-top">
                <div>
                  <h2 className="venue-name">{v.venue.name}</h2>
                  <p className="venue-loc">
                    {v.venue.city}
                    {v.venue.area ? ' · ' + v.venue.area : ''}
                  </p>
                </div>
                <ScoreBadge score={v.score} approvedCount={v.approvedCount} />
              </div>
              <div className="venue-facts">
                <span className="fact-chip">
                  {v.approvedCount} report{v.approvedCount === 1 ? '' : 's'}
                </span>
                {v.unverifiedCount > 0 && (
                  <span className="fact-chip">
                    {v.unverifiedCount} unverified
                  </span>
                )}
                {v.score && v.score.evidenceCount > 0 ? (
                  <span className="verified-chip">Verified</span>
                ) : (
                  <span className="unverified-chip">Unverified</span>
                )}
                {v.venue.isSeed && <span className="fact-chip">Seed data</span>}
              </div>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
