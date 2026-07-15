/*
 * Test-only Kysely plugin: SQLite has no `ON DUPLICATE KEY UPDATE` (that's
 * MySQL syntax, which `.onDuplicateKeyUpdate()` compiles to unconditionally).
 * The two call sites in sync/engine.ts (`rule_bindings` push upsert,
 * `ignored_orphans` insert) are rewritten here to SQLite's
 * `ON CONFLICT(cols) DO UPDATE SET ...`, using a hardcoded table -> conflict
 * target map. Never ship this in production code — it only exists so the
 * hermetic in-memory SQLite harness can run the real engine code unmodified.
 */

import {
  ColumnNode,
  InsertQueryNode,
  OnConflictNode,
  OperationNodeTransformer,
  type KyselyPlugin,
  type PluginTransformQueryArgs,
  type PluginTransformResultArgs,
  type RootOperationNode,
  type UnknownRow,
} from 'kysely';

/**
 * `better-sqlite3` has no concept of a DATETIME/TIMESTAMP type — every
 * timestamp column comes back as the raw TEXT it was stored as. mysql2 (the
 * production driver, configured with `timezone: 'Z'`) parses those columns
 * into real `Date` objects instead, and the app code (engine.ts, ledger.ts)
 * relies on that: some call sites do `new Date(row.updated_at)` (works on a
 * string too) but others call `.toISOString()` directly on the column,
 * assuming a Date. Almost every timestamp column in schema.ts is named
 * `*_at` (the one exception is `restream_failover_state.drain_until`) and
 * always written as an explicit UTC 'YYYY-MM-DD HH:MM:SS' literal (see
 * engine.ts's own now()), so it's safe to convert any such column back to a
 * UTC Date here, mirroring what mysql2 gives the app in production. Without
 * reviving `drain_until` too, it stays a naive string and a raw
 * `Date.parse()` on it (failoverSync.ts#asMs, which defensively accepts a
 * string precisely because production drivers might not always hand back a
 * Date) is interpreted in the machine's LOCAL timezone instead of UTC —
 * inert in production (mysql2 is configured with `timezone: 'Z'` and always
 * hands back a real Date) but silently wrong here on any non-UTC machine.
 */
const SQLITE_DATETIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const EXTRA_TIMESTAMP_COLUMNS = new Set(['drain_until']);

function reviveTimestamps(row: UnknownRow): UnknownRow {
  const out: UnknownRow = { ...row };
  for (const [key, value] of Object.entries(out)) {
    const isTimestampColumn = key.endsWith('_at') || EXTRA_TIMESTAMP_COLUMNS.has(key);
    if (isTimestampColumn && typeof value === 'string' && SQLITE_DATETIME.test(value)) {
      out[key] = new Date(`${value.replace(' ', 'T')}Z`);
    }
  }
  return out;
}

/** table name -> columns that form its natural upsert key */
const CONFLICT_TARGETS: Record<string, string[]> = {
  rule_bindings: ['master_rule_id', 'instance_id'],
  ignored_orphans: ['instance_id', 'tvh_uuid'],
  restream_node_state: ['instance_id', 'node_id'],
  restream_switcher_state: ['switcher_id'],
  restream_node_probes: ['instance_id', 'node_id'],
  restream_node_settings: ['instance_id', 'node_id'],
  restream_failover_state: ['channel_id'],
};

class OnDuplicateKeyToOnConflictTransformer extends OperationNodeTransformer {
  protected override transformInsertQuery(node: InsertQueryNode): InsertQueryNode {
    const transformed = super.transformInsertQuery(node);
    if (!transformed.onDuplicateKey) return transformed;

    const tableName = transformed.into?.table.identifier.name;
    const targetCols = tableName ? CONFLICT_TARGETS[tableName] : undefined;
    if (!targetCols) {
      throw new Error(
        `sqliteCompatPlugin: no conflict-target mapping for table "${tableName ?? '?'}" — add one to CONFLICT_TARGETS`,
      );
    }

    const onConflict = OnConflictNode.cloneWith(OnConflictNode.create(), {
      columns: targetCols.map((c) => ColumnNode.create(c)),
      updates: transformed.onDuplicateKey.updates,
    });

    return {
      ...transformed,
      onDuplicateKey: undefined,
      onConflict,
    };
  }
}

/** Rewrites `.onDuplicateKeyUpdate()` queries into SQLite-compatible `ON CONFLICT` upserts. */
export class SqliteCompatPlugin implements KyselyPlugin {
  private readonly transformer = new OnDuplicateKeyToOnConflictTransformer();

  transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
    return this.transformer.transformNode(args.node);
  }

  async transformResult(args: PluginTransformResultArgs) {
    return { ...args.result, rows: args.result.rows.map(reviveTimestamps) };
  }
}
