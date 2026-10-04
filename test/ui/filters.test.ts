import { describe, expect, test } from 'vitest';

import { draftOf, parseValue } from '../../ui/src/lib/filters';

const draft = (op: string, value: string, col = 'c') => ({ key: 0, col, op: op as 'eq', value });

describe('filter values', () => {
  test.each<[string, string, string, ReturnType<typeof parseValue>]>([
    ['INTEGER', 'eq', '42', { value: 42 }],
    ['INTEGER', 'ge', ' -1.5 ', { value: -1.5 }],
    ['INTEGER', 'eq', '9007199254740993', { value: { $int: '9007199254740993' } }],
    ['REAL', 'lt', 'abc', { error: 'c is numeric; enter a number.' }],
    ['INTEGER', 'like', '4%', { value: '4%' }],
    ['TEXT', 'eq', '42', { value: '42' }],
    ['', 'eq', 'x', { value: 'x' }],
    ['TEXT', 'eq', ' ', { error: 'Enter a value.' }],
    ['TEXT', 'null', '', {}],
    ['INTEGER', 'nnull', 'junk', {}],
  ])('%s %s %j', (type, op, value, expected) => {
    expect(parseValue(draft(op, value), type)).toEqual(expected);
  });

  test('drafts from applied filters', () => {
    expect(draftOf({ col: 'a', op: 'eq', value: { $int: '9007199254740993' } }).value).toBe(
      '9007199254740993',
    );
    expect(draftOf({ col: 'a', op: 'null' }).value).toBe('');
    expect(draftOf({ col: 'a', op: 'gt', value: 3 }).value).toBe('3');
  });
});
