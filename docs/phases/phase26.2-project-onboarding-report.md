# Phase 26.2 Real Project Onboarding — 阶段报告

> 阶段：26.2 / 8
> 范围：WAN3 真实项目（test/staging 环境）建立 + 50 个真实 TestCase 导入（复用现有资产）
> 状态：✅ 完成
> 证据级别：**Offline（E2E）+ Staging Real（独立 staging 数据目录真实落库）**

---

## 一、目标

建立 WAN3 项目的 `Project → Business → Feature → Environment` 模型，并向平台导入 ≥50 个真实 TestCase（10 P0/P1、10 边界、10 异常、10 历史问题、10 AI 生成场景），**优先复用现有 Test Asset Repository，禁止重新生成已有 Case**。

## 二、扫描结论（复用点与缺口）

| 项 | 结论 |
|---|---|
| 现有资产 | `src/cases/wan3/` 已有 9 个真实执行 Case（wensheng/tusheng/quanneng/shouwei/idempotent/int-02/03/04/05）→ **全部复用** |
| 平台缺口 | `GET /api/test-assets` 此前返回空 `{ source: 'platform-repo-not-connected' }`，平台无 TestAsset 持久化 → 新建平台 Test Assets 模块 |
| 复用点 | `src/test-assets/asset-schema.ts` 的 TestAsset 类型与 `normalizeCreateAssetInput` 校验 → 复用为唯一校验入口 |

## 三、产出清单

| 文件 | 说明 |
|---|---|
| `src/platform/test-assets/wan3-catalog.ts`（新建） | 50 个真实 TestCase 目录（5 类各 10 个）；`WAN3_CATEGORY_LABEL`/`wan3CatalogStats` |
| `src/platform/test-assets/platform-test-assets.ts`（新建） | `PlatformTestAssets` 服务：list / stats / importCatalog（幂等）/ importMany |
| `src/platform/service/factory.ts`（修改） | 装配 `test-assets` Repository（同存储后端，纳入迁移/备份/恢复），bundle 暴露 `testAssets` |
| `src/platform/service/platform-service.ts`（修改） | deps 增加 `testAssets`；方法 `listTestAssets()` / `testAssetStats()`；health 新增 `test-assets` 检查 |
| `src/platform/ops/migrations.ts`（修改） | `ALL_COLLECTIONS` 增加 `test-assets`（第 16 集合，备份/恢复覆盖） |
| `src/platform/api/server.ts`（修改） | `GET /api/test-assets` 返回真实数据（`source: 'platform-test-assets'`）；新增 `GET /api/test-assets/stats` |
| `bin/platform-cli.ts`（修改） | 新增 `platform assets <list|stats|import>` 子命令 |
| `package.json`（修改） | 新增 `platform:onboarding`（build + CLI import + E2E） |
| `tests/e2e/project-onboarding.test.ts`（新建，8 例） | 项目/环境、目录完整性、复用真实性、幂等导入、API 真实数据、备份集合覆盖 |

## 四、50 个真实 TestCase 构成

| 分类 | 数量 | 覆盖内容 | 复用现有 |
|---|---|---|---|
| P0 | 5 | 文生视频/图生视频/全能参考/首尾帧 4 个核心链路 + 12s 长视频 | 4（wensheng/tusheng/quanneng/shouwei） |
| P1 | 5 | 幂等扣费 + 视频编辑/模型兼容/任务列表/大文件上传 | 1（idempotent） |
| 边界 | 10 | 缺失提示词/超长提示词/单字符/长度上界/时长/分辨率/宽高比/参考图数/参考视频时长/首尾帧相同 | 2（int-02/int-05） |
| 异常 | 10 | 非法 task_type/空 model_id/模型不存在/素材格式/损坏视频/音频格式/余额不足/快照差值/提交超时/服务端 5xx | 2（int-03/int-04） |
| 历史问题 | 10 | 竖屏横放/参考视频裁切/首尾帧生硬/重复扣费/任务类型错乱/RUNNING 卡死/素材不存在/URL 过期/音画不同步/弱网双击 | 0 |
| AI 生成 | 10 | 多人一致性/风格迁移/文字 Logo/镜头运动/多参考图/口型对齐/长镜头/夜景/中文语义/内容安全 | 0 |
| **合计** | **50** | — | **9 复用 + 41 新增** |

## 五、验证结果

### 5.1 Staging Real（独立 staging 数据目录，SQLite 真实落库）

```bash
TESTFLOW_OUTPUT_DIR=<staging-dir> node dist/bin/platform-cli.js platform assets import
# → { ok:true, imported:50, skipped:0, before:0, after:50,
#     byCategory:{ p0:5, p1:5, boundary:10, exception:10, history:10, ai-generated:10 } }
# 再次 import（幂等）：imported:0, skipped:50
```

| 项 | 值 |
|---|---|
| 落库资产总数 | 50 |
| 复用现有 `src/cases/wan3/` | 9（reuse） |
| 新增 onboarding | 41 |
| P0/P1 | 10 |
| 幂等 | 重复导入 imported=0 / skipped=50 ✅ |

### 5.2 Offline（E2E，8 例全 PASS，46ms）

1. WAN3 项目存在，含 `test` 与 `staging` 环境 ✅
2. 目录总数 50、5 类分布正确、无重复 id ✅
3. 9 个复用条目的 `src/cases/wan3/` 文件真实存在 ✅
4. 导入 50 → 重复导入 0（幂等）✅
5. stats 真实：byCategory 与 bySource（reuse=9 / onboarding=41）✅
6. `GET /api/test-assets` 返回 50 条真实资产，source=`platform-test-assets` ✅
7. `GET /api/test-assets/stats` 返回真实统计 ✅
8. `test-assets` 纳入 `ALL_COLLECTIONS`，health 报告「50 个 Test Case」✅

## 六、证据分类

| 级别 | 结论 | 说明 |
|---|---|---|
| Mock | 不适用 | 无 Mock 断言 |
| Offline | ✅ 全 PASS | E2E 8 例 + 回归 21 例（含 26.1） |
| Staging Real | ✅ 50 资产真实落库 | 独立 staging SQLite 数据目录，CLI import 后 count=50 |
| Production | 未执行 | 本阶段不触碰生产环境 |

## 七、缺口与风险

1. 平台 TestCase 的「执行」发生在 26.3（真实 Run 消费 `src/cases/wan3/` 执行资产）；test-assets 作为平台资产管理侧清单，二者正交。
2. WAN3 项目的 Business→Feature 层级：平台现有模型为 `Project → businesses → environments`（无独立 feature 实体），feature 作为 TestAsset 字段承载（如 `wan3/text-to-video`），后续如需完整 feature 树可扩展，但当前不重复造模块。

## 八、下一阶段

进入 **26.3 Real Test Run**：在 staging 真实执行 ≥10 个 Run（Smoke/Sanity/Regression/Autonomous），自然产生 PASS/REVIEW/BLOCK 三类 Release Decision，每 Run 记录完整链路。
