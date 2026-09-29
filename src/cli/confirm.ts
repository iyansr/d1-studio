import { styleText } from "node:util";
import { UserError } from "../errors";

/** Resolves to what the user typed, or `undefined` if they cancelled. */
export type TextPrompt = (message: string) => Promise<string | undefined>;

export interface RemoteWriteTarget {
  account: { id: string; name?: string };
  database: { id: string; name: string };
}

export const NEEDS_YES = "--write on a remote database needs --yes in non-interactive runs";

/** `a1b2…` */
export function shortId(id: string): string {
  return id.length > 4 ? `${id.slice(0, 4)}…` : id;
}

export function formatWriteWarning({ account, database }: RemoteWriteTarget): string {
  const row = (label: string, value: string) => `  ${label.padEnd(9)} ${value}`;
  const accountLabel = account.name ? `${account.name} (${shortId(account.id)})` : account.id;
  return [
    styleText(["yellow", "bold"], "⚠ Write access to REMOTE database", { stream: process.stdout }),
    row("account", accountLabel),
    row("database", `${database.name} (${shortId(database.id)})`),
  ].join("\n");
}

/**
 * T7: before listening with `--remote --write`, the user types the database
 * name (TTY) or passes `--yes` (anything else).
 */
export async function confirmRemoteWrite(
  target: RemoteWriteTarget,
  options: {
    tty: boolean;
    yes: boolean;
    prompt?: TextPrompt;
    print?: (text: string) => void;
  },
): Promise<void> {
  const print = options.print ?? console.log;
  if (!options.yes && !options.tty) throw new UserError(NEEDS_YES);
  print(formatWriteWarning(target));
  if (options.yes) return;
  const typed = await (options.prompt ?? clackText)("Type the database name to continue:");
  if (typed === undefined) throw new UserError("Cancelled.");
  if (typed.trim() !== target.database.name) {
    throw new UserError(`"${typed.trim()}" isn't "${target.database.name}". Not starting.`);
  }
}

const clackText: TextPrompt = async (message) => {
  const { isCancel, text } = await import("@clack/prompts");
  const value = await text({ message });
  return isCancel(value) ? undefined : value;
};
