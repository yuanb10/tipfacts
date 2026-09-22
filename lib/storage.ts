/**
 * TipFacts storage layer: shared types, the Storage interface, and the
 * backend factory. Two backends:
 *   - JsonStore   (lib/json-store.ts)  — local-dev default, data/db.json
 *   - PostgresStore (lib/pg-store.ts)   — used when DATABASE_URL is set
 *
 * Import rule: this file and the backends use RELATIVE imports only, so that
 * scripts/*.ts can import them directly under plain node (type stripping).
 */

import crypto from 'crypto';
import { JsonStore } from './json-store.ts';
import { PostgresStore } from './pg-store.ts';

export type ServiceType = 'counter' | 'table' | 'takeout' | 'nonfood';
export type TipBase = 'pre-tax' | 'post-tax' | 'not-sure';
export type EvidenceType = 'receipt' | 'screen';
export type ModerationStatus = 'pending' | 'approved' | 'rejected';
export type RedactionStatus = 'pending' | 'confirmed' | 'failed' | 'manual';

/** Values parsed from a receipt/screen photo. Never fabricated: ocrEngine is
 *  'tesseract' when machine-read, 'manual' when the uploader typed them in. */
export interface ReceiptParsed {
  merchant: string | null;
  purchasedAt: string | null;
  subtotal: number | null;
  tax: number | null;
  tip: number | null;
  total: number | null;
  fees: { label: string; amount: number | null }[];
  presets: number[];
  tipPercentReported: number | null;
  rawText: string | null;
  ocrEngine: 'tesseract' | 'manual' | null;
  ocrConfidence: number | null; // 0-100 mean word confidence, tesseract only
}

/** One photo: original is NEVER served publicly; only the redacted copy is,
 *  and only after the uploader confirms it. */
export interface Evidence {
  id: string;
  reportId: string | null;
  type: EvidenceType;
  originalPath: string; // e.g. data/uploads-private/<id>.png — not web-served
  redactedPath: string | null; // e.g. /uploads/<id>-redacted.png — public
  redactionStatus: RedactionStatus;
  userConfirmed: boolean;
  parsed: ReceiptParsed | null;
  isSeed: boolean;
  createdAt: string; // ISO
}

/** One submission. Nothing is published until moderationStatus === 'approved'. */
export interface Report {
  id: string;
  venueId: string; // canonical venue slug
  venueName: string; // as entered by the reporter
  city: string;
  area: string;
  serviceType: ServiceType;
  screenPresentation: string;
  presets: string;
  tipBase: TipBase | '';
  fees: string[];
  guilt: 'yes' | 'no' | 'skip';
  easyOptOut: 'yes' | 'no' | 'skip'; // was it easy to pick custom tip / no tip?
  experienceNote: string; // subjective; shown separately, never scored
  notes: string;
  evidenceIds: string[];
  moderationStatus: ModerationStatus;
  moderationNote: string;
  decidedAt: string | null; // ISO
  reporterHash: string; // sha256(ip); raw IPs are never stored
  isSeed: boolean;
  createdAt: string; // ISO
}

/** Canonical venue identity. Stable slug id: slugify(name) + '--' + slugify(city),
 *  with an optional '--' + slugify(disambiguator) suffix when one name maps to
 *  several real locations (e.g. chain branches at different addresses).
 *  `source` marks bulk-imported public listings ('osm') vs human-created ones.
 *  Venues with no approved reports are listing shells: they appear in
 *  type-ahead/nearby but not in the public leaderboard until real data lands. */
export interface Venue {
  id: string;
  name: string;
  city: string;
  area: string;
  address: string; // street address, e.g. "123 3rd Ave" — '' when unknown
  lat: number | null;
  lng: number | null;
  category: string; // e.g. "cafe", "restaurant" — '' when unknown
  source: 'osm' | 'manual';
  isSeed: boolean;
  createdAt: string; // ISO
}

export interface ModerationAction {
  id: string;
  reportId: string;
  action: 'approved' | 'rejected';
  note: string;
  createdAt: string; // ISO
}

