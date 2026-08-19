# Phase 36 总结：身份解析统一 + 防伪造不可绕过（DEBT-12）

> 版本：v4.12.0 ｜ 日期：2026-08-19 ｜ 模式：持续自主开发（CONTINUOUS AUTONOMOUS DEVELOPMENT）

## 一、目标

解决 DEBT-12（P2）：`resolvePrincipal` 等身份解析逻辑历史版本残留（已并入 security 模块统一解析）。经审计确认当前代码中 `resolvePrincipal` 为唯一身份解析实现（无重复残留），但「静态身份来源」的守卫与解析仍内嵌于 `api/server.ts`（直接读取 `x-actor` / `x-role` 头），未完全收敛到 security 模块；本阶段将其真正收敛，并以结构性守护固化「生产防伪造不可绕过」。

## 二、扫描发现

| 项 | 现状 | 处置 |
|---|---|---|
| `resolvePrincipal` 唯一实现 | 仅在 `api/server.ts` 定义（:112）并调用（:568）；src 中无其它 `resolvePrincipal` / `extractPrincipal` / `resolveIdentity` 变体 | 保留唯一实现，新增唯一性守护 |
| 静态身份解析内嵌 server.ts | 直接 `req.headers['x-actor']` / `req.headers['x-role']` 读取，仅依赖 `allowHeaderIdentity` 守卫 | 收敛到 security 模块 `resolveStaticIdentity`（守卫 + 解析统一） |
| 平台层头读取分散风险 | 新 API 入口可能绕过生产关闭直接读 X-Actor/X-Role 头 | 结构性守护：平台层 X-Actor/X-Role 头读取仅存在于 security 模块 |
| `allowHeaderIdentity` 语义已测 | security.test.ts 覆盖 production 禁止 / 其余允许 | 新增集成语义守护（production 关闭 + staging 演练允许） |

## 三、实施内容

### 36.1 security 模块新增 `resolveStaticIdentity`（`src/platform/security/index.ts`）

```ts
export function resolveStaticIdentity(
  mode: PlatformMode,
  headers: { 'x-actor'?: unknown; 'x-role'?: unknown; [key: string]: unknown },
): { actor: string; role: string } | null {
  if (!allowHeaderIdentity(mode)) return null;           // production 防伪造不可绕过
  const first = (v: unknown): string | undefined =>       // 数组取首项 / 字符串化
    Array.isArray(v) ? (v.length ? String(v[0]) : undefined) : v == null ? undefined : String(v);
  return { actor: first(headers['x-actor']) || 'api', role: first(headers['x-role']) || 'VIEWER' };
}
```

守卫 + 解析收敛到 security 模块：production 返回 `null`（调用方不得回退静态身份）；其余模式解析（默认 `api` / `VIEWER`；数组头取首项；空字符串回退默认）。

### 36.2 `api/server.ts` 静态 Token 回退改调统一函数

- 删除直接头读取，改为 `const ident = resolveStaticIdentity(mode, req.headers); if (!ident) return null; return { user: undefined, actor: ident.actor, role: ident.role as Role };`
- import 移除 `allowHeaderIdentity`（不再直接使用），改导 `resolveStaticIdentity`。
- 行为等价：production 仍返回 null；development/test/staging 解析一致（含默认值）。

### 36.3 守护测试（新增 `tests/unit/identity-resolution-guard.test.ts`，8 项）

1. `resolveStaticIdentity` 功能：production 返回 null（不可回退）；
2. development/test/staging 模式解析 X-Actor/X-Role；
3. 缺省回退：无 actor 默认 `api`，无 role 默认 `VIEWER`；
4. 数组头取首项；空字符串回退默认；非字符串被字符串化；
5. **结构性守护**：`src/platform/**` 全部源文件中 `headers['x-actor']` / `headers['x-role']` / `getHeader('x-actor')` / `getHeader('x-role')` 仅存在于 security/index.ts（防新入口绕过生产关闭）；
6. **唯一实现守护**：`function resolvePrincipal(` 定义仅 1 处（`platform/api/server.ts`）；
7. 集成语义：production 下 `isProductionLike`=true 且 `allowHeaderIdentity`=false 且 `resolveStaticIdentity`=null；
8. 非生产模式允许静态身份（staging 为生产演练模式，安全约束强但仍允许 X-Header 身份）。

## 四、修改 / 新增文件

- 新增：`tests/unit/identity-resolution-guard.test.ts`（8 项）、`docs/phase36-summary.md`。
- 修改：`src/platform/security/index.ts`（新增 `resolveStaticIdentity`）、`src/platform/api/server.ts`（静态回退改调统一函数）、`package.json`（v4.12.0 + phase36:test 脚本）、`src/platform/version.ts`（4.12.0）、`package-lock.json`、`README.md`、`CHANGELOG.md`、`docs/TECH-DEBT.md`（DEBT-12 已解决 + 趋势行）。

## 五、测试与验收

| 项 | 命令 | 结果 |
|---|---|---|
| 构建 | `npm run build` | 通过 |
| 身份解析守护 + security/auth/RBAC 相关回归 | `npm run phase36:test` | 51 项通过（identity-resolution-guard 8 + security 17 + rbac 26） |
| 全量回归 | `npm test` | **1504 passed / 18 skipped**（130 个测试文件） |

## 六、性能 / 安全 / 兼容性

- **性能**：`resolveStaticIdentity` 为常数时间操作，无热路径影响；静态 Token 回退路径调用开销与原直接读头等价。
- **安全**：生产模式静态身份伪造关闭由 security 模块统一裁决（返回 null 不可绕过），且结构性守护确保平台层 X-Actor/X-Role 头读取仅存在于 security——即使未来新增 API 入口，也无法绕过守卫直接信任 X-Header。
- **兼容性**：`resolveStaticIdentity` 为新增导出（无破坏）；`server.ts` 行为等价（相关 security/rbac/auth 测试全绿）；`allowHeaderIdentity` 仍导出（security.test.ts 继续覆盖）。

## 七、遗留问题与下一阶段建议

1. **Phase 37 慢/易碎测试治理（DEBT-13，P2，当前唯一开放债）**：部分 E2E 依赖固定 ISO 时间与端口，存在时序敏感用例——已通过固定 `now()` 与随机端口缓解，本阶段评估现有 E2E 的实际 flaky 风险并进一步消除时序敏感断言。
2. 技术债清零在望：DEBT-13 解决后 TECH-DEBT 开放债务归零（12 项全部关闭）。
