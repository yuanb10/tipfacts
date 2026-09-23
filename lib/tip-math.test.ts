/**
 * Unit tests for the manual-track tax-base heuristic (lib/tip-math.ts).
 *
 * The guess picks whichever base (pre-tax subtotal vs post-tax total) puts the
 * tip closest to a whole or half percent; ties within 0.1pp and invalid
 * inputs return 'unknown' so the user picks explicitly.
 */
import { describe, expect, it } from 'vitest';
import { inferTaxBase, tipPercentOf } from './tip-math';

describe('inferTaxBase', () => {
  it('guesses pre-tax when the tip is round on the subtotal', () => {
    // 20% on pre-tax, 18.3% on post-tax
    expect(inferTaxBase(50, 5, 10)).toBe('pre-tax');
  });

  it('guesses post-tax when the tip is round on the after-tax total', () => {
    // 22% on post-tax 55, 24.2% on pre-tax 50
    expect(inferTaxBase(50, 5, 12.1)).toBe('post-tax');
  });

  it('recognizes half-percent presets', () => {
    // 22.5% on pre-tax (roundness 0) vs 20.6% on post-tax
    expect(inferTaxBase(40, 3.6, 9)).toBe('pre-tax');
  });

  it('returns unknown on a near tie (within 0.1pp)', () => {
    // both bases give exactly 20%
    expect(inferTaxBase(50, 0, 10)).toBe('unknown');
  });

  it('returns unknown for invalid inputs', () => {
    expect(inferTaxBase(null, 5, 10)).toBe('unknown');
    expect(inferTaxBase(50, null, 10)).toBe('unknown');
    expect(inferTaxBase(50, 5, null)).toBe('unknown');
    expect(inferTaxBase(0, 5, 10)).toBe('unknown');
    expect(inferTaxBase(-50, 5, 10)).toBe('unknown');
    expect(inferTaxBase(50, -5, 10)).toBe('unknown');
    expect(inferTaxBase(NaN, 5, 10)).toBe('unknown');
  });
});

describe('tipPercentOf', () => {
  it('computes tip / base * 100', () => {
    expect(tipPercentOf(8.5, 42.5)).toBeCloseTo(20, 10);
  });

  it('returns null when uncomputable', () => {
    expect(tipPercentOf(null, 42.5)).toBeNull();
    expect(tipPercentOf(8.5, 0)).toBeNull();
    expect(tipPercentOf(8.5, -1)).toBeNull();
  });
});
