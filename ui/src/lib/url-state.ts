import { useCallback, useMemo, useSyncExternalStore } from 'react';

import {
  FILTER_OPS,
  type Filter,
  type FilterOp,
  formatSort,
  PAGE_SIZES,
  type PageSize,
  parseSort,
  type Sort,
  UNARY_OPS,
} from '@shared/rows';

export const TABS = ['data', 'structure', 'sql'] as const;
export type Tab = (typeof TABS)[number];

/**
 * Studio state kept in the URL, so reload, back and shared links work. The
 * table is `table=`, not `t=`: `?t=` is the session token (01-T8).
 */
export interface UrlState {
  table: string | null;
  tab: Tab;
  /** 0-based page. */
  page: number;
  size: PageSize;
  sort: Sort[];
  filters: Filter[];
}

export const DEFAULT_STATE: UrlState = {
  table: null,
  tab: 'data',
  page: 0,
  size: 50,
  sort: [],
  filters: [],
};

export function parseUrlState(search: string): UrlState {
  const q = new URLSearchParams(search);
  const tab = q.get('tab');
  const page = Number(q.get('p') ?? 0);
  const size = Number(q.get('size') ?? 50);
  return {
    table: q.get('table') || null,
    tab: TABS.includes(tab as Tab) ? (tab as Tab) : 'data',
    page: Number.isSafeInteger(page) && page >= 0 ? page : 0,
    size: PAGE_SIZES.includes(size as PageSize) ? (size as PageSize) : 50,
    sort: q.getAll('sort').flatMap((s) => parseSort(s) ?? []),
    filters: parseFilters(q.get('f')),
  };
}

function parseFilters(json: string | null): Filter[] {
  if (!json) return [];
  try {
    const value: unknown = JSON.parse(json);
    if (!Array.isArray(value)) return [];
    return value.filter(
      (f): f is Filter =>
        typeof f?.col === 'string' &&
        FILTER_OPS.includes(f.op as FilterOp) &&
        (UNARY_OPS.has(f.op) || (f.value !== undefined && f.value !== null)),
    );
  } catch {
    return [];
  }
}

/** Only non-default values are written, so URLs stay short. */
export function formatUrlState(state: UrlState): string {
  const q = new URLSearchParams();
  if (state.table) q.set('table', state.table);
  if (state.tab !== 'data') q.set('tab', state.tab);
  if (state.page > 0) q.set('p', String(state.page));
  if (state.size !== 50) q.set('size', String(state.size));
  for (const s of state.sort) q.append('sort', formatSort(s));
  if (state.filters.length > 0) q.set('f', JSON.stringify(state.filters));
  const search = q.toString();
  return search ? `?${search}` : '';
}

const listeners = new Set<() => void>();
function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener('popstate', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('popstate', listener);
  };
}
const getSearch = () => window.location.search;

export type SetUrlState = (patch: Partial<UrlState>, options?: { replace?: boolean }) => void;

/**
 * The URL state and a setter. Changing the table or tab pushes a history
 * entry, so Back returns to it; paging, sorting and filtering replace it.
 */
export function useUrlState(): [UrlState, SetUrlState] {
  const search = useSyncExternalStore(subscribe, getSearch);
  const state = useMemo(() => parseUrlState(search), [search]);
  const update = useCallback<SetUrlState>((patch, options) => {
    const current = parseUrlState(window.location.search);
    const next = { ...current, ...patch };
    const url = `${window.location.pathname}${formatUrlState(next)}`;
    if (url === `${window.location.pathname}${window.location.search}`) return;
    const push = !options?.replace && (next.table !== current.table || next.tab !== current.tab);
    if (push) window.history.pushState(null, '', url);
    else window.history.replaceState(null, '', url);
    for (const listener of listeners) listener();
  }, []);
  return [state, update];
}
