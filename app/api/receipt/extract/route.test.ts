/**
 * Route-level tests for POST /api/receipt/extract, covering the
 * OpenAI-compatible fallback provider (OpenRouter free Qwen tier).
 *
 * global.fetch is stubbed per-test; no network, no keys leave the process.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { POST } from './route';
import type { NextRequest } from 'next/server';

// 1x1 transparent PNG — only the wire format matters, not the pixels.
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const VALID_EXTRACTION = {
  venue: 'Test Cafe',
  currency: 'USD',
  subtotal: 15.9,
  tax: 1.68,
  presets: [15, 18, 20],
  tip: 2.38,
  fees: [],
  paidTotal: 19.96,
  tipPercentage: 15,
  taxBase: 'pre',
  notes: null,
  confidence: 'high',
};

function makeRequest(): NextRequest {
  const bytes = Buffer.from(TINY_PNG_B64, 'base64');
  const file = new File([bytes], 'redacted.png', { type: 'image/png' });
  const form = new FormData();
  form.append('image', file);
  const req = new Request('http://localhost/api/receipt/extract', {
    method: 'POST',
    body: form,
  });
  return req as NextRequest;
}

function openRouterSuccess(): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify(VALID_EXTRACTION) } }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

const savedEnv = { ...process.env };
const realFetch = global.fetch;

beforeEach(() => {
  process.env = { ...savedEnv };
  delete process.env.GEMINI_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_MODEL;
  delete process.env.OPENROUTER_BASE_URL;
  vi.restoreAllMocks();
});

afterEach(() => {
  process.env = { ...savedEnv };
  global.fetch = realFetch;
});

describe('OpenAI-compatible fallback provider', () => {
  it('falls back to OpenRouter when the Gemini chain fails (non-retryable)', async () => {
    process.env.GEMINI_API_KEY = 'test-gemini-key';
    process.env.OPENROUTER_API_KEY = 'test-or-key';
    const calls: string[] = [];
    global.fetch = (async (url: unknown) => {
      const u = String(url);
      calls.push(u);
      if (u.includes('generativelanguage.googleapis.com')) {
        return new Response('bad request', { status: 400 });
      }
      if (u.includes('openrouter.ai')) {
        return openRouterSuccess();
      }
      throw new Error('unexpected URL ' + u);
    }) as typeof fetch;

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: { venue: string | null } };
    expect(body.ok).toBe(true);
    expect(body.data.venue).toBe('Test Cafe');
    // Both Gemini models tried (400 is not retryable → 1 call each), then OpenRouter.
    expect(calls.filter((u) => u.includes('generativelanguage')).length).toBe(2);
    expect(calls.filter((u) => u.includes('openrouter.ai')).length).toBe(1);
  });

  it('works with OpenRouter alone when no Gemini key is configured', async () => {
    process.env.OPENROUTER_API_KEY = 'test-or-key';
    const calls: string[] = [];
    global.fetch = (async (url: unknown) => {
      const u = String(url);
      calls.push(u);
      expect(u).toContain('openrouter.ai');
      return openRouterSuccess();
    }) as typeof fetch;

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: { subtotal: number | null } };
    expect(body.ok).toBe(true);
    expect(body.data.subtotal).toBe(15.9);
    expect(calls.length).toBe(1);
  });

  it('sends the configured model and base URL', async () => {
    process.env.OPENROUTER_API_KEY = 'test-or-key';
    process.env.OPENROUTER_MODEL = 'qwen/qwen2.5-vl-3b-instruct:free';
    process.env.OPENROUTER_BASE_URL = 'https://proxy.example.com/v1/';
    let seenUrl = '';
    let seenBody = '';
    global.fetch = (async (url: unknown, init: unknown) => {
      seenUrl = String(url);
      seenBody = String((init as { body?: unknown }).body ?? '');
      return openRouterSuccess();
    }) as typeof fetch;

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    expect(seenUrl).toBe('https://proxy.example.com/v1/chat/completions');
    const parsed = JSON.parse(seenBody) as { model: string };
    expect(parsed.model).toBe('qwen/qwen2.5-vl-3b-instruct:free');
  });

  it('returns the manual fallback when every provider fails', async () => {
    process.env.GEMINI_API_KEY = 'test-gemini-key';
    process.env.OPENROUTER_API_KEY = 'test-or-key';
    global.fetch = (async (url: unknown) => {
      const u = String(url);
      if (u.includes('generativelanguage.googleapis.com')) {
        return new Response('bad request', { status: 400 });
      }
      return new Response('busy', { status: 429 });
    }) as typeof fetch;

    const res = await POST(makeRequest());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ok: boolean; fallback: string };
    expect(body.ok).toBe(false);
    expect(body.fallback).toBe('manual');
  });

  it('returns "not configured" when neither key is set', async () => {
    const res = await POST(makeRequest());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ok: boolean; fallback: string };
    expect(body.ok).toBe(false);
    expect(body.fallback).toBe('manual');
  });
});
