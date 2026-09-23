/**
 * JsonStore — file-backed Storage for local development.
 * Data lives in data/db.json. Legacy v1 files (a bare array of old-shape
 * reports) are migrated in memory on load: old reports become approved,
 * non-seed reports so existing dev data keeps working.
 */
import fs from 'fs';
import path from 'path';
import type {
  BulkUpsertResult,
  Evidence,
  FindOrCreateVenueOpts,
  ModerationAction,
  ModerationStatus,
  NewEvidence,
  NewReport,
  RateLimitResult,
  Report,
  ReportFilter,
  Storage,
  Venue,
  VenueUpsert,
} from './storage.ts';
import { hashKey, newId, venueSlug } from './storage.ts';

const DB_PATH = path.join(process.cwd(), 'data', 'db.json');

interface DbShape {
  version: 2;
  venues: Venue[];
  reports: Report[];
  evidence: Evidence[];
  rateLimitHits: { key: string; ts: string }[];
  moderationActions: ModerationAction[];
}

function emptyDb(): DbShape {
  return { version: 2, venues: [], reports: [], evidence: [], rateLimitHits: [], moderationActions: [] };
}

/** Convert an old v1 report (lib/store.ts shape) to the v2 Report shape. */
function migrateLegacyReport(r: any): Report {
  const venueId = venueSlug(String(r.venueName ?? ''), String(r.city ?? ''));
  return {
    id: String(r.id ?? newId()),
    venueId,
    venueName: String(r.venueName ?? ''),
    city: String(r.city ?? ''),
    area: String(r.area ?? ''),
    serviceType: r.serviceType ?? 'table',
    screenPresentation: String(r.screenPresentation ?? ''),
    presets: String(r.presets ?? ''),
    tipBase: r.tipBase ?? '',
    fees: Array.isArray(r.fees) ? r.fees.map(String) : [],
    guilt: 'skip',
    easyOptOut: 'skip',
    experienceNote: '',
    notes: String(r.notes ?? ''),
    evidenceIds: [],
    moderationStatus: 'approved',
    moderationNote: 'migrated from v1 store',
    decidedAt: String(r.createdAt ?? new Date().toISOString()),
    reporterHash: '',
    isSeed: false,
    createdAt: String(r.createdAt ?? new Date().toISOString()),
  };
}

export class JsonStore implements Storage {
  private read(): DbShape {
    try {
      const raw = fs.readFileSync(DB_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        // Legacy v1: bare array of reports.
        const reports = parsed.map(migrateLegacyReport);
        const venues = new Map<string, Venue>();
        for (const r of reports) {
          if (!venues.has(r.venueId)) {
            venues.set(r.venueId, {
              id: r.venueId,
              name: r.venueName,
              city: r.city,
              area: r.area,
              address: '',
              lat: null,
              lng: null,
              category: '',
              source: 'manual',
              isSeed: false,
              createdAt: r.createdAt,
            });
          }
        }
        return { ...emptyDb(), venues: [...venues.values()], reports };
      }
      if (parsed && parsed.version === 2) return parsed as DbShape;
      return emptyDb();
    } catch {
      return emptyDb();
    }
  }

  private write(db: DbShape): void {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
  }

  private matches(r: Report, f: ReportFilter): boolean {
    if (f.venueId && r.venueId !== f.venueId) return false;
    if (f.status) {
      const want = Array.isArray(f.status) ? f.status : [f.status];
      if (!want.includes(r.moderationStatus)) return false;
    }
    if (f.includeSeeds === false && r.isSeed) return false;
    return true;
  }

  async listVenues(): Promise<Venue[]> {
    return this.read().venues;
  }

  async getVenue(id: string): Promise<Venue | null> {
    return this.read().venues.find((v) => v.id === id) ?? null;
  }

