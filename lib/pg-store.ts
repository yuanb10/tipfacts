/**
 * PostgresStore — durable Storage backend, used when DATABASE_URL is set.
 * Schema lives in scripts/migrate.sql; run `npm run migrate` to apply it.
 */
import { Pool } from 'pg';
import type {
  BulkUpsertResult,
  Evidence,
  FindOrCreateVenueOpts,
  ModerationAction,
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

function iso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  return String(v ?? new Date().toISOString());
}

function toVenue(row: any): Venue {
  return {
    id: row.id,
    name: row.name,
    city: row.city,
    area: row.area ?? '',
    address: row.address ?? '',
    lat: row.lat == null ? null : Number(row.lat),
    lng: row.lng == null ? null : Number(row.lng),
    category: row.category ?? '',
    source: row.source === 'osm' ? 'osm' : 'manual',
    isSeed: !!row.is_seed,
    createdAt: iso(row.created_at),
  };
}

function toReport(row: any): Report {
  return {
    id: row.id,
    venueId: row.venue_id,
    venueName: row.venue_name,
    city: row.city,
    area: row.area ?? '',
    serviceType: row.service_type,
    screenPresentation: row.screen_presentation ?? '',
    presets: row.presets ?? '',
    tipBase: row.tip_base ?? '',
    fees: Array.isArray(row.fees) ? row.fees.map(String) : [],
    guilt: row.guilt ?? 'skip',
    easyOptOut: row.easy_opt_out ?? 'skip',
    experienceNote: row.experience_note ?? '',
    notes: row.notes ?? '',
    evidenceIds: Array.isArray(row.evidence_ids) ? row.evidence_ids.map(String) : [],
    moderationStatus: row.moderation_status,
    moderationNote: row.moderation_note ?? '',
    decidedAt: row.decided_at ? iso(row.decided_at) : null,
    reporterHash: row.reporter_hash ?? '',
    isSeed: !!row.is_seed,
    createdAt: iso(row.created_at),
  };
}

function toEvidence(row: any): Evidence {
  return {
    id: row.id,
    reportId: row.report_id ?? null,
    type: row.type,
    originalPath: row.original_path,
    redactedPath: row.redacted_path ?? null,
    redactionStatus: row.redaction_status,
    userConfirmed: !!row.user_confirmed,
    parsed: row.parsed ?? null,
    isSeed: !!row.is_seed,
    createdAt: iso(row.created_at),
  };
}

