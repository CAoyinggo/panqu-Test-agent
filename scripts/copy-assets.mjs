// 构建辅助：把非 TS 资源（environments.json）复制到 dist，保证 dist 可独立运行
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pairs = [
  ['src/config/environments.json', 'dist/src/config/environments.json'],
];

for (const [srcRel, dstRel] of pairs) {
  const src = path.join(root, srcRel);
  const dst = path.join(root, dstRel);
  if (!fs.existsSync(src)) {
    console.warn(`[copy-assets] 跳过（源不存在）：${srcRel}`);
    continue;
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  console.log(`[copy-assets] ${srcRel} -> ${dstRel}`);
}
