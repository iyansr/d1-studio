import type { CellValue, EditOp, RowKey } from '@shared/edits';
import type { Cell } from '@shared/values';

/** A row of the page: a stable id (its key, not its position) and how the server finds it. */
export interface RowRef {
  id: string;
  key: RowKey;
}

/** Inserted rows have no key yet; their id starts with this. */
const INSERT_PREFIX = 'n:';

export const isInsertId = (id: string): boolean => id.startsWith(INSERT_PREFIX);

export interface StagedUpdate {
  readonly key: RowKey;
  readonly set: Readonly<Record<string, CellValue>>;
}

export interface StagedInsert {
  readonly tempId: string;
  /** Columns left out take their DEFAULT. */
  readonly values: Readonly<Record<string, CellValue>>;
}

export interface StagedSnapshot {
  /** Changed cells per existing row. */
  readonly updates: ReadonlyMap<string, StagedUpdate>;
  /** New rows, pinned above the page. */
  readonly inserts: readonly StagedInsert[];
  readonly deletes: ReadonlyMap<string, RowKey>;
  /** Changed cells, plus inserted rows and deleted rows. */
  readonly count: number;
  /** The row a failed apply pointed at. */
  readonly failed: string | null;
}

const EMPTY: StagedSnapshot = {
  updates: new Map(),
  inserts: [],
  deletes: new Map(),
  count: 0,
  failed: null,
};

/** The ops to send, and the row each one came from (for pointing at a failure). */
export interface BuiltOps {
  ops: EditOp[];
  ids: string[];
}

export function sameValue(original: Cell, next: CellValue): boolean {
  if (original === null || next === null) return original === next;
  if (typeof original === 'object' || typeof next === 'object') {
    return (
      typeof original === 'object' &&
      typeof next === 'object' &&
      '$int' in original &&
      original.$int === next.$int
    );
  }
  return original === next;
}

/**
 * Edits staged for one table, applied later as one transaction (UI-5).
 * Everything is keyed by the row's key, not its index, so changes survive
 * paging and sorting. `getSnapshot` returns a new object per change, for
 * `useSyncExternalStore`.
 */
export class StagedEdits {
  private snap: StagedSnapshot = EMPTY;
  private readonly listeners = new Set<() => void>();
  private nextTemp = 1;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): StagedSnapshot => this.snap;

  get count(): number {
    return this.snap.count;
  }

  /**
   * Stages `value` for a cell. Setting it back to what the row already has
   * un-stages it. A deleted row can't be edited.
   */
  setCell(row: RowRef, column: string, value: CellValue, original: Cell): void {
    if (this.snap.deletes.has(row.id)) return;
    const current = this.snap.updates.get(row.id);
    const set = { ...current?.set };
    if (sameValue(original, value)) delete set[column];
    else set[column] = value;
    this.putUpdate(row, set);
  }

  revertCell(rowId: string, column: string): void {
    const current = this.snap.updates.get(rowId);
    if (!current || !(column in current.set)) return;
    const set = { ...current.set };
    delete set[column];
    this.putUpdate({ id: rowId, key: current.key }, set);
  }

  /** Un-stages a row's edits, its deletion, or (for an inserted row) the row itself. */
  revertRow(rowId: string): void {
    if (isInsertId(rowId)) {
      this.removeInserts([rowId]);
      return;
    }
    const updates = new Map(this.snap.updates);
    const deletes = new Map(this.snap.deletes);
    if (updates.delete(rowId) || deletes.delete(rowId)) this.commit({ updates, deletes });
  }

  /** Adds a blank row, showing DEFAULT everywhere. Returns its id. */
  addRow(): string {
    const tempId = `${INSERT_PREFIX}${this.nextTemp++}`;
    this.commit({ inserts: [{ tempId, values: {} }, ...this.snap.inserts] });
    return tempId;
  }

  /** `undefined` puts the column back to DEFAULT. */
  setInsertCell(tempId: string, column: string, value: CellValue | undefined): void {
    this.commit({
      inserts: this.snap.inserts.map((row) => {
        if (row.tempId !== tempId) return row;
        const values = { ...row.values };
        if (value === undefined) delete values[column];
        else values[column] = value;
        return { tempId, values };
      }),
    });
  }

  /** Stages deletes. Inserted rows are simply dropped, and a deleted row's edits with it. */
  deleteRows(rows: { id: string; key?: RowKey }[]): void {
    const inserted = rows.filter((r) => isInsertId(r.id)).map((r) => r.id);
    const existing = rows.filter((r): r is RowRef => !isInsertId(r.id) && r.key !== undefined);
    if (existing.length > 0) {
      const updates = new Map(this.snap.updates);
      const deletes = new Map(this.snap.deletes);
      for (const row of existing) {
        updates.delete(row.id);
        deletes.set(row.id, row.key);
      }
      this.commit({ updates, deletes });
    }
    if (inserted.length > 0) this.removeInserts(inserted);
  }

  discardAll(): void {
    this.snap = EMPTY;
    this.notify();
  }

  /** Points at the row a failed apply named; `null` clears it. */
  markFailed(id: string | null): void {
    if (this.snap.failed !== id) this.commit({ failed: id });
  }

  /** Deletes, then updates, then inserts: the order the server runs them in. */
  buildOps(): BuiltOps {
    const ops: EditOp[] = [];
    const ids: string[] = [];
    for (const [id, key] of this.snap.deletes) {
      ops.push({ op: 'delete', key });
      ids.push(id);
    }
    for (const [id, { key, set }] of this.snap.updates) {
      ops.push({ op: 'update', key, set: { ...set } });
      ids.push(id);
    }
    for (const { tempId, values } of [...this.snap.inserts].reverse()) {
      ops.push({ op: 'insert', values: { ...values } });
      ids.push(tempId);
    }
    return { ops, ids };
  }

  private putUpdate(row: RowRef, set: Record<string, CellValue>): void {
    const updates = new Map(this.snap.updates);
    if (Object.keys(set).length === 0) updates.delete(row.id);
    else updates.set(row.id, { key: row.key, set });
    this.commit({ updates });
  }

  private removeInserts(ids: string[]): void {
    this.commit({ inserts: this.snap.inserts.filter((r) => !ids.includes(r.tempId)) });
  }

  private commit(change: Partial<Omit<StagedSnapshot, 'count'>>): void {
    const next = { ...this.snap, ...change };
    let count = next.inserts.length + next.deletes.size;
    for (const { set } of next.updates.values()) count += Object.keys(set).length;
    // A failure marker is stale as soon as the staged set changes.
    const failed = change.failed !== undefined ? change.failed : null;
    this.snap = { ...next, count, failed };
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