export class PostgresStore implements Storage {
  private pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      ssl: /localhost|127\.0\.0\.1/.test(connectionString) ? undefined : { rejectUnauthorized: false },
    });
  }

  async listVenues(): Promise<Venue[]> {
    const { rows } = await this.pool.query('SELECT * FROM venues ORDER BY name, city');
    return rows.map(toVenue);
  }

  async getVenue(id: string): Promise<Venue | null> {
    const { rows } = await this.pool.query('SELECT * FROM venues WHERE id = $1', [id]);
    return rows.length ? toVenue(rows[0]) : null;
  }

  async findOrCreateVenue(name: string, city: string, area = '', opts: FindOrCreateVenueOpts = {}): Promise<Venue> {
    const id = venueSlug(name, city, opts.disambiguator);
    const existing = await this.getVenue(id);
    if (existing) {
      // Patch only explicitly provided enrichment fields; never wipe.
      const sets: string[] = [];
      const params: unknown[] = [];
      if (opts.isSeed && !existing.isSeed) { params.push(true); sets.push(`is_seed = $${params.length}`); }
      if (opts.address !== undefined && opts.address.trim()) { params.push(opts.address.trim()); sets.push(`address = $${params.length}`); }
      if (opts.lat !== undefined && opts.lat !== null && existing.lat === null) { params.push(opts.lat); sets.push(`lat = $${params.length}`); }
      if (opts.lng !== undefined && opts.lng !== null && existing.lng === null) { params.push(opts.lng); sets.push(`lng = $${params.length}`); }
      if (opts.category !== undefined && opts.category.trim() && !existing.category) { params.push(opts.category.trim()); sets.push(`category = $${params.length}`); }
      if (sets.length) {
        params.push(id);
        const { rows } = await this.pool.query(
          `UPDATE venues SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
          params,
        );
        return toVenue(rows[0]);
      }
      return existing;
    }
    const { rows } = await this.pool.query(
      `INSERT INTO venues (id, name, city, area, address, lat, lng, category, source, is_seed)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (id) DO NOTHING
       RETURNING *`,
      [
        id,
        name.trim(),
        city.trim(),
        area.trim(),
        (opts.address ?? '').trim(),
        opts.lat ?? null,
        opts.lng ?? null,
        (opts.category ?? '').trim(),
        opts.source ?? 'manual',
        opts.isSeed ?? false,
      ],
    );
    if (rows.length) return toVenue(rows[0]);
    const v = await this.getVenue(id); // lost a race with a concurrent insert
    if (!v) throw new Error('venue upsert failed: ' + id);
    return v;
  }

  async bulkUpsertVenues(items: VenueUpsert[]): Promise<BulkUpsertResult> {
    const clean = items
      .map((it) => ({
        id: venueSlug(it.name.trim(), it.city.trim(), it.disambiguator),
        name: it.name.trim(),
        city: it.city.trim(),
        area: (it.area ?? '').trim(),
        address: (it.address ?? '').trim(),
        lat: it.lat ?? null,
        lng: it.lng ?? null,
        category: (it.category ?? '').trim(),
        source: it.source ?? 'manual' as const,
      }))
      .filter((v) => v.name && v.city);
    if (!clean.length) {
      const { rows } = await this.pool.query('SELECT COUNT(*)::int AS n FROM venues');
      return { created: 0, updated: 0, total: rows[0].n };
    }
    const before = await this.pool.query('SELECT id FROM venues');
    const had = new Set<string>(before.rows.map((r: any) => r.id));
    const cols = ['id', 'name', 'city', 'area', 'address', 'lat', 'lng', 'category', 'source'];
    const values: unknown[] = [];
    const tuples = clean.map((v) => {
      const row = [v.id, v.name, v.city, v.area, v.address, v.lat, v.lng, v.category, v.source];
      const base = values.length;
      values.push(...row);
      return `(${row.map((_, i) => `$${base + i + 1}`).join(',')})`;
    });
    await this.pool.query(
      `INSERT INTO venues (${cols.join(',')}) VALUES ${tuples.join(',')}
       ON CONFLICT (id) DO UPDATE SET
         address = CASE WHEN EXCLUDED.address <> '' THEN EXCLUDED.address ELSE venues.address END,
         lat = COALESCE(venues.lat, EXCLUDED.lat),
         lng = COALESCE(venues.lng, EXCLUDED.lng),
         category = CASE WHEN venues.category = '' THEN EXCLUDED.category ELSE venues.category END,
         source = CASE WHEN EXCLUDED.source = 'osm' THEN 'osm' ELSE venues.source END`,
      values,
    );
    const after = await this.pool.query('SELECT COUNT(*)::int AS n FROM venues');
    let created = 0;
    for (const v of clean) if (!had.has(v.id)) created++;
    return { created, updated: clean.length - created, total: after.rows[0].n };
  }

  async listReports(filter: ReportFilter = {}): Promise<Report[]> {
    const conds: string[] = [];
    const params: unknown[] = [];
    if (filter.venueId) {
      params.push(filter.venueId);
      conds.push(`venue_id = $${params.length}`);
    }
    if (filter.status) {
      const want = Array.isArray(filter.status) ? filter.status : [filter.status];
      params.push(want);
      conds.push(`moderation_status = ANY($${params.length})`);
    }
    if (filter.includeSeeds === false) conds.push('is_seed = FALSE');
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const { rows } = await this.pool.query(`SELECT * FROM reports ${where} ORDER BY created_at DESC`, params);
    return rows.map(toReport);
  }

  async getReport(id: string): Promise<Report | null> {
    const { rows } = await this.pool.query('SELECT * FROM reports WHERE id = $1', [id]);
    return rows.length ? toReport(rows[0]) : null;
  }

  async createReport(input: NewReport): Promise<Report> {
    const id = newId();
    const { rows } = await this.pool.query(
      `INSERT INTO reports
         (id, venue_id, venue_name, city, area, service_type, screen_presentation,
          presets, tip_base, fees, guilt, easy_opt_out, experience_note, notes, evidence_ids,
          reporter_hash, is_seed)
       VALUES
         ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15::jsonb,$16,$17)
       RETURNING *`,
      [
        id,
        input.venueId,
        input.venueName,
        input.city,
        input.area ?? '',
        input.serviceType,
        input.screenPresentation ?? '',
        input.presets ?? '',
        input.tipBase ?? '',
        JSON.stringify(input.fees ?? []),
        input.guilt ?? 'skip',
        input.easyOptOut ?? 'skip',
        input.experienceNote ?? '',
        input.notes ?? '',
        JSON.stringify(input.evidenceIds ?? []),
        input.reporterHash ?? '',
        input.isSeed ?? false,
      ],
    );
    const report = toReport(rows[0]);
    // Back-link evidence rows — but never steal a link that already exists.
    for (const eid of report.evidenceIds) {
      await this.pool.query('UPDATE evidence SET report_id = $1 WHERE id = $2 AND report_id IS NULL', [id, eid]);
    }
    return report;
  }

  async setReportStatus(id: string, status: 'approved' | 'rejected', note = ''): Promise<Report> {
    const { rows } = await this.pool.query(
      `UPDATE reports SET moderation_status = $2, moderation_note = $3, decided_at = now()
       WHERE id = $1 RETURNING *`,
      [id, status, note],
    );
    if (!rows.length) throw new Error('report not found: ' + id);
    return toReport(rows[0]);
  }

  async linkEvidence(reportId: string, evidenceId: string): Promise<void> {
    await this.pool.query('UPDATE evidence SET report_id = $1 WHERE id = $2', [reportId, evidenceId]);
    await this.pool.query(
      `UPDATE reports SET evidence_ids =
         (SELECT jsonb_agg(DISTINCT x) FROM jsonb_array_elements_text(evidence_ids || $2::jsonb) x)
       WHERE id = $1`,
      [reportId, JSON.stringify([evidenceId])],
    );
  }

  async createEvidence(input: NewEvidence): Promise<Evidence> {
    const { rows } = await this.pool.query(
      `INSERT INTO evidence
         (id, type, original_path, redacted_path, redaction_status, user_confirmed, parsed, is_seed)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
       RETURNING *`,
      [
        newId(),
        input.type,
        input.originalPath,
        input.redactedPath ?? null,
        input.redactionStatus ?? 'pending',
        input.userConfirmed ?? false,
        input.parsed ? JSON.stringify(input.parsed) : null,
        input.isSeed ?? false,
      ],
    );
    return toEvidence(rows[0]);
  }

  async getEvidence(id: string): Promise<Evidence | null> {
    const { rows } = await this.pool.query('SELECT * FROM evidence WHERE id = $1', [id]);
    return rows.length ? toEvidence(rows[0]) : null;
  }

  async updateEvidence(id: string, patch: Partial<Evidence>): Promise<Evidence> {
    const sets: string[] = [];
    const params: unknown[] = [];
    const put = (col: string, val: unknown, json = false) => {
      params.push(json ? JSON.stringify(val) : val);
      sets.push(`${col} = $${params.length}${json ? '::jsonb' : ''}`);
    };
    if (patch.reportId !== undefined) put('report_id', patch.reportId);
    if (patch.redactedPath !== undefined) put('redacted_path', patch.redactedPath);
    if (patch.redactionStatus !== undefined) put('redaction_status', patch.redactionStatus);
    if (patch.userConfirmed !== undefined) put('user_confirmed', patch.userConfirmed);
    if (patch.parsed !== undefined) put('parsed', patch.parsed, true);
    if (!sets.length) {
      const cur = await this.getEvidence(id);
      if (!cur) throw new Error('evidence not found: ' + id);
      return cur;
    }
    params.push(id);
    const { rows } = await this.pool.query(
      `UPDATE evidence SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params,
    );
    if (!rows.length) throw new Error('evidence not found: ' + id);
    return toEvidence(rows[0]);
  }

  async listEvidenceForReport(reportId: string): Promise<Evidence[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM evidence WHERE report_id = $1 ORDER BY created_at',
      [reportId],
    );
    return rows.map(toEvidence);
  }

  async logModerationAction(reportId: string, action: 'approved' | 'rejected', note = ''): Promise<ModerationAction> {
    const { rows } = await this.pool.query(
      'INSERT INTO moderation_actions (id, report_id, action, note) VALUES ($1,$2,$3,$4) RETURNING *',
      [newId(), reportId, action, note],
    );
    const r = rows[0];
    return { id: r.id, reportId: r.report_id, action: r.action, note: r.note ?? '', createdAt: iso(r.created_at) };
  }

  async listModerationActions(reportId: string): Promise<ModerationAction[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM moderation_actions WHERE report_id = $1 ORDER BY created_at',
      [reportId],
    );
    return rows.map((r) => ({
      id: r.id,
      reportId: r.report_id,
      action: r.action,
      note: r.note ?? '',
      createdAt: iso(r.created_at),
    }));
  }

  async checkRateLimit(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    const k = hashKey(key);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM rate_limit_hits WHERE ts < now() - ($1 * interval '1 millisecond')`, [windowMs]);
      const { rows } = await client.query('SELECT count(*)::int AS n FROM rate_limit_hits WHERE key = $1', [k]);
      const n: number = rows[0].n;
      if (n >= limit) {
        await client.query('COMMIT');
        return { allowed: false, remaining: 0 };
      }
      await client.query('INSERT INTO rate_limit_hits (key) VALUES ($1)', [k]);
      await client.query('COMMIT');
      return { allowed: true, remaining: limit - n - 1 };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async wipeAll(): Promise<void> {
    await this.pool.query('TRUNCATE moderation_actions, evidence, reports, venues, rate_limit_hits');
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
