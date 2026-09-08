import { readFile, mkdir, writeFile, realpath, lstat } from 'node:fs/promises';
import path from 'node:path';

export const DEVTEST_BUNDLED_SKILLS = ['devtest', 'panqu-canvas', 'panqu-video-models', 'panqu-image-models'] as const;

/** Validate each ancestor before creating children, so a symlink cannot redirect writes. */
async function localDirectory(root: string, relative: string): Promise<string> {
  let current = root;
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    try { await mkdir(current); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(current) !== current) {
      throw new Error('DEVTEST_TRAE_PATH: Skill and config directories must be local');
    }
  }
  return current;
}

/** Add our entry without overwriting unrelated MCP servers or a team's edited Skill. */
export async function initializeDevTestTrae(root: string): Promise<string[]> {
  const projectRoot = await realpath(root);
  const folder = await localDirectory(projectRoot, '.trae');
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
  for (const name of DEVTEST_BUNDLED_SKILLS) {
    const resources = name === 'devtest' ? ['SKILL.md'] : ['SKILL.md', 'references/code-map.md', 'references/input-constraints.md'];
    for (const resource of resources) {
      const relative = `.trae/skills/${name}/${resource}`;
      await localDirectory(projectRoot, path.posix.dirname(relative));
      const target = path.join(projectRoot, relative);
      try {
        const info = await lstat(target);
        if (!info.isFile() || info.isSymbolicLink()) throw new Error('DEVTEST_TRAE_PATH: Skill resources must be regular files');
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const content = await readFile(new URL(`./assets/${name}/${resource}`, import.meta.url), 'utf8');
      try {
        await writeFile(target, content, { flag: 'wx' });
        changed.push(relative);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
  }
  return changed;
}
