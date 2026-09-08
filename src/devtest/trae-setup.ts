import { readFile, mkdir, writeFile, realpath, lstat } from 'node:fs/promises';
import path from 'node:path';

/** Add our entry without overwriting unrelated MCP servers or a team's edited Skill. */
export async function initializeDevTestTrae(root: string): Promise<string[]> {
  const projectRoot = await realpath(root);
  const folder = path.join(projectRoot, '.trae');
  await mkdir(folder, { recursive: true });
  if (await realpath(folder) !== folder) throw new Error('DEVTEST_TRAE_PATH: .trae must be a local project directory');
  const configFile = path.join(folder, 'mcp.json');
  try {
    if ((await lstat(configFile)).isSymbolicLink()) throw new Error('DEVTEST_TRAE_PATH: mcp.json must not be a symlink');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  let config: { mcpServers?: Record<string, unknown>; [key: string]: unknown } = {};
  try { config = JSON.parse(await readFile(configFile, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (!config || typeof config !== 'object' || Array.isArray(config)
    || config.mcpServers && (typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers))) throw new Error('DEVTEST_TRAE_CONFIG_INVALID');
  const entry = { command: 'node', args: [
    '${workspaceFolder}/node_modules/test-flow/dist/bin/devtest-mcp.js', '--project-root', '${workspaceFolder}',
  ] };
  const existing = config.mcpServers?.devtest;
  if (existing && JSON.stringify(existing) !== JSON.stringify(entry)) throw new Error('DEVTEST_TRAE_CONFIG_CONFLICT: existing devtest MCP entry differs');
  const changed: string[] = [];
  if (!existing) {
    config.mcpServers = { ...config.mcpServers, devtest: entry };
    await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`);
    changed.push('.trae/mcp.json');
  }
  const skillDir = path.join(folder, 'skills', 'devtest');
  await mkdir(skillDir, { recursive: true });
  if (await realpath(skillDir) !== skillDir) throw new Error('DEVTEST_TRAE_PATH: Skill directory must be local');
  const skill = await readFile(new URL('./assets/devtest/SKILL.md', import.meta.url), 'utf8');
  try {
    await writeFile(path.join(skillDir, 'SKILL.md'), skill, { flag: 'wx' });
    changed.push('.trae/skills/devtest/SKILL.md');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  return changed;
}
