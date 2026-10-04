import { inspect } from 'node:util';

const REDACTED = '[redacted]';

/**
 * A credential that prints as `[redacted]` in logs, JSON, string templates
 * and `util.inspect`. Only the D1 client calls `reveal()`.
 */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [Symbol.toPrimitive](): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return REDACTED;
  }
}
