/**
 * JsonStore — file-backed Storage for local development.
 * Data lives in data/db.json. Legacy v1 files (a bare array of old-shape
 * reports) are migrated in memory on load: old reports become approved,
 * non-seed reports so existing dev data keeps working.
 */
import fs from 'fs';
import path from 'path';
import type {
  Evidence,
  ModerationAction,
  NewEvidence,
  NewReport,
  RateLimitResult,
  Report,
  ReportFilter,
  Storage,
  Venue,
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

  async findOrCreateVenue(name: string, city: string, area = '', opts: { isSeed?: boolean } = {}): Promise<Venue> {
    const db = this.read();
    const id = venueSlug(name, city);
    let v = db.venues.find((x) => x.id === id);
    if (!v) {
      v = { id, name: name.trim(), city: city.trim(), area: area.trim(), isSeed: opts.isSeed ?? false, createdAt: new Date().toISOString() };
      db.venues.push(v);
      this.write(db);
    } else if (opts.isSeed && !v.isSeed) {
      v.isSeed = true;
      this.write(db);
    }
    return v;
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
      experienceNote: input.experienceNote ?? '',
      notes: input.notes ?? '',
      evidenceIds: input.evidenceIds ?? [],
      moderationStatus: 'pending',
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