  async findOrCreateVenue(name: string, city: string, area = '', opts: FindOrCreateVenueOpts = {}): Promise<Venue> {
    const db = this.read();
    const id = venueSlug(name, city, opts.disambiguator);
    let v = db.venues.find((x) => x.id === id);
    if (!v) {
      v = {
        id,
        name: name.trim(),
        city: city.trim(),
        area: area.trim(),
        address: (opts.address ?? '').trim(),
        lat: opts.lat ?? null,
        lng: opts.lng ?? null,
        category: (opts.category ?? '').trim(),
        source: opts.source ?? 'manual',
        isSeed: opts.isSeed ?? false,
        createdAt: new Date().toISOString(),
      };
      db.venues.push(v);
      this.write(db);
    } else {
      // Conflict: patch only fields the caller explicitly provided, so a
      // plain user submission never wipes import-enriched data.
      let touched = false;
      if (opts.isSeed && !v.isSeed) { v.isSeed = true; touched = true; }
      if (opts.address !== undefined && opts.address.trim() && opts.address.trim() !== v.address) { v.address = opts.address.trim(); touched = true; }
      if (opts.lat !== undefined && opts.lat !== null && v.lat === null) { v.lat = opts.lat; touched = true; }
      if (opts.lng !== undefined && opts.lng !== null && v.lng === null) { v.lng = opts.lng; touched = true; }
      if (opts.category !== undefined && opts.category.trim() && !v.category) { v.category = opts.category.trim(); touched = true; }
      if (touched) this.write(db);
    }
    return v;
  }

  async bulkUpsertVenues(items: VenueUpsert[]): Promise<BulkUpsertResult> {
    const db = this.read();
    const byId = new Map(db.venues.map((v) => [v.id, v]));
    let created = 0;
    let updated = 0;
    for (const it of items) {
      const name = it.name.trim();
      const city = it.city.trim();
      if (!name || !city) continue;
      const id = venueSlug(name, city, it.disambiguator);
      const existing = byId.get(id);
      if (existing) {
        const address = (it.address ?? '').trim();
        if (address && address !== existing.address) existing.address = address;
        if (it.lat != null && existing.lat === null) existing.lat = it.lat;
        if (it.lng != null && existing.lng === null) existing.lng = it.lng;
        const category = (it.category ?? '').trim();
        if (category && !existing.category) existing.category = category;
        if (it.source === 'osm' && existing.source !== 'osm') existing.source = 'osm';
        updated++;
      } else {
        byId.set(id, {
          id,
          name,
          city,
          area: (it.area ?? '').trim(),
          address: (it.address ?? '').trim(),
          lat: it.lat ?? null,
          lng: it.lng ?? null,
          category: (it.category ?? '').trim(),
          source: it.source ?? 'manual',
          isSeed: false,
          createdAt: new Date().toISOString(),
        });
        created++;
      }
    }
    db.venues = [...byId.values()];
    this.write(db);
    return { created, updated, total: db.venues.length };
  }

  async listReports(filter: ReportFilter = {}): Promise<Report[]> {
    return this.read().reports.filter((r) => this.matches(r, filter));
  }

  async getReport(id: string): Promise<Report | null> {
    return this.read().reports.find((r) => r.id === id) ?? null;
  }

  async createReport(input: NewReport): Promise<Report> {
    const db = this.read();
    const now = new Date().toISOString();
    const report: Report = {
      id: newId(),
      venueId: input.venueId,
      venueName: input.venueName,
      city: input.city,
      area: input.area ?? '',
      serviceType: input.serviceType,
      screenPresentation: input.screenPresentation ?? '',
      presets: input.presets ?? '',
      tipBase: input.tipBase ?? '',
      fees: input.fees ?? [],
      guilt: input.guilt ?? 'skip',
      easyOptOut: input.easyOptOut ?? 'skip',
      experienceNote: input.experienceNote ?? '',
      notes: input.notes ?? '',
      evidenceIds: input.evidenceIds ?? [],
      // v1: moderation isn't wired up yet (no MOD_SECRET), so publish
      // immediately. Setting MOD_SECRET later puts new reports back to
      // 'pending' with zero code changes.
      moderationStatus: (process.env.MOD_SECRET ? 'pending' : 'approved') as ModerationStatus,
      moderationNote: '',
      decidedAt: null,
      reporterHash: input.reporterHash ?? '',
      isSeed: input.isSeed ?? false,
      createdAt: now,
    };
    db.reports.push(report);
    // Back-link evidence rows — but never steal a link that already exists.
    for (const eid of report.evidenceIds) {
      const ev = db.evidence.find((e) => e.id === eid);
      if (ev && !ev.reportId) ev.reportId = report.id;
    }
    this.write(db);
    return report;
  }

