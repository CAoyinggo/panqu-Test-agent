# Phase 26.1 Production Deployment — 阶段报告

> 阶段：26.1 / 8
> 范围：可重复的 staging 部署流程、版本溯源、环境配置文件模板、部署验收链
> 状态：✅ 完成
> 证据级别：**Offline（本机 staging 候选环境，未连接真实外部服务）**

---

## 一、目标

建立一个可重复的 staging 部署流程，检查 Node / Build / Web / Database / Storage / JWT / LLM / Notification / Scheduler / Worker / Telemetry / Backup / Migration 全链路，并提供版本溯源（API + CLI + Dashboard）与三套环境配置模板。

## 二、产出清单

| 类别 | 文件 | 说明 |
|---|---|---|
| 版本溯源 | `src/platform/version.ts`（新建） | `PLATFORM_VERSION=4.2.0`、`buildVersionInfo()`（环境变量优先、代码常量回落）、`isVersionCompatible()`（v4.2→v4.1 回滚兼容判断） |
| 版本 API | `src/platform/api/server.ts`（修改） | 公开端点 `GET /api/version` 与 `GET /version`，无需认证，返回 version/commit/buildTime/environment |
| 版本 CLI | `bin/platform-cli.ts`（修改） | 新增 `agent platform version` 子命令 |
| 版本导出 | `src/platform/index.ts`（修改） | `export * from './version.js'` |
| Dashboard | `web/src/pages/Settings.tsx`（修改） | 设置页新增「版本信息（构建溯源）」卡片 |
| 配置模板 | `.env.example`（修改） | 追加平台运行时配置段（PLATFORM_*/JWT_SECRET/LLM_*/FEISHU_*/DATABASE_URL） |
| 配置模板 | `.env.staging.example`（新建） | staging 占位模板（敏感项全空） |
| 配置模板 | `.env.production.example`（新建） | production 占位模板（`PLATFORM_STORAGE=postgres`、禁用默认口令） |
| 忽略规则 | `.gitignore`（修改） | 白名单放行 `!.env.staging.example`、`!.env.production.example` |
| 验收命令 | `package.json`（修改） | 新增 12 个命令（platform:version/preflight/health/smoke + platform:production:*/recovery:test/release-gate:test/backup-restore:test/notification:test/pilot） |
| 运维文档 | `docs/operations/deployment.md`（新建） | 环境分层、部署步骤、版本注入、部署后验收、禁止事项 |
| 运维文档 | `docs/operations/configuration.md`（新建） | 环境变量总表、优先级、安全约束矩阵 |
| E2E 测试 | `tests/e2e/production-deployment.test.ts`（新建，5 例） | 版本溯源 / 回滚兼容 / 公开版本端点 / .env 模板安全 / 部署验收链 |

## 三、验证结果（Offline）

| 验证 | 命令 | 结果 |
|---|---|---|
| 编译 | `npm run build` | ✅ PASS |
| 版本 CLI | `node dist/bin/platform-cli.js platform version` | ✅ `{"version":"4.2.0","commit":"","buildTime":"","environment":"development"}` |
| Preflight | `platform:preflight` | ✅ PASS 5 / WARN 1（迁移未应用提示，属离线环境正常）/ BLOCK 0 |
| Health | `platform:health` | ✅ ok=true，8 项 checks 全 ok |
| Smoke | `platform:smoke`（E2E 内验证） | ✅ COMPLETED |
| E2E | `npx vitest run tests/e2e/production-deployment.test.ts` | ✅ 5 / 5 PASS（307ms） |

E2E 覆盖的 5 个断言点：

1. **版本溯源**：`buildVersionInfo()` 环境变量覆盖 + 代码常量回落，四个字段齐全。
2. **回滚兼容**：`isVersionCompatible('4.2.0','4.1.0')=true`；`('4.2.0','5.0.0')=false`；`('4.2.0','4.0.0')=false`（主版本相同、次版本差 ≤1 才兼容，供 26.5/收尾 v4.2→v4.1 回滚演练使用）。
3. **公开版本端点**：`GET /api/version` 无 Token 返回 200 + 四字段（CI/运维无需凭证即可确认运行版本）。
4. **.env 模板安全**：三个模板文件存在，且 `JWT_SECRET / DATABASE_URL / LLM_API_KEY / FEISHU_WEBHOOK_URL` 全部为空；`.gitignore` 白名单只放行 example 模板，排除真实 `.env`。
5. **部署验收链**：`sqlite(staging)` 装配下 preflight 无 BLOCK、smoke 全 PASS、health 8 项 checks 全 ok。

## 四、证据分类

| 级别 | 结论 | 说明 |
|---|---|---|
| Mock | 不适用 | 本阶段无 Mock 断言 |
| Offline | ✅ 全 PASS | build / version / preflight / health / smoke / E2E 均在本机 staging 候选环境完成 |
| Staging Real | 待 26.2-26.8 | 后续阶段在 staging 数据目录上执行真实 Run / 演练 |
| Production | 未执行 | 本阶段不触碰生产环境（遵循禁止自动对生产执行危险操作） |

## 五、缺口与风险

1. `platform:pilot` 指向 `dist/bin/run-pilot.js`（尚未创建）→ 26.8 创建。
2. `platform:recovery:test / release-gate:test / backup-restore:test / notification:test` 目标测试文件尚未创建 → 26.4-26.7 创建。
3. 本阶段 Health 显示的 runs=24 / audit=42 等为历史 SQLite 数据目录残留（开发期），非本阶段新产生；staging 独立数据目录在 26.2 建立。
4. 真实 LLM / 飞书 Webhook 未配置（无真实凭证）→ 按「真实数据原则」在后续阶段以 `value=null / tracked=false` 处理，不虚构。

## 六、下一阶段

进入 **26.2 Real Project Onboarding**：创建 WAN3 项目（test/staging 环境），导入 ≥50 个真实 TestCase（10 P0/P1、10 边界、10 异常、10 历史问题、10 AI 生成），优先复用 `src/cases/wan3/` 现有资产。
