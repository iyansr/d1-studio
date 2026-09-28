import { styleText } from "node:util";

export interface BannerInfo {
  version: string;
  mode: "local" | "remote";
  readOnly: boolean;
  /** `database` line, already formatted. */
  database: string;
  /** `config` (or `file`) line. */
  source?: { label: "config" | "file"; value: string };
  url: string;
  /** The requested port, when a fallback port was used. */
  busyPort?: number;
  notes?: string[];
}

const color = (format: Parameters<typeof styleText>[0], text: string) =>
  styleText(format, text, { stream: process.stdout });

export function formatBanner(info: BannerInfo): string {
  const row = (label: string, value: string) => `  ${color("dim", label.padEnd(9))} ${value}`;
  const access = info.readOnly ? "read-only" : "read-write";
  const lines = [
    `${color("bold", "d1-studio")} v${info.version}`,
    row("mode", `${info.mode} (${access})`),
    row("database", info.database),
  ];
  if (info.source) lines.push(row(info.source.label, info.source.value));
  lines.push(row("studio", color("cyan", info.url)));
  const notes = [...(info.notes ?? [])];
  if (info.busyPort !== undefined) notes.unshift(`port ${info.busyPort} was in use`);
  for (const note of notes) lines.push(row("note", note));
  return lines.join("\n");
}

/** `app-db (binding DB, id 3f2a…)` */
export function formatDatabase(name: string, binding?: string, id?: string): string {
  const parts: string[] = [];
  if (binding) parts.push(`binding ${binding}`);
  if (id) parts.push(`id ${id.length > 4 ? `${id.slice(0, 4)}…` : id}`);
  return parts.length ? `${name} (${parts.join(", ")})` : name;
}

/** A yellow box for a non-loopback `--host`. */
export function formatHostWarning(host: string, readOnly: boolean): string {
  const lines = [
    `Warning: listening on ${host}, not only this machine.`,
    `Anyone who can reach this address and has the link can ${readOnly ? "read" : "read and write"} the database.`,
  ];
  const width = Math.max(...lines.map((l) => l.length));
  const box = [
    `┌${"─".repeat(width + 2)}┐`,
    ...lines.map((l) => `│ ${l.padEnd(width)} │`),
    `└${"─".repeat(width + 2)}┘`,
  ];
  return color("yellow", box.join("\n"));
}
