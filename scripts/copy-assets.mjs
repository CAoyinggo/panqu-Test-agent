// 构建辅助：复制非 TS 配置和完整 Skill 包，保证 dist 可独立运行。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
fs.cpSync(path.join(root, 'src/devtest/assets'), path.join(root, 'dist/src/devtest/assets'), { recursive: true });
console.log('[copy-assets] DevTest assets copied');
