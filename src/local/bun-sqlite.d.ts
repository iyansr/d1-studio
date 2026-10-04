// The subset of bun:sqlite we use; avoids pulling in bun-types globals.
declare module 'bun:sqlite' {
  export class Database {
    constructor(
      filename: string,
      options?: {
        readonly?: boolean;
        readwrite?: boolean;
        create?: boolean;
        safeIntegers?: boolean;
      },
    );
    prepare(sql: string): Statement;
    run(sql: string): unknown;
    close(): void;
  }
  export class Statement {
    readonly columnNames: string[];
    values(...params: unknown[]): unknown[][];
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    finalize(): void;
  }
}
