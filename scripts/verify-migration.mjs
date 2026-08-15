// 迁移一致性校验：对比 JSON 用例（tasks/）与 TS 用例（dist/src/cases/tasks/）
// 供 `npm run test:all` 使用：离线校验结构一致，不提交任务、不消耗积分。
// 用法：node scripts/verify-migration.mjs [--dir dist/src/cases/tasks]
import { loadCases } from '../dist/src/cases/loader.js';

/** 规范化：递归排序对象键后 JSON 化，忽略键顺序差异 */
function normalize(v) {
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = normalize(v[k]);
    return out;
  }
  return v;
}

function toKey(v) {
  return JSON.stringify(normalize(v));
}

/** 递归寻找第一个差异路径（返回如 "extra.cueword" 或 "model_id"），无差异返回 null */
function findDiff(a, b, p = '') {
  if (toKey(a) === toKey(b)) return null;
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const d = findDiff(a[i], b[i], `${p}[${i}]`);
      if (d) return d;
    }
    return `${p}（数组值差异）`;
  }
  if (a && typeof a === 'object' && b && typeof b === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      const d = findDiff(a[k], b[k], p ? `${p}.${k}` : k);
      if (d) return d;
    }
    return `${p || '(对象)'}（差异未定位）`;
  }
  return `${p || '(值)'}：JSON=${JSON.stringify(a)} / TS=${JSON.stringify(b)}`;
}

async function main() {
  const tsDir = process.argv[2] || 'dist/src/cases/tasks';

  const jsons = await loadCases('tasks'); // 旧：JSON
  const tss = await loadCases(tsDir); // 新：TS（编译产物）
  console.log(`[verify] JSON 用例 ${jsons.length} 个 / TS 用例 ${tss.length} 个`);

  const tsByName = new Map(tss.map((c) => [c.name, c]));
  let pass = 0;
  let fail = 0;

  for (const j of jsons) {
    const t = tsByName.get(j.name);
    if (!t) {
      console.log(`❌ ${j.name}：TS 侧未找到`);
      fail++;
      continue;
    }
    const same = toKey(j.def) === toKey(t.def);
    if (same) {
      console.log(`✅ ${j.name}：字段完全一致`);
      pass++;
    } else {
      const d = findDiff(j.def, t.def);
      console.log(`❌ ${j.name}：字段不一致（首个差异：${d}）`);
      fail++;
    }
  }

  console.log(`\n[verify] 结果：一致 ${pass} 个，不一致 ${fail} 个`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('[verify] 异常：', e);
  process.exit(1);
});
