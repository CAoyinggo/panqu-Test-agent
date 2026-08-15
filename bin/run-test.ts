#!/usr/bin/env node
// CLI 入口（薄封装）：解析参数 → 调核心引擎
// 使用：node bin/run-test.ts --task ../tasks/<任务名>.json [--env] [--func] [--reporter]
import { Engine } from '../src/core/engine.js';

const engine = new Engine();

engine
  .main(process.argv.slice(2))
  .then(() => process.exit(0))
  .catch((e: Error) => {
    console.error('执行出错：', e.message);
    process.exit(1);
  });
