declare module "node:sqlite" {
  export interface StatementResultingChanges {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  }
  export class StatementSync {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): StatementResultingChanges;
    setAllowBareNamedParameters(enabled: boolean): void;
    finalize(): void;
  }
  export interface DatabaseSyncOptions {
    open?: boolean;
    enableForeignKeyConstraints?: boolean;
    enableDoubleQuotedStringLiterals?: boolean;
    allowExtension?: boolean;
  }
  export class DatabaseSync {
    constructor(location: string, options?: DatabaseSyncOptions);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    pragma(key: string, options?: { simple?: boolean }): unknown;
    close(): void;
  }
}
