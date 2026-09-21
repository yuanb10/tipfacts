'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/** Per-report Approve / Reject + optional note. The mod key is passed in as a
 *  prop from the server component; the API verifies it on every request. */
export default function ModerationControls({ modKey, reportId }: { modKey: string; reportId: string }) {
  const router = useRouter();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<'approved' | 'rejected' | null>(null);

  async function decide(action: 'approved' | 'rejected') {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/moderate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: modKey, reportId, action, note }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || `Request failed (${res.status}).`);
      }
      setDone(action);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <p style={{ fontSize: 14, fontWeight: 700 }}>
        {done === 'approved' ? '✅ Approved' : '❌ Rejected'}
        <span style={{ fontWeight: 400, color: 'var(--muted)' }}> — removed from the queue.</span>
      </p>
    );
  }

  return (
    <div>
      {error && <div className="form-error">{error}</div>}
      <div className="field" style={{ marginBottom: 8 }}>
        <label className="field-label" htmlFor={`note-${reportId}`}>
          Moderation note (optional)
        </label>
        <input
          type="text"
          id={`note-${reportId}`}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. receipt backs the fees, looks legit"
          maxLength={500}
          style={{ width: '100%', padding: 8, borderRadius: 8, border: '1px solid var(--line)' }}
        />
      </div>
      <div className="btn-row" style={{ justifyContent: 'flex-start' }}>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => decide('approved')}>
          {busy ? 'Working…' : 'Approve'}
        </button>
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => decide('rejected')}>
          {busy ? 'Working…' : 'Reject'}
        </button>
      </div>
    </div>
  );
}
