# AI Test Platform · 部署手册（Phase 26.1）

本文档描述从源码到 staging 候选环境的可重复部署流程。阶段目标：把 Phase 25 平台部署到一个独立生产候选环境（staging），并验证「部署 → 版本溯源 → 健康 → 冒烟」全链路。

## 1. 环境分层

| 环境 | 说明 | 安全默认 |
|---|---|---|
| development | 本地开发 | 宽松 |
| test | 内部测试 | 宽松 |
| staging | 生产候选（本手册目标） | Dangerous=DENY / Risky=APPROVAL |
| production | 真实生产 | 最严（默认口令禁止） |

## 2. 前置检查（部署前必须全 PASS）

```bash
npm run build            # 编译 + 复制静态资产
npm run build:web        # 构建 Web Dashboard（web/dist）
npm run platform:preflight   # Node/构建/存储/迁移/密钥/敏感信息
npm run platform:health      # 平台健康检查（含遥测/审计/激活连通性）
npm run platform:smoke       # 真实运营闭环冒烟（独立数据目录）
```

`preflight` 任一 BLOCK 即阻断；`health` 必须 `ok=true`；`smoke` 必须 `ok=true`。

## 3. 版本溯源（26.1）

- `GET /api/version`（公开端点，无需认证）返回：

```json
{ "version": "4.2.0", "commit": "<git sha>", "buildTime": "<ISO>", "environment": "staging" }
```

- CLI：`npm run platform:version`
- Dashboard：`设置 → 版本信息` 卡片展示 Version / Environment / Commit / Build Time
- 构建/部署侧注入 `PLATFORM_VERSION / PLATFORM_COMMIT / PLATFORM_BUILD_TIME / PLATFORM_ENVIRONMENT`；未注入时回落到代码常量 `4.2.0`。

## 4. 配置注入

复制对应模板并填写（敏感项由部署环境注入，禁止入库）：

```bash
cp config/env/.env.staging.example .env
```

关键项见 `docs/operations/configuration.md`。staging 推荐：`PLATFORM_STORAGE=sqlite`（或 `postgres`）、`PLATFORM_ENVIRONMENT=staging`、`JWT_SECRET` 必填。

## 5. 启动

```bash
npm run build
npm run build:web
node dist/bin/platform-cli.js serve --host 0.0.0.0 --port 8787 --web web/dist
```

`serve` 命令自动挂载 Web Dashboard 静态托管，并启动 1s 派发循环（真实 Worker 执行）。

## 6. 部署后验收

```bash
curl -s http://<host>:8787/api/version          # 版本溯源
curl -s -H "Authorization: Bearer $TOKEN" http://<host>:8787/api/health
node dist/bin/platform-cli.js migrate check     # 迁移状态
node dist/bin/platform-cli.js backup save /srv/panqu/backups/init.json   # 初始备份
```

## 7. 禁止事项

- 禁止第一步直接连接真实生产业务（先 staging）。
- 禁止把 `JWT_SECRET / DATABASE_URL / LLM_API_KEY / Webhook` 提交进 Git。
- 禁止在 production 开启默认口令 / 自动种子用户 / Autonomous 绕过 Approval。
