const numberFormat = new Intl.NumberFormat();

export function formatCount(n: number): string {
  return numberFormat.format(n);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["second", 60],
  ["minute", 60],
  ["hour", 24],
  ["day", 7],
  ["week", 4.35],
  ["month", 12],
  ["year", Number.POSITIVE_INFINITY],
];

/** "3 minutes ago". */
export function formatRelative(date: Date, now = Date.now()): string {
  let value = (date.getTime() - now) / 1000;
  for (const [unit, size] of STEPS) {
    if (Math.abs(value) < size) return relative.format(Math.round(value), unit);
    value /= size;
  }
  return date.toLocaleString();
}

export function formatDuration(ms: number): string {
  return ms < 1
    ? `${ms.toFixed(2)} ms`
    : ms < 1000
      ? `${ms.toFixed(1)} ms`
      : `${(ms / 1000).toFixed(2)} s`;
}