  async setReportStatus(id: string, status: 'approved' | 'rejected', note = ''): Promise<Report> {
    const db = this.read();
    const r = db.reports.find((x) => x.id === id);
    if (!r) throw new Error('report not found: ' + id);
    r.moderationStatus = status;
    r.moderationNote = note;
    r.decidedAt = new Date().toISOString();
    this.write(db);
    return r;
  }

  async linkEvidence(reportId: string, evidenceId: string): Promise<void> {
    const db = this.read();
    const r = db.reports.find((x) => x.id === reportId);
    const ev = db.evidence.find((e) => e.id === evidenceId);
    if (!r || !ev) throw new Error('report or evidence not found');
    if (!r.evidenceIds.includes(evidenceId)) r.evidenceIds.push(evidenceId);
    ev.reportId = reportId;
    this.write(db);
  }

  async createEvidence(input: NewEvidence): Promise<Evidence> {
    const db = this.read();
    const ev: Evidence = {
      id: newId(),
      reportId: null,
      type: input.type,
      originalPath: input.originalPath,
      redactedPath: input.redactedPath ?? null,
      redactionStatus: input.redactionStatus ?? 'pending',
      userConfirmed: input.userConfirmed ?? false,
      parsed: input.parsed ?? null,
      isSeed: input.isSeed ?? false,
      createdAt: new Date().toISOString(),
    };
    db.evidence.push(ev);
    this.write(db);
    return ev;
  }

  async getEvidence(id: string): Promise<Evidence | null> {
    return this.read().evidence.find((e) => e.id === id) ?? null;
  }

  async updateEvidence(id: string, patch: Partial<Evidence>): Promise<Evidence> {
    const db = this.read();
    const ev = db.evidence.find((e) => e.id === id);
    if (!ev) throw new Error('evidence not found: ' + id);
    Object.assign(ev, patch, { id: ev.id, createdAt: ev.createdAt });
    this.write(db);
    return ev;
  }

  async listEvidenceForReport(reportId: string): Promise<Evidence[]> {
    return this.read().evidence.filter((e) => e.reportId === reportId);
  }

  async logModerationAction(reportId: string, action: 'approved' | 'rejected', note = ''): Promise<ModerationAction> {
    const db = this.read();
    const a: ModerationAction = { id: newId(), reportId, action, note, createdAt: new Date().toISOString() };
    db.moderationActions.push(a);
    this.write(db);
    return a;
  }

  async listModerationActions(reportId: string): Promise<ModerationAction[]> {
    return this.read().moderationActions.filter((a) => a.reportId === reportId);
  }

  async checkRateLimit(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    const db = this.read();
    const now = Date.now();
    const cutoff = new Date(now - windowMs).toISOString();
    const k = hashKey(key);
    const hits = db.rateLimitHits.filter((h) => h.ts >= cutoff);
    const mine = hits.filter((h) => h.key === k);
    if (mine.length >= limit) {
      db.rateLimitHits = hits;
      this.write(db);
      return { allowed: false, remaining: 0 };
    }
    hits.push({ key: k, ts: new Date(now).toISOString() });
    db.rateLimitHits = hits;
    this.write(db);
    return { allowed: true, remaining: limit - mine.length - 1 };
  }

  async wipeAll(): Promise<void> {
    this.write(emptyDb());
  }

  async close(): Promise<void> {
    // nothing to close for the file backend
  }
}
