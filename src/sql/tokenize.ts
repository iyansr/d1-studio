export type TokenKind = 'word' | 'string' | 'ident' | 'number' | 'param' | 'comment' | 'punct';

export interface Token {
  kind: TokenKind;
  text: string;
  start: number;
  end: number;
  /** Parenthesis depth. `(` carries the depth outside it, as does its `)`. */
  depth: number;
}

const MULTI_PUNCT = ['->>', '||', '<=', '>=', '<>', '!=', '==', '<<', '>>', '->'];

const isDigit = (c: string) => c >= '0' && c <= '9';
const isWordStart = (c: string) =>
  (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c.charCodeAt(0) >= 0x80;
const isWordChar = (c: string) => isWordStart(c) || isDigit(c) || c === '$';
const isSpace = (c: string) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';

/**
 * Splits SQL into tokens, dropping whitespace. Unterminated strings, quoted
 * identifiers and block comments run to the end of the input.
 */
export function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let depth = 0;
  let i = 0;
  const n = sql.length;

  const push = (kind: TokenKind, start: number, end: number, tokenDepth = depth) => {
    tokens.push({ kind, text: sql.slice(start, end), start, end, depth: tokenDepth });
  };
  /** Index after the closing `close`, where a doubled `close` is an escape. */
  const quoted = (from: number, close: string, doubling: boolean): number => {
    let j = from + 1;
    while (j < n) {
      if (sql[j] === close) {
        if (doubling && sql[j + 1] === close) {
          j += 2;
          continue;
        }
        return j + 1;
      }
      j++;
    }
    return n;
  };

  while (i < n) {
    const c = sql[i] as string;
    const next = sql[i + 1] ?? '';

    if (isSpace(c)) {
      i++;
    } else if (c === '-' && next === '-') {
      const nl = sql.indexOf('\n', i);
      const end = nl === -1 ? n : nl;
      push('comment', i, end);
      i = end;
    } else if (c === '/' && next === '*') {
      const close = sql.indexOf('*/', i + 2);
      const end = close === -1 ? n : close + 2;
      push('comment', i, end);
      i = end;
    } else if (c === "'") {
      const end = quoted(i, "'", true);
      push('string', i, end);
      i = end;
    } else if ((c === 'x' || c === 'X') && next === "'") {
      const end = quoted(i + 1, "'", true);
      push('string', i, end);
      i = end;
    } else if (c === '"' || c === '`') {
      const end = quoted(i, c, true);
      push('ident', i, end);
      i = end;
    } else if (c === '[') {
      const end = quoted(i, ']', false);
      push('ident', i, end);
      i = end;
    } else if (isDigit(c) || (c === '.' && isDigit(next))) {
      let j = i;
      if (c === '0' && (next === 'x' || next === 'X')) {
        j += 2;
        while (j < n && /[0-9a-fA-F_]/.test(sql[j] as string)) j++;
      } else {
        while (j < n && (isDigit(sql[j] as string) || sql[j] === '_')) j++;
        if (sql[j] === '.') {
          j++;
          while (j < n && (isDigit(sql[j] as string) || sql[j] === '_')) j++;
        }
        if (sql[j] === 'e' || sql[j] === 'E') {
          let k = j + 1;
          if (sql[k] === '+' || sql[k] === '-') k++;
          if (isDigit(sql[k] ?? '')) {
            j = k;
            while (j < n && isDigit(sql[j] as string)) j++;
          }
        }
      }
      push('number', i, j);
      i = j;
    } else if (c === '?') {
      let j = i + 1;
      while (j < n && isDigit(sql[j] as string)) j++;
      push('param', i, j);
      i = j;
    } else if ((c === ':' || c === '@' || c === '$') && isWordChar(next)) {
      let j = i + 1;
      while (j < n && isWordChar(sql[j] as string)) j++;
      push('param', i, j);
      i = j;
    } else if (isWordStart(c)) {
      let j = i + 1;
      while (j < n && isWordChar(sql[j] as string)) j++;
      push('word', i, j);
      i = j;
    } else if (c === '(') {
      push('punct', i, i + 1);
      depth++;
      i++;
    } else if (c === ')') {
      depth = Math.max(0, depth - 1);
      push('punct', i, i + 1);
      i++;
    } else {
      const multi = MULTI_PUNCT.find((p) => sql.startsWith(p, i));
      const end = i + (multi?.length ?? 1);
      push('punct', i, end);
      i = end;
    }
  }
  return tokens;
}

/** True for a `word` token matching `keyword` case-insensitively. */
export function isKeyword(token: Token | undefined, keyword: string): boolean {
  return token?.kind === 'word' && token.text.toUpperCase() === keyword;
}
