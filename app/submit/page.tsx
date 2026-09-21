'use client';

import { useState } from 'react';

export default function SubmitPage() {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const form = e.currentTarget;
      const res = await fetch('/api/venues', {
        method: 'POST',
        body: new FormData(form),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data.error || 'Something went wrong. Please try again.');
      } else {
        setDone(true);
        window.scrollTo(0, 0);
      }
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <div>
        <h1 className="page-title">Report a venue</h1>
        <div className="form-success">
          <h2>Thanks — report received.</h2>
          <p>It now appears in the rankings. One more while you&apos;re at it?</p>
          <div className="btn-row">
            <a href="/" className="btn btn-primary">
              See the rankings
            </a>
            <button className="btn btn-secondary" onClick={() => setDone(false)}>
              Submit another
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <h1 className="page-title">Report a venue</h1>
      <p className="page-sub">
        Facts only: what the tip screen showed, how it was calculated, any fees. Takes 60
        seconds. No account needed.
      </p>

      <form className="form-card" onSubmit={onSubmit} encType="multipart/form-data">
        {/* Honeypot anti-spam field: invisible to humans */}
        <input
          type="text"
          name="website"
          className="honeypot"
          tabIndex={-1}
          autoComplete="off"
          aria-hidden="true"
        />

        {error && <div className="form-error">{error}</div>}

        <div className="field">
          <label className="field-label" htmlFor="venueName">
            Venue name <span className="required-mark">*</span>
          </label>
          <input type="text" id="venueName" name="venueName" required maxLength={120} />
        </div>

        <div className="field">
          <label className="field-label" htmlFor="city">
            City <span className="required-mark">*</span>
          </label>
          <input type="text" id="city" name="city" required maxLength={80} />
          <p className="hint">Starting in Seattle — other cities welcome.</p>
        </div>

        <div className="field">
          <label className="field-label" htmlFor="area">
            Neighborhood / area
          </label>
          <input type="text" id="area" name="area" maxLength={80} />
          <p className="hint">Optional — leave blank and we&apos;ll fill it in.</p>
        </div>

        <div className="field">
          <span className="field-label">
            Service type <span className="required-mark">*</span>
          </span>
          <div className="radio-group">
            {[
              ['counter', 'Counter service'],
              ['table', 'Table service'],
              ['takeout', 'Takeout / pickup'],
              ['nonfood', 'Non-food retail'],
            ].map(([val, label]) => (
              <label key={val} className="radio-option">
                <input type="radio" name="serviceType" value={val} required />
                {label}
              </label>
            ))}
          </div>
        </div>

        <div className="field">
          <span className="field-label">Tip-screen presentation</span>
          <div className="radio-group">
            {[
              ['staff-held', 'Staff held the screen facing me while I chose'],
              ['handed-over', 'Screen handed to me or left on the counter'],
              ['no-screen', 'No tip screen — no tip prompt at all'],
              ['not-sure', 'Not sure'],
            ].map(([val, label]) => (
              <label key={val} className="radio-option">
                <input type="radio" name="screenPresentation" value={val} />
                {label}
              </label>
            ))}
          </div>
        </div>

        <div className="field">
          <label className="field-label" htmlFor="presets">
            What the tip screen showed
          </label>
          <input
            type="text"
            id="presets"
            name="presets"
            placeholder="e.g. 20%, 25%, 30%"
            maxLength={120}
          />
        </div>

        <div className="field">
          <span className="field-label">Was the tip calculated pre-tax or post-tax?</span>
          <div className="radio-group">
            {[
              ['pre-tax', 'Pre-tax subtotal'],
              ['post-tax', 'Post-tax total'],
              ['not-sure', 'Not sure'],
            ].map(([val, label]) => (
              <label key={val} className="radio-option">
                <input type="radio" name="tipBase" value={val} />
                {label}
              </label>
            ))}
          </div>
        </div>

        <div className="field">
          <span className="field-label">Any extra fees?</span>
          <div className="checkbox-group">
            {[
              ['service-charge', 'Service charge'],
              ['card-surcharge', 'Credit-card surcharge'],
              ['none', 'None'],
              ['other', 'Other'],
            ].map(([val, label]) => (
              <label key={val} className="checkbox-option">
                <input type="checkbox" name="fees" value={val} />
                {label}
              </label>
            ))}
          </div>
        </div>

        <div className="field">
          <label className="field-label" htmlFor="photo">
            Receipt / tip-screen photo
          </label>
          <input type="file" id="photo" name="photo" accept="image/*" />
          <p className="hint">
            Optional. Remove personal info first — we&apos;ll blur anything left in. Please no
            staff faces.
          </p>
        </div>

        <div className="field">
          <label className="field-label" htmlFor="notes">
            Anything else
          </label>
          <textarea id="notes" name="notes" maxLength={1000} />
          <p className="hint">Suggestions, feedback, anything we missed.</p>
        </div>

        <div className="field">
          <label className="field-label" htmlFor="email">
            Email (optional)
          </label>
          <input type="email" id="email" name="email" maxLength={120} />
          <p className="hint">Only if you want us to reach out.</p>
        </div>

        <button type="submit" className="submit-btn" disabled={submitting}>
          {submitting ? 'Submitting…' : 'Submit report'}
        </button>
      </form>
    </div>
  );
}
