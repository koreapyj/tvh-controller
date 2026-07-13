/*
 * tvh-controller - Centralized tvheadend controller
 * Copyright (C) 2026 Yoonji Park
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import { sql, type ExpressionBuilder } from 'kysely';
import type { EventLogEntry } from '@tvhc/shared';
import type { Db } from '../db/db.js';
import type { Database } from '../db/schema.js';
import type { EventBus } from './events.js';

export interface EventLogFilters {
  service?: string[];
  source?: string[];
  type?: 'normal' | 'warning';
  sort?: 'time' | 'service' | 'source' | 'type';
  dir?: 'asc' | 'desc';
  offset?: number;
  limit?: number;
}

/** filter -> sort column allowlist; never interpolate the raw query param */
const SORT_COLUMNS = {
  time: 'created_at',
  service: 'service',
  source: 'source',
  type: 'type',
} as const;

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const RETENTION_INTERVAL_MS = 60 * 60 * 1000;

function now(): string {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

/** 'YYYY-MM-DD HH:MM:SS' (UTC, no offset) -> ISO string, matching mysql2/sqliteCompatPlugin Date revival */
function toIso(sqlTimestamp: string): string {
  return new Date(`${sqlTimestamp.replace(' ', 'T')}Z`).toISOString();
}

function whereClauses(eb: ExpressionBuilder<Database, 'event_log'>, f: EventLogFilters) {
  const clauses = [];
  if (f.service?.length) clauses.push(eb('service', 'in', f.service));
  if (f.source?.length) clauses.push(eb('source', 'in', f.source));
  if (f.type) clauses.push(eb('type', '=', f.type));
  return clauses;
}

/**
 * Persisted event log: failovers, node outages, drift, failed pushes etc,
 * instrumented at their transition points elsewhere. `log()` is fire-and-forget
 * (callers never await it) so a slow/broken database can't block the caller's
 * own state transition.
 */
export class EventLog {
  private retentionTimer: NodeJS.Timeout | null = null;
  /**
   * Serializes inserts so id order == emission order even when callers fire
   * log() synchronously without awaiting — the unfiltered ORDER BY id fast
   * path and the id tiebreaker (see list()) both rely on that. A transient
   * insert failure drops that one entry by design (no retry queue) — the log
   * must never block or stall callers.
   */
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly db: Db | null,
    private readonly bus: EventBus,
  ) {}

  log(entry: { type: 'normal' | 'warning'; service: string; source: string; message: string }): void {
    if (!this.db) return;
    this.chain = this.chain
      .then(() => this.insert(entry))
      .catch((err) => console.error('event-log: insert failed:', err));
  }

  private async insert(entry: {
    type: 'normal' | 'warning';
    service: string;
    source: string;
    message: string;
  }): Promise<void> {
    if (!this.db) return;
    const created = now();
    const result = await this.db
      .insertInto('event_log')
      .values({ ...entry, created_at: created })
      .executeTakeFirstOrThrow();
    // Kysely's insertId is a bigint — a raw bigint in the SSE payload makes
    // JSON.stringify throw inside routes/events.ts#send(), killing the
    // connection, so it must be converted before publishing.
    const id = Number(result.insertId);
    this.bus.publish({
      type: 'event-log',
      data: { id, ...entry, createdAt: toIso(created) },
    });
  }

  async list(f: EventLogFilters): Promise<{ items: EventLogEntry[]; total: number }> {
    if (!this.db) return { items: [], total: 0 };
    const col = SORT_COLUMNS[f.sort ?? 'time'];
    const dir = f.dir ?? 'desc';
    const offset = Math.max(0, f.offset ?? 0);
    const limit = Math.min(MAX_LIMIT, Math.max(1, f.limit ?? DEFAULT_LIMIT));
    const hasFilter = Boolean(f.service?.length || f.source?.length || f.type);

    let q = this.db
      .selectFrom('event_log')
      .selectAll()
      .where((eb) => eb.and(whereClauses(eb, f)));
    if (col === 'created_at' && !hasFilter) {
      // id is monotonic insert order and created_at is stamped at insert, so
      // (created_at, id) ordering ≡ id ordering. The unfiltered default view
      // must sort by id alone: MySQL's optimizer refuses idx_event_log_created_at
      // for a whole-table ORDER BY ... LIMIT (verified: full scan + filesort of
      // every row on each page load) but walks PRIMARY backwards for free.
      q = q.orderBy('id', dir);
    } else {
      // filtered/other sorts ride the composite (col, created_at[, id])
      // indexes — putting id directly after col forced a filesort; the
      // composite can stream this order fully when created_at sits between
      // col and id. Guarded against col === 'created_at' to avoid a
      // duplicate orderBy level (semantics are identical either way: ties
      // resolve by id).
      q = q.orderBy(col, dir);
      if (col !== 'created_at') q = q.orderBy('created_at', dir);
      q = q.orderBy('id', dir);
    }
    const rows = await q.offset(offset).limit(limit).execute();

    const totalRow = await this.db
      .selectFrom('event_log')
      .select((eb) => eb.fn.countAll<number>().as('total'))
      .where((eb) => eb.and(whereClauses(eb, f)))
      .executeTakeFirst();

    return {
      items: rows.map((r) => ({
        id: r.id,
        type: r.type as 'normal' | 'warning',
        service: r.service,
        source: r.source,
        message: r.message,
        createdAt: r.created_at.toISOString(),
      })),
      total: Number(totalRow?.total ?? 0),
    };
  }

  async facets(): Promise<{ services: string[]; sources: string[] }> {
    if (!this.db) return { services: [], sources: [] };
    const services = await this.db
      .selectFrom('event_log')
      .select('service')
      .distinct()
      .orderBy('service')
      .execute();
    const sources = await this.db
      .selectFrom('event_log')
      .select('source')
      .distinct()
      .orderBy('source')
      .execute();
    return { services: services.map((r) => r.service), sources: sources.map((r) => r.source) };
  }

  private async prune(days: number): Promise<void> {
    if (!this.db) return;
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 19)
      .replace('T', ' ');
    // the column's SelectType is Date (mysql2/sqliteCompatPlugin both revive
    // *_at columns), so a plain string operand doesn't type-check here — the
    // sql<Date> tag only annotates the RawBuilder's phantom type; the bound
    // parameter is still the plain 'YYYY-MM-DD HH:MM:SS' string, same as every
    // other *_at write in this codebase (see uploads/ledger.ts's now()).
    await this.db
      .deleteFrom('event_log')
      .where('created_at', '<', sql<Date>`${cutoff}`)
      .execute();
  }

  /** idempotent: a second call is a no-op while a timer is already running */
  startRetention(days: number): void {
    if (!this.db || this.retentionTimer) return;
    const run = (): void => {
      void this.prune(days).catch((err) => console.error('event-log: retention prune failed:', err));
    };
    run();
    this.retentionTimer = setInterval(run, RETENTION_INTERVAL_MS);
    this.retentionTimer.unref();
  }

  stopRetention(): void {
    if (this.retentionTimer) clearInterval(this.retentionTimer);
    this.retentionTimer = null;
  }
}
