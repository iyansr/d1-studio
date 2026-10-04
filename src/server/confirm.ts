import type { Confirm, ConfirmLevel, PreviewStatement, WritePreview } from '../shared/edits';
import { classify } from '../sql/classify';
import { apiError } from './errors';

/** Where a write comes from. The SQL editor's user wrote the SQL themselves. */
export type WriteSource = 'grid' | 'editor';

export interface WriteRequest {
  mode: 'local' | 'remote';
  readOnly: boolean;
  dangerous: boolean;
  source: WriteSource;
  /** What the request carried, if anything. */
  confirm?: Confirm;
  databaseName: string;
}

/**
 * What a write needs before it runs (D12). Local mode never asks. Remote
 * write mode asks for a click on grid edits, and for the typed database
 * name on destructive SQL from anywhere. The server enforces this, not only
 * the UI.
 */
export function confirmationLevel(
  req: Pick<WriteRequest, 'mode' | 'dangerous' | 'source'>,
): ConfirmLevel {
  if (req.mode === 'local') return 'none';
  if (req.dangerous) return 'type-name';
  return req.source === 'grid' ? 'click' : 'none';
}

export type WriteDecision =
  | { action: 'run' }
  /** Read-only mode: 403. */
  | { action: 'refuse' }
  /** Nothing (or too little) was confirmed: 409, with the level needed. */
  | { action: 'confirm'; level: 'click' | 'type-name' }
  /** The typed name is wrong: 403. */
  | { action: 'mismatch' };

export function decideWrite(req: WriteRequest): WriteDecision {
  if (req.readOnly) return { action: 'refuse' };
  const level = confirmationLevel(req);
  if (level === 'none') return { action: 'run' };
  if (req.confirm === undefined) return { action: 'confirm', level };
  if (level === 'type-name' && req.confirm !== req.databaseName) return { action: 'mismatch' };
  return { action: 'run' };
}

/** The statements as they will run, each classified, and what confirming them takes. */
export function writePreview(
  statements: { sql: string; params?: PreviewStatement['params'] }[],
  req: Pick<WriteRequest, 'mode' | 'source'>,
): WritePreview {
  const listed = statements.map((s) => ({
    sql: s.sql,
    params: s.params ?? [],
    dangerous: classify(s.sql).dangerous,
  }));
  const dangerous = listed.some((s) => s.dangerous);
  return {
    statements: listed,
    dangerous,
    requiresConfirm: confirmationLevel({ ...req, dangerous }),
  };
}

/** Turns anything but "run" into the response the client needs to go on. */
export function enforceWrite(
  decision: WriteDecision,
  preview: WritePreview,
  databaseName: string,
): void {
  switch (decision.action) {
    case 'run':
      return;
    case 'refuse':
      throw apiError(
        403,
        'Read-only mode: writes are not allowed. Restart with --write to enable edits.',
      );
    case 'confirm':
      throw apiError(
        409,
        decision.level === 'type-name'
          ? `This is destructive. Confirm by typing the database name (${databaseName}).`
          : 'This change needs confirmation before it runs.',
        { code: 'confirmation_required', preview },
      );
    case 'mismatch':
      throw apiError(
        403,
        `Type the database name (${databaseName}) exactly to run destructive statements.`,
        { code: 'confirmation_mismatch', preview },
      );
  }
}

/** The `confirm` field of a request body: `true`, or the database name typed. */
export function parseConfirm(value: unknown): Confirm | undefined {
  if (value === undefined || value === true) return value;
  if (typeof value === 'string' && value !== '') return value;
  throw apiError(400, '"confirm" must be true or the database name.');
}
