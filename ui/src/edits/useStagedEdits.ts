import { useSyncExternalStore } from "react";
import { StagedEdits, type StagedSnapshot } from "./staged-edits";

/** One store per table, so staged changes outlive the grid (a tab switch, a refetch). */
const stores = new Map<string, StagedEdits>();
const listeners = new Set<() => void>();

export function stagedFor(table: string): StagedEdits {
  let store = stores.get(table);
  if (!store) {
    store = new StagedEdits();
    store.subscribe(() => {
      for (const listener of listeners) listener();
    });
    stores.set(table, store);
  }
  return store;
}

/** Changes staged across all tables. */
export function stagedTotal(): number {
  let total = 0;
  for (const store of stores.values()) total += store.count;
  return total;
}

function subscribeAll(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The table's store and its current snapshot. */
export function useStagedEdits(table: string): { store: StagedEdits; staged: StagedSnapshot } {
  const store = stagedFor(table);
  const staged = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return { store, staged };
}

/** The number of staged changes in `table`, for guards that live above the grid. */
export function useStagedCount(table: string | null): number {
  return useSyncExternalStore(subscribeAll, () => (table ? stagedFor(table).count : 0));
}

/** The number of staged changes anywhere; drives the beforeunload guard. */
export function useStagedTotal(): number {
  return useSyncExternalStore(subscribeAll, stagedTotal);
}
