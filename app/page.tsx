'use client';

import { useEffect, useRef, useState } from 'react';
import type { VenueCard } from '@/lib/score';
import {
  FEE_LABELS,
  SERVICE_TYPE_LABELS,
  TIP_BASE_LABELS,
} from '@/lib/labels';

const PAGE_LIMIT = 100;

interface ApiResponse {
  venues: VenueCard[];
  cities: string[];
  total: number;
}

function scoreLevel(score: number): 'hot' | 'mid' | 'low' {
  if (score >= 70) return 'hot';
  if (score >= 40) return 'mid';
  return 'low';
}

function fmtPct(n: number): string {
  return Number.isInteger(n) ? n + '%' : n.toFixed(1) + '%';
}

/** Score badge for scored venues; state chip otherwise. */
function StateBadge({ card }: { card: VenueCard }) {
  if (card.score != null) {
    const s = card.score.score;
    return (
      <div
        className={`score-badge ${scoreLevel(s)}`}
        title={`Squeeze score ${s} of 100`}
      >
        <div className="score-num">{s}</div>
        <div className="score-label">squeeze score</div>
      </div>
    );
  }
  if (card.approvedCount > 0) {
    return (
      <div className="score-badge few">
        <div className="score-num">Early data</div>
        <div className="score-label">few reports</div>
      </div>
    );
  }
  return (
    <div className="score-badge few">
      <div className="score-num">No data yet</div>
      <div className="score-label">not reported</div>
    </div>
  );
}

function DirectoryRow({ card }: { card: VenueCard }) {
  const v = card;
  const verified = v.score !== null && v.score.evidenceCount > 0;
  const isNone = v.approvedCount === 0;
  const tipBaseLabel = v.facts.tipBase
    ? TIP_BASE_LABELS[v.facts.tipBase] ?? v.facts.tipBase
    : null;
  const feeLabels = v.facts.fees.map((f) => FEE_LABELS[f] ?? f);

  return (
    <article className="venue-card">
      <div className="venue-top">
        <div>
          <h2 className="venue-name">
            <a className="dir-name-link" href={'/venue/' + v.venue.id}>
              {v.venue.name}
            </a>
          </h2>
          <p className="venue-loc">
            {v.venue.city}
            {v.venue.area ? ' · ' + v.venue.area : ''}
          </p>
        </div>
        <StateBadge card={v} />
      </div>
      <div className="venue-facts">
        {!isNone && (
          <span className="fact-chip">
            {v.approvedCount} report{v.approvedCount === 1 ? '' : 's'}
          </span>
        )}
        {v.facts.minPreset != null && (
          <span className="fact-chip" title="Lowest tip preset observed — the cheap person's answer">
            Min tip {fmtPct(v.facts.minPreset)}
          </span>
        )}
        {tipBaseLabel && (
          <span
            className={`fact-chip${v.facts.tipBase === 'post-tax' ? ' warn' : ''}`}
            title={v.facts.tipBase === 'post-tax' ? 'Tips are calculated on the post-tax total here' : undefined}
          >
            Tip on {tipBaseLabel.toLowerCase()}
            {v.facts.tipBase === 'post-tax' ? ' ⚠' : ''}
          </span>
        )}
        {feeLabels.length > 0 && (
          <span className="fact-chip" title="Extra fees seen on receipts">
            Fees: {feeLabels.join(', ')}
          </span>
        )}
        {v.unverifiedCount > 0 && (
          <span className="fact-chip">{v.unverifiedCount} unverified</span>
        )}
        {!isNone &&
          (verified ? (
            <span className="verified-chip">Verified</span>
          ) : (
            <span className="unverified-chip">Unverified</span>
          ))}
        {v.venue.isSeed && <span className="fact-chip">Seed data</span>}
      </div>
      {isNone && (
        <a
          className="dir-cta"
          href={'/submit?venueId=' + encodeURIComponent(v.venue.id)}
        >
          No tipping data yet — be the first to report
        </a>
      )}
    </article>
  );
}

export default function DirectoryPage() {
  const [venues, setVenues] = useState<VenueCard[]>([]);
  const [cities, setCities] = useState<string[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [q, setQ] = useState('');
  const [city, setCity] = useState('');
  const [service, setService] = useState('');
  const [dataState, setDataState] = useState('');
  const [sort, setSort] = useState('score');
  const offsetRef = useRef(0);

  async function fetchPage(offset: number, append: boolean) {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (city) params.set('city', city);
    if (service) params.set('service', service);
    if (dataState) params.set('state', dataState);
    params.set('sort', sort);
    params.set('limit', String(PAGE_LIMIT));
    params.set('offset', String(offset));
    const res = await fetch('/api/venues?' + params.toString());
    const data: ApiResponse = await res.json();
    setTotal(data.total);
    if (append) {
      setVenues((prev) => [...prev, ...data.venues]);
    } else {
      setVenues(data.venues);
      setCities(data.cities);
    }
    offsetRef.current = offset + data.venues.length;
  }

  useEffect(() => {
    const t = setTimeout(() => {
      (async () => {
        setLoading(true);
        try {
          await fetchPage(0, false);
        } catch {
          // keep previous data on transient errors
        } finally {
          setLoading(false);
        }
      })();
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, city, service, dataState, sort]);

  async function loadMore() {
    if (loadingMore) return;
    setLoadingMore(true);
    try {
      await fetchPage(offsetRef.current, true);
    } catch {
      // keep existing rows on transient errors
    } finally {
      setLoadingMore(false);
    }
  }

  const hasMore = venues.length < total;

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
        <select
          value={dataState}
          onChange={(e) => setDataState(e.target.value)}
          aria-label="Filter by data state"
        >
          <option value="">All data states</option>
          <option value="scored">Scored</option>
          <option value="early">Early data</option>
          <option value="none">No data yet</option>
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort by">
          <option value="score">Sort: score</option>
          <option value="reports">Sort: reports</option>
          <option value="name">Sort: name</option>
          <option value="updated">Sort: recently updated</option>
        </select>
      </div>

      <div className="list-head">
        <h2>Venue directory</h2>
        <span className="count">
          Showing {venues.length} of {total} venue{total === 1 ? '' : 's'}
        </span>
      </div>

      {loading && venues.length === 0 ? (
        <div className="empty-state">Loading…</div>
      ) : venues.length === 0 ? (
        <div className="empty-state">
          No venues match. <a href="/submit">Be the first to report one.</a>
        </div>
      ) : (
        <>
          <div className="venue-list">
            {venues.map((v) => (
              <DirectoryRow key={v.venue.id} card={v} />
            ))}
          </div>
          {hasMore && (
            <div className="dir-more-wrap">
              <button
                type="button"
                className="btn"
                onClick={loadMore}
                disabled={loadingMore}
              >
                {loadingMore ? 'Loading…' : `Load more (${total - venues.length} remaining)`}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
