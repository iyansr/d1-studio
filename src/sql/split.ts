import { isKeyword, type Token, tokenize } from './tokenize';

export interface Statement {
  /** Source text without the trailing `;` or surrounding whitespace. */
  sql: string;
  start: number;
  end: number;
  /** Tokens without comments. */
  tokens: Token[];
}

/**
 * Splits SQL on top-level `;`. A `CREATE TRIGGER … BEGIN … END` body keeps its
 * inner `;`. Statements made only of comments are dropped.
 */
export function splitStatements(sql: string): Statement[] {
  const statements: Statement[] = [];
  let current: Token[] = [];
  let inTriggerBody = false;
  let caseDepth = 0;

  const flush = () => {
    const code = current.filter((t) => t.kind !== 'comment');
    const first = current[0];
    const last = current[current.length - 1];
    if (code.length > 0 && first && last) {
      statements.push({
        sql: sql.slice(first.start, last.end),
        start: first.start,
        end: last.end,
        tokens: code,
      });
    }
    current = [];
    inTriggerBody = false;
    caseDepth = 0;
  };

  for (const token of tokenize(sql)) {
    if (token.kind === 'punct' && token.text === ';' && token.depth === 0 && !inTriggerBody) {
      flush();
      continue;
    }
    current.push(token);
    if (token.kind !== 'word') continue;
    if (!inTriggerBody) {
      if (isKeyword(token, 'BEGIN') && isCreateTrigger(current)) inTriggerBody = true;
    } else if (isKeyword(token, 'CASE')) {
      caseDepth++;
    } else if (isKeyword(token, 'END')) {
      if (caseDepth > 0) caseDepth--;
      else inTriggerBody = false;
    }
  }
  flush();
  return statements;
}

/** `CREATE [TEMP|TEMPORARY] TRIGGER …` */
function isCreateTrigger(tokens: Token[]): boolean {
  const words = tokens.filter((t) => t.kind !== 'comment').slice(0, 3);
  if (!isKeyword(words[0], 'CREATE')) return false;
  const second = isKeyword(words[1], 'TEMP') || isKeyword(words[1], 'TEMPORARY') ? 2 : 1;
  return isKeyword(words[second], 'TRIGGER');
}
