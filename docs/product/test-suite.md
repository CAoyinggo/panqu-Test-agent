# Test Suite（测试集合）

> 版本：v4.14.0（Phase 39.1）｜ 模块：`src/platform/workflow/test-suite.ts`

## 定位

Suite 是 **TestCase 的引用集合**（不复制任何 TestCase 数据）。它是 QA 组织"这批用例要一起回归"的最小编排单元，也是 Test Plan 的输入。

```ts
interface TestSuite {
  id: string;
  projectId: string;
  name: string;
  description?: string;
  caseIds: string[];          // 引用真实 TestCase（来自测试资产库）
  tags?: string[];
  status: 'ACTIVE' | 'ARCHIVED';
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}
```

## 能力

| 操作 | Service 方法 | HTTP |
| --- | --- | --- |
| 创建 | `createSuite(input, role)` | `POST /test-suites` |
| 列表 | `listSuites(filter?, scopes?)` | `GET /test-suites` |
| 详情 | `getSuite(id)` | `GET /test-suites/:id` |
| 修改 | `updateSuite(id, patch, role)` | `PATCH /test-suites/:id` |
| 添加 Case | `addSuiteCases(id, caseIds, role)` | `POST /test-suites/:id/cases` |
| 移除 Case | `removeSuiteCases(id, caseIds, role)` | `DELETE /test-suites/:id/cases` |
| 归档 | `archiveSuite(id, actor, role)` | `POST /test-suites/:id/archive` |
| 恢复 | `restoreSuite(id, actor, role)` | `POST /test-suites/:id/restore` |
| 复制 | `copySuite(id, by, role)` | `POST /test-suites/:id/copy` |
| 按 Tag 过滤 | `listSuitesByTag(tags, scopes?)` | `GET /test-suites/tags/:tag` |

## 关键语义

- **引用不复制**：Suite 只保存 `caseIds`，TestCase 增删不影响既有 Suite；`resolveCaseIds` 会剔除已不存在的引用（`missingCases` 供 UI 提示）。
- **幂等加/删**：`addCases` / `removeCases` 内部去重，重复添加同一 Case 不产生重复项。
- **归档隔离**：归档后 Suite 不再出现在默认列表（ACTIVE 过滤），但数据保留、可恢复。
- **跨项目隔离**：带 `scopes` 时按项目过滤；写操作需 `ASSET_WRITE` 权限（VIEWER 拒绝 → 403）。

## 权限

所有写操作经 `PlatformService.assertPermission(role, 'ASSET_WRITE')`；读取默认不设限（视图内再按 Project Scope 过滤）。

## CLI

```bash
agent suite list [--tag regression]
agent suite create --name "WAN3 1080p 回归" --project wan3 --cases wan3-1080p-10s,wan3-1080p-5s --tags p0,smoke
agent suite archive <id> | restore <id> | copy <id>
```
