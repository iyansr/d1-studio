import { classify, isReadKind } from '../sql/classify';
import type { Statement } from '../sql/split';
import { apiError } from './errors';

/**
 * Read-only mode (T5): every statement must classify as a read. The
 * classifier allow-lists, so anything unrecognised (`ATTACH`, `VACUUM`, a
 * look-alike keyword) is refused. Remote has no read-only connection behind
 * this, so it is the only guard there.
 */
export function assertReadOnly(statements: Statement[]): void {
  for (const stmt of statements) {
    const { kind, keyword } = classify(stmt.tokens);
    if (!isReadKind(kind)) {
      throw apiError(
        403,
        `Read-only mode: ${keyword || 'this statement'} is not allowed. Restart with --write to enable edits.`,
      );
    }
  }
}

const OP_KEYWORDS = { insert: 'INSERT', update: 'UPDATE', delete: 'DELETE' } as const;

/** Grid edits are always writes, so a read-only server refuses them outright. */
export function assertEditable(
  readOnly: boolean,
  ops: readonly { op: keyof typeof OP_KEYWORDS }[],
): void {
  const first = ops[0];
  if (readOnly && first) {
    throw apiError(
      403,
      `Read-only mode: ${OP_KEYWORDS[first.op]} is not allowed. Restart with --write to enable edits.`,
    );
  }
}
