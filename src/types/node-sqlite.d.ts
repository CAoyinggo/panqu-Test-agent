// node:sqlite 最小类型声明（Phase 25.1）
// 项目使用 Node v26 运行时内置 node:sqlite（DatabaseSync 同步 API），
// 但 @types/node 20.x 未包含该模块类型。此声明提供本项目用到的子集，
// 供 tsc 类型检查使用（运行时由 Node 提供）。
// 若未来 @types/node 升级至 22+，此文件可删除并改用官方类型。

declare module 'node:sqlite' {
  /** SQL 语句执行结果 */
  interface RunResult {
    /** 受影响行数（UPDATE/DELETE/INSERT） */
    changes: number;
    /** 最后插入行的 rowid */
    lastInsertRowid: number | bigint;
  }

  /** 预编译语句（同步执行） */
  interface StatementSync {
    /** 执行写语句（INSERT/UPDATE/DELETE） */
    run(...params: Array<unknown>): RunResult;
    /** 读取单行（无匹配返回 undefined） */
    get(...params: Array<unknown>): unknown;
    /** 读取全部行 */
    all(...params: Array<unknown>): unknown[];
    /** 释放语句 */
    close(): void;
  }

  /** 同步 SQLite 数据库连接（Node 内置 node:sqlite） */
  class DatabaseSync {
    constructor(path: string);
    /** 执行一条或多条 SQL（无结果返回） */
    exec(sql: string): void;
    /** 预编译 SQL 语句 */
    prepare(sql: string): StatementSync;
    /** 关闭连接 */
    close(): void;
  }

  export { DatabaseSync };
}
