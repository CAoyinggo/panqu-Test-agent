#!/usr/bin/env node
/**
 * panqu-test-agent 单命令入口。
 * 仅负责转交到 src/cli.mjs 的 main()。所有逻辑在 src/ 下。
 */
import { main } from '../src/cli.mjs';

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    // fail closed：任何未捕获异常都以非零退出，绝不把失败描述成成功。
    process.stderr.write(`[panqu-test-agent] fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exitCode = 2;
  },
);