export interface NewEvidence {
  type: EvidenceType;
  originalPath: string;
  redactedPath?: string | null;
  redactionStatus?: RedactionStatus;
  userConfirmed?: boolean;
  parsed?: ReceiptParsed | null;
  isSeed?: boolean;
}

export interface NewReport {
  venueId: string;
  venueName: string;
  city: string;
  area?: string;
  serviceType: ServiceType;
  screenPresentation?: string;
  presets?: string;
  tipBase?: TipBase | '';
  fees?: string[];
  guilt?: 'yes' | 'no' | 'skip';
  easyOptOut?: 'yes' | 'no' | 'skip';
  experienceNote?: string;
  notes?: string;
  evidenceIds?: string[];
  reporterHash?: string;
  isSeed?: boolean;
}

export interface ReportFilter {
  venueId?: string;
  status?: ModerationStatus | ModerationStatus[];
  includeSeeds?: boolean; // default true
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
}

export interface FindOrCreateVenueOpts {
  isSeed?: boolean;
  address?: string;
  lat?: number | null;
  lng?: number | null;
  category?: string;
  source?: 'osm' | 'manual';
  /** Extra slug segment when one (name, city) maps to several locations. */
  disambiguator?: string;
}

/** One venue shell for bulk import (scripts/import-osm.ts). */
export interface VenueUpsert {
  name: string;
  city: string;
  area?: string;
  address?: string;
  lat?: number | null;
  lng?: number | null;
  category?: string;
  source?: 'osm' | 'manual';
  disambiguator?: string;
}

export interface BulkUpsertResult {
  created: number;
  updated: number; // existing rows enriched / already present
  total: number; // venues in store after the upsert
}

export interface Storage {
  // venues
  listVenues(): Promise<Venue[]>;
  getVenue(id: string): Promise<Venue | null>;
  findOrCreateVenue(name: string, city: string, area?: string, opts?: FindOrCreateVenueOpts): Promise<Venue>;
  /** Bulk upsert for imports: single read/write on the JSON backend, one
   *  transaction on Postgres. Re-running with the same input is a no-op. */
  bulkUpsertVenues(items: VenueUpsert[]): Promise<BulkUpsertResult>;
  // reports
  listReports(filter?: ReportFilter): Promise<Report[]>;
  getReport(id: string): Promise<Report | null>;
  createReport(input: NewReport): Promise<Report>;
  setReportStatus(id: string, status: 'approved' | 'rejected', note?: string): Promise<Report>;
  linkEvidence(reportId: string, evidenceId: string): Promise<void>;
  // evidence
  createEvidence(input: NewEvidence): Promise<Evidence>;
  getEvidence(id: string): Promise<Evidence | null>;
  updateEvidence(id: string, patch: Partial<Evidence>): Promise<Evidence>;
  listEvidenceForReport(reportId: string): Promise<Evidence[]>;
  // moderation audit trail
  logModerationAction(reportId: string, action: 'approved' | 'rejected', note?: string): Promise<ModerationAction>;
  listModerationActions(reportId: string): Promise<ModerationAction[]>;
  // durable rate limiting: at most `limit` hits per `windowMs` per key
  checkRateLimit(key: string, limit: number, windowMs: number): Promise<RateLimitResult>;
  // seeds / wipe
  wipeAll(): Promise<void>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------- helpers

export function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function slugify(s: string): string {
  return normalize(s)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function venueSlug(name: string, city: string, disambiguator?: string): string {
  const base = slugify(name) + '--' + slugify(city);
  const d = disambiguator ? slugify(disambiguator) : '';
  return d ? `${base}--${d}` : base;
}

export function newId(): string {
  return crypto.randomBytes(8).toString('hex');
}

/** One-way hash for IPs. Raw IPs are never persisted. */
export function hashKey(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

// ---------------------------------------------------------------- factory

let cached: Storage | null = null;

/** Postgres when DATABASE_URL is set, otherwise the local JSON store. */
export function getStorage(): Storage {
  if (!cached) {
    cached = process.env.DATABASE_URL ? new PostgresStore(process.env.DATABASE_URL) : new JsonStore();
  }
  return cached;
}

/** For scripts/tests that need a fresh instance (e.g. after env changes). */
export function resetStorageCache(): void {
  cached = null;
}
