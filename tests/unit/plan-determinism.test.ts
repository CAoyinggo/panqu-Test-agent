// execute_test_plan 路径「零 LLM 调用」静态守卫：
//   通过 import 依赖图 + 去除注释后的代码 token 双重断言，证明
//   plan-contract / plan-executor / run-plan 三条确定性路径不引入、
//   不读取、不调用任何模型 / LLM / traecli / Mock。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

const FILES = [
  'src/agents/plan/plan-contract.ts',
  'src/agents/plan/plan-policy-gate.ts',
  'src/agents/orchestration/plan-executor.ts',
  'src/agents/orchestration/plan-run-service.ts',
  'bin/run-plan.ts',
];

const LLM_IMPORT_RE = /llm|openai|anthropic|deepseek|traecli|model|mock|runtime/i;
const LLM_TOKEN_RE = /LLM_PROVIDER|MockLLM|traecli|RuntimeLLM|createLLM|chat\/completions|openai|anthropic|deepseek/i;

function readCode(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/** 去除 // 行注释与块注释，保留可执行代码。 */
function stripComments(source: string): string {
  const noBlock = source.replace(/\/\*[\s\S]*?\*\//g, '');
  return noBlock
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

function importSpecifiers(source: string): string[] {
  const out: string[] = [];
  const re = /import\s+(?:[\s\S]*?\sfrom\s+)?['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) out.push(m[1]);
  return out;
}

describe('execute_test_plan 路径零 LLM 调用（静态守卫）', () => {
  it('三条确定性路径的文件均存在', () => {
    for (const f of FILES) {
      expect(fs.existsSync(path.join(ROOT, f))).toBe(true);
    }
  });

  it('不 import 任何 LLM / 模型 / traecli / mock 模块', () => {
    for (const f of FILES) {
      const specs = importSpecifiers(readCode(f));
      for (const s of specs) {
        expect(s, `${f} 引入了疑似模型模块: ${s}`).not.toMatch(LLM_IMPORT_RE);
      }
    }
  });

  it('去除注释后的可执行代码不包含任何模型调用 token', () => {
    for (const f of FILES) {
      const code = stripComments(readCode(f));
      expect(code, `${f} 可执行代码包含疑似模型调用 token`).not.toMatch(LLM_TOKEN_RE);
    }
  });
});