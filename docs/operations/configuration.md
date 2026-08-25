# AI Test Platform · 配置手册（Phase 26.1）

本手册列出平台运行期全部环境变量、默认值与安全约束。敏感项一律部署环境注入。

## 1. 环境变量总表

| 变量 | 默认 | 说明 |
|---|---|---|
| `PLATFORM_MODE` | development | 安全运行模式 development/test/staging/production（安全策略主配置） |
| `PLATFORM_ENVIRONMENT` | development | 部署/版本环境标签；未配置 PLATFORM_MODE 时兼容作为运行模式 |
| `PLATFORM_STORAGE` | sqlite | 存储后端 memory/json/sqlite/postgres |
| `PLATFORM_DATA_DIR` | `<TESTFLOW_OUTPUT_DIR>/platform` | sqlite/json 持久化目录 |
| `JWT_SECRET` | （缺省开发默认值） | JWT 签名密钥；production 缺失 preflight BLOCK |
| `PLATFORM_SEED_USERS` | true | 是否种子默认用户（production 关闭） |
| `PLATFORM_ALLOW_DEFAULT_CREDENTIALS` | true | 是否允许默认口令（production 必须 false） |
| `DATABASE_URL` | 无（必须显式配置） | PostgreSQL 连接串；无默认账号/数据库，production/staging 禁止 postgres/postgres |
| `REDIS_URL` | 无（production/staging 必须显式配置） | 分布式 API 限流；生产类模式禁止回退进程内 Map，启动前执行 connect + PING |
| `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL` | （空→Mock） | 真实 LLM；未配置走 Mock/离线确定性回退 |
| `LLM_FALLBACK_MODEL` | （空） | 主模型不可用时的降级模型 |
| `FEISHU_WEBHOOK_URL` / `FEISHU_MENTION` | （空） | 飞书通知（真实发送需 webhook） |
| `PLATFORM_VERSION` / `PLATFORM_COMMIT` / `PLATFORM_BUILD_TIME` | 4.2.0 / 空 / 空 | 版本溯源（CI 注入） |
| `PLATFORM_API_HOST` / `PLATFORM_API_PORT` | 127.0.0.1 / 8787 | API 监听地址/端口 |
| `PLATFORM_WEB_DIR` | web/dist | Dashboard 静态目录 |

## 2. 环境优先级

环境变量 > `environments.json` > 代码默认值。

## 3. 安全约束（按环境）

| 环境 | 默认口令 | Autonomous 绕过 Approval | Dangerous 工具 |
|---|---|---|---|
| development/test | 允许 | 禁止 | 允许（测试） |
| staging | 允许（试运行） | 禁止 | DENY |
| production | 禁止 | 禁止 | DENY |

## 4. 模板文件

- `config/env/.env.example`：全量模板
- `config/env/.env.staging.example`：staging 候选
- `config/env/.env.production.example`：production（仅占位符）

真实 `.env` 已被 `.gitignore` 排除；模板文件允许入库（不含真实值）。

## 5. 常见配置场景

- 本机离线试运行：`PLATFORM_STORAGE=sqlite` + 不配 LLM（Mock 确定性回退）
- staging 真实试运行：`PLATFORM_MODE=staging` + `REDIS_URL` + 配 LLM_API_KEY/BASE_URL/MODEL + 飞书 webhook
- 切换 PostgreSQL：`PLATFORM_STORAGE=postgres` + 显式 `DATABASE_URL`。启动严格执行 Connection → Migration → Ready；任一步失败都会退出且不会监听端口

开发/测试模式使用有界 TTL/LRU 限流器（默认最多 10,000 个 IP、闲置 5 分钟淘汰）；production/staging 使用 Redis Lua 原子计数，使多实例共享配额。Redis 不可用时生产类服务启动失败，不会降级为单机 Map。
