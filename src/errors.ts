/**
 * An expected failure caused by the user's input or environment. The CLI
 * prints only the message (no stack) and exits 1.
 */
export class UserError extends Error {
  override name = 'UserError';
}
