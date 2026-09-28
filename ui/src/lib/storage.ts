/**
 * localStorage for conveniences only (widths, editor text, toggles). It can
 * throw (private windows, blocked storage), so every access is guarded.
 */
export function readStored<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(`d1-studio:${key}`);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function writeStored(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(`d1-studio:${key}`, JSON.stringify(value));
  } catch {
    // Not critical.
  }
}
