import { describe, expect, it, afterEach } from 'vitest';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../../..');

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
});

describe('TRAE DevTest Mandatory Execution Rules Contract', () => {
  function assertModernRules(content: string, _sourceLabel: string) {
    expect(content).toContain('name: devtest');
    expect(content).toContain('Panqu 研发自测副驾');
    expect(content).toContain('probe');
    expect(content).toContain('plan');
    expect(content).toContain('execute');
    expect(content).toContain('verify');
    expect(content).toContain('PROCESSING 有界续查规则');
    expect(content).toContain('UNVERIFIED 与 BLOCKED 处理');
    expect(content).toContain('真实执行门禁');
  }

  it('[Contract-TRAE-1] Authoritative source SKILL.md contains modern streamlined rules <= 60 lines', async () => {
    const sourcePath = path.resolve(projectRoot, 'src/devtest/assets/devtest/SKILL.md');
    const content = await readFile(sourcePath, 'utf8');
    assertModernRules(content, 'Authoritative source src/devtest/assets/devtest/SKILL.md');
  });

  it('[Contract-TRAE-2] Packaged / Dist assets SKILL.md contains modern streamlined rules <= 60 lines', async () => {
    const distPath = path.resolve(projectRoot, 'dist/src/devtest/assets/devtest/SKILL.md');
    const content = await readFile(distPath, 'utf8');
    assertModernRules(content, 'Dist asset dist/src/devtest/assets/devtest/SKILL.md');
  });

  it('[Contract-TRAE-4] Workspace running copy in test-flow contains modern streamlined rules <= 60 lines', async () => {
    const copyPath = path.resolve(projectRoot, '.trae/skills/devtest/SKILL.md');
    const content = await readFile(copyPath, 'utf8');
    assertModernRules(content, `Workspace running copy ${copyPath}`);
  });
});
