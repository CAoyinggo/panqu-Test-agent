# Test Asset Versioning（测试资产版本化）

> 版本：v4.14.0（Phase 39.4）｜ 模块：`src/platform/workflow/asset-versioning.ts`

## 定位

TestCase / Suite / Plan 等测试资产必须支持版本，这样任何时候都能回答：

> 这次 Run 究竟执行的是哪个版本的 Case？

每次变更产生一个不可变版本记录（**快照 + 变更原因**），Run 创建时把各资产当前版本写入 `run.assetVersion`，实现执行溯源。

```ts
interface AssetVersion {
  id: string;
  assetType: 'test-case' | 'suite' | 'plan' | 'template';
  assetId: string;
  version: number;               // 自动递增：v1 → v2 → v3 …
  changeReason?: string;         // 为什么改
  snapshot: unknown;             // 该版本的完整资产快照
  createdBy: string;
  createdAt: string;
}
```

## 能力

| 操作 | Service 方法 | HTTP |
| --- | --- | --- |
| 记录版本 | `recordAssetVersion(input, role)` | `POST /assets/:id/version` |
| 版本历史 | `assetVersions(id)` | `GET /assets/:id/versions` |
| 对比 | `assetCompare(id, from, to)` | `GET /assets/:id/compare?from=1&to=2` |
| 最新版本 | `latestVersion(id)` | —（服务内部 / 报告使用） |
| 回滚 | `rollbackSnapshot(id, version, by, role)` | —（服务内部） |

## Compare 语义

字段级差异三类：

- `changed`：两端都存在但值不同（如 `title`、`steps`）。
- `added`：仅新版本存在。
- `removed`：仅旧版本存在。

## 版本与 Run 固定

- `Run.assetVersion: Record<assetId, version>`：Run 创建时固化各资产版本。
- 报告（run-report）透出 `assetVersion`，Run Again / Template 复用同样固定版本，保证可复现。

## 权限

记录版本需 `ASSET_WRITE`；历史 / 对比读取默认可用（视图内 Project Scope 过滤）。

## CLI / Web

CLI：`asset version` 走 `POST /assets/:id/version`；Web：Run Detail 展示 `Asset 版本`，S4 E2E 验证 `TestCase v1 → v2 → Compare → Run 固定 v2`。
