# DevOps 改造验证测试报告（v2）

> **项目**：test-flow（盼趣AI 测试执行框架）
> **验证范围**：Docker 容器化 + CI/CD 流水线 + OSS 报告上传 + 配置外部化
> **提交版本**：commit `00e394c`
> **测试日期**：2026-08-17（Asia/Shanghai）
> **测试环境**：macOS, Node.js v26.3.1, npm, Docker 未安装, Python 3 + PyYAML

---

## 1. 测试计划

| 项目 | 内容 |
|------|------|
| **测试范围** | Docker 容器化（Dockerfile/.dockerignore/docker-compose.yml）；CI/CD 模板（.gitlab-ci.yml/.github/workflows/test.yml）；OSS 上传（oss-uploader.ts + --upload-reports）；配置外部化（env-loader.ts + .env.example）；回归验证（tsc/build/help/dry-run） |
| **测试策略** | 静态分析（逐文件审阅结构/路径/版本/规则冲突）+ 动态验证（编译/CLI/单元函数调用/CI 模拟）+ 安全审查（硬编码路径/secrets/gitignore）。Docker 不可用 → 容器化用例静态分析+阻塞标记 |
| **测试环境** | 本地 macOS；Node.js v26.3.1（本地）/ node:18-alpine（Dockerfile 目标）；Python 3 + PyYAML（YAML 校验）；Docker 未安装；无 yamllint/yq |
| **进度安排** | 阶段 1 环境侦察 → 阶段 2 静态分析（Dockerfile/CI/OSS/配置/全量硬编码扫描） → 阶段 3 动态验证（tsc/build/help/dry-run/OSS 配置/env-loader 单元测试/CI 模拟/YAML 校验） → 阶段 4 缺陷分级 → 阶段 5 回归分析 → 阶段 6 报告输出 |
| **风险与依赖** | Docker 不可用 → Docker 构建运行用例阻塞；无真实 OSS 环境 → 上传端到端用例阻塞；GitLab/GitHub CI 平台未接入 → CI 模板仅做静态+本地模拟验证 |
| **进入标准** | 代码已提交（commit 00e394c），文件清单完整，Node.js/npm 可用 | 
| **退出标准** | 所有可执行用例完成，缺陷已分级并输出修复建议，回归用例全部通过 |

---

## 2. 测试用例表

### 模块 A：Docker 容器化（7 条）

| 用例编号 | 所属模块 | 用例标题 | 优先级 | 前置条件 | 测试步骤 | 测试数据 | 预期结果 | 实际结果 | 是否通过 | 缺陷编号 |
|----------|----------|----------|--------|----------|----------|----------|----------|----------|----------|----------|
| TC_DOCKER_001 | Docker | 基础镜像版本兼容 import.meta.dirname | P0 | 代码使用 `import.meta.dirname` | 1. 读取 Dockerfile L2/L18 基础镜像 2. 确认 `config.ts` L11 使用 `import.meta.dirname` 3. 模拟 Node 18 行为：`path.join(undefined, 'test')` | node:18-alpine | 应使用 Node 20.11+ 基础镜像 | `import.meta.dirname` 在 Node 18 返回 `undefined`，`path.join(undefined, ...)` 抛 TypeError，容器启动崩溃 | ❌ | BUG_DOCKER_01 |
| TC_DOCKER_002 | Docker | outputDir() 路径与 Docker volume 挂载一致性 | P0 | 读取 fs-utils.ts + docker-compose.yml | 1. 读取 `fs-utils.ts` L48: `const base = '/Users/mac/agents/output/...'` 2. 读取 `docker-compose.yml` L13: `./output:/app/output` 3. 对比两个路径 | outputDir 返回 `/Users/mac/agents/output/...`，volume 挂载 `/app/output` | 路径一致，报告通过 volume 持久化 | 路径不一致，报告写入 `/Users/mac/agents/output/`（容器内不存在），volume 挂载无效 | ❌ | BUG_DOCKER_02 |
| TC_DOCKER_003 | Docker | ASSETS_ROOT 硬编码路径对容器影响 | P0 | 读取 assets.ts | 1. `grep -rn '/Users/mac' src/` 2. 发现 `assets.ts` L9: `ASSETS_ROOT = '/Users/mac/agents/Test-panqu'` 3. 检查 Dockerfile 是否挂载该目录 | ASSETS_ROOT = `/Users/mac/agents/Test-panqu` | 路径应可配置或使用容器内路径 | 路径硬编码，Docker 容器内不存在，素材上传功能会失败 | ❌ | BUG_DOCKER_03 |
| TC_DOCKER_004 | Docker | Dockerfile 多阶段构建结构正确性 | P1 | 读取 Dockerfile | 1. 检查 builder 阶段：COPY package*.json + npm ci + COPY src/bin/scripts/tsconfig + npm run build 2. 检查 runtime 阶段：npm ci --omit=dev + COPY dist/ + src/cases/ + environments.json 3. 检查 ENTRYPOINT/CMD | Dockerfile 全文 | builder 含编译全部依赖；runtime 仅生产依赖 + dist/ | builder 阶段完整（package.json, tsconfig.json, src/, bin/, scripts/），runtime 阶段 `npm ci --omit=dev` + COPY dist/ + cases + environments.json，ENTRYPOINT 正确 | ✅ | - |
| TC_DOCKER_005 | Docker | .dockerignore 排除范围完整性 | P1 | 读取 .dockerignore | 1. 检查排除：node_modules/, output/, .git/, *.log, dist/ 2. 检查 .env 排除但保留 .env.example 3. 检查是否遗漏重要排除项 | .dockerignore 内容 | 排除冗余文件，保留必要文件 | 正确排除 node_modules/output/.git/*.log/dist/.env，保留 .env.example。排除 `*.md` 和 `docs/` 合理 | ✅ | - |
| TC_DOCKER_006 | Docker | docker-compose 多环境 + 卷挂载 + 环境变量透传 | P1 | 读取 docker-compose.yml | 1. 检查 test/preonline 两个 service 2. 检查 volume 挂载 3. 检查环境变量 `${VAR:-default}` 透传 4. 检查 profiles 隔离 | docker-compose.yml | 多环境独立，挂载正确，变量透传 | 两个 service 配置正确，test 默认 + preonline 使用 profile，环境变量用 `${VAR:-}` 透传。但 volume 挂载因 BUG_DOCKER_02 无效 | ⚠️ | BUG_DOCKER_02 |
| TC_DOCKER_007 | Docker | Docker 镜像构建 + 容器运行 | P0 | Docker 已安装 | 1. `npm run docker:build` 2. `npm run docker:run -- --task src/cases --dry-run` | - | 镜像构建成功 < 200MB，容器 dry-run 输出 9 用例 | Docker 未安装（`docker not found`），检查 /Applications/Docker.app + /usr/local/bin/docker + /opt/homebrew/bin/docker 均不存在 | ⏸️ | - |

### 模块 B：CI/CD 流水线模板（9 条）

| 用例编号 | 所属模块 | 用例标题 | 优先级 | 前置条件 | 测试步骤 | 测试数据 | 预期结果 | 实际结果 | 是否通过 | 缺陷编号 |
|----------|----------|----------|--------|----------|----------|----------|----------|----------|----------|----------|
| TC_CI_001 | CI | .gitlab-ci.yml YAML 语法校验 | P0 | Python + PyYAML | `python3 -c "import yaml; yaml.safe_load(open('.gitlab-ci.yml'))"` | .gitlab-ci.yml | 解析无错误 | 解析成功，keys: stages, variables, build, test, test:wan3 | ✅ | - |
| TC_CI_002 | CI | docker-compose.yml YAML 语法校验 | P0 | Python + PyYAML | `yaml.safe_load(open('docker-compose.yml'))` | docker-compose.yml | 解析无错误 | 解析成功，keys: services | ✅ | - |
| TC_CI_003 | CI | .github/workflows/test.yml YAML 语法校验 | P0 | Python + PyYAML | `yaml.safe_load(open('.github/workflows/test.yml'))` | test.yml | 解析无错误 | 解析成功，keys: name, on, jobs | ✅ | - |
| TC_CI_004 | CI | GitLab CI stages 与 job 依赖链 | P0 | 读取 .gitlab-ci.yml | 1. 检查 stages: [build, test] 2. 检查 test job `needs: [build]` 3. 检查 build artifacts `dist/` 传递 | .gitlab-ci.yml L13-15, L44, L31-34 | build → test 依赖链正确 | stages 正确，test needs build，build artifacts dist/ expire 1 day，test artifacts output/ expire 7 days when: always | ✅ | - |
| TC_CI_005 | CI | GitLab CI test:wan3 `when: manual` 与 `rules` 冲突 | P1 | 读取 .gitlab-ci.yml L77-92 | 1. 检查 `when: manual` 位置（job 级 L92） 2. 检查 `rules` 存在（L90-91） 3. 确认 GitLab CI 规范：rules 存在时 job 级 when 被忽略 | .gitlab-ci.yml L90-92 | `when: manual` 写在 rule 内部 | `when: manual` 在 job 级别，`rules` 存在导致被忽略，job 实际自动执行（when 默认 on_success） | ❌ | BUG_CI_01 |
| TC_CI_006 | CI | GitLab CI 触发规则覆盖度 | P1 | 读取 .gitlab-ci.yml | 1. 检查 build/test rules: MR + main + web 2. 检查 test:wan3 rules: 仅 web | .gitlab-ci.yml L35-38, L69-72, L90-91 | 三种触发场景全覆盖 | build/test 覆盖 merge_request_event + main + web；test:wan3 仅 web（但因 BUG_CI_01 自动执行） | ⚠️ | BUG_CI_01 |
| TC_CI_007 | CI | GitHub Actions secrets 注入完整性 | P1 | 读取 test.yml + env-loader.ts + .env.example | 1. 提取 env-loader.ts 支持的所有变量 2. 提取 .env.example 列出的变量 3. 提取 GitHub Actions env: 段注入的 secrets 4. 对比覆盖率 | env-loader: 13 个变量；.env.example: 22 个变量；GitHub Actions env: 8 个 secrets | CI 注入覆盖所有必需变量 | 缺失 8 个变量：TESTFLOW_ACCOUNT, TESTFLOW_BASE_URL, TESTFLOW_SUBMIT_URL, TESTFLOW_STATUS_URL, TESTFLOW_DETAIL_URL, TESTFLOW_BILLING_URL, TESTFLOW_CSRF_PAGE, TESTFLOW_FEISHU_MENTION。GitLab CI 同样缺失 | ❌ | BUG_CI_02 |
| TC_CI_008 | CI | GitHub Actions 触发 + 超时 + artifacts | P2 | 读取 test.yml | 1. 检查 on: push main + pull_request + workflow_dispatch(带 inputs) 2. 检查 timeout-minutes: 10 3. 检查 upload-artifact path: output/, retention-days: 7, if: always() | test.yml 全文 | 触发/超时/artifacts 配置合理 | push main + PR + workflow_dispatch(task/func inputs)；timeout 10min；artifact path output/, retention 7 days, if: always()。全部正确 | ✅ | - |
| TC_CI_009 | CI | 本地 CI 流程模拟 | P0 | Node.js + npm | 1. `npm ci` 2. `npm run build` 3. `node dist/bin/run-test.js --task src/cases --ci --dry-run` | - | 全流程执行成功 | npm ci 成功，build 成功，dry-run 输出 9 用例（8 通过 1 预期失败） | ✅ | - |

### 模块 C：OSS 报告上传（10 条）

| 用例编号 | 所属模块 | 用例标题 | 优先级 | 前置条件 | 测试步骤 | 测试数据 | 预期结果 | 实际结果 | 是否通过 | 缺陷编号 |
|----------|----------|----------|--------|----------|----------|----------|----------|----------|----------|----------|
| TC_OSS_001 | OSS | OSS 配置缺失时安全降级 | P0 | 编译成功 | 调用 `getOssConfigFromEnv()`，无 TESTFLOW_OSS_* 环境变量 | 无 OSS 环境变量 | 返回 null，不抛异常 | 返回 null | ✅ | - |
| TC_OSS_002 | OSS | OSS 配置完整时返回正确对象 | P0 | 编译成功 | 设置全部 5 个 OSS 环境变量，调用 `getOssConfigFromEnv()` | ENDPOINT/BUCKET/AK/SK/BASE_URL | 返回包含所有字段的 OssConfig | `{endpoint, bucket, accessKeyId, accessKeySecret, baseUrl}` 全字段正确 | ✅ | - |
| TC_OSS_003 | OSS | OSS 配置部分缺失时返回 null | P1 | 编译成功 | 设置 4 个变量（缺 ACCESS_KEY_SECRET），调用 `getOssConfigFromEnv()` | 4/5 变量 | 返回 null | 返回 null | ✅ | - |
| TC_OSS_004 | OSS | --upload-reports CLI 参数解析 | P0 | 编译成功 | `parseArgs(['--task','src/cases','--upload-reports'])` | --upload-reports 标志 | args.uploadReports = true | uploadReports: true | ✅ | - |
| TC_OSS_005 | OSS | --upload-reports 与多参数组合 | P1 | 编译成功 | `parseArgs(['--task','src/cases','--ci','--upload-reports','--env','preonline'])` | 多参数 | uploadReports=true, ci=true, env=preonline | 全部正确解析 | ✅ | - |
| TC_OSS_006 | OSS | --upload-reports 在 --help 中可见 | P0 | 编译成功 | `node dist/bin/run-test.js --help \| grep upload-reports` | --help 输出 | 包含 --upload-reports 说明行 | `--upload-reports   上传报告到 OSS（需配置 TESTFLOW_OSS_* 环境变量），飞书通知附带可分享链接` | ✅ | - |
| TC_OSS_007 | OSS | withRetry 用于上传重试 + 参数正确 | P1 | 读取 oss-uploader.ts L89-99 | 检查 withRetry 调用参数 | - | retries=3, timeout=30000, retryable=true（指数退避） | `{ retries: 3, timeout: 30000, retryable: true }`，复用现有 withRetry 机制 | ✅ | - |
| TC_OSS_008 | OSS | 递归收集报告文件 + 扩展名过滤 | P1 | 读取 oss-uploader.ts L27, L124-138 | 检查 REPORT_EXTENSIONS 和 collectReportFiles 递归 | - | 递归遍历 output/<日期>/ 子目录，过滤 .html/.json/.xml | `REPORT_EXTENSIONS = ['.html', '.json', '.xml']`，`collectReportFiles` 递归 `entry.isDirectory()` | ✅ | - |
| TC_OSS_009 | OSS | URL 生成逻辑（baseUrl 优先） | P1 | 读取 oss-uploader.ts L105-107 | 检查 URL 生成分支 | 有 baseUrl vs 无 | 有: `${baseUrl}/${ossKey}`；无: `https://${bucket}.${endpoint}/${ossKey}` | 逻辑正确，baseUrl 优先 | ✅ | - |
| TC_OSS_010 | OSS | engine.ts 上传触发位置 + 飞书通知集成 | P0 | 读取 engine.ts L400-431 | 1. 检查上传在 metrics 写入后、notifier 前 2. 检查 reportUrls 传递到 notify() | engine.ts L400-430 | 上传在报告生成后执行，URL 传递给飞书 | L400 上传逻辑 → L408 uploadReports() → L410 reportUrls → L430 `notifier.notify(summary, reportUrls)` 位置正确 | ✅ | - |

### 模块 D：配置外部化（9 条）

| 用例编号 | 所属模块 | 用例标题 | 优先级 | 前置条件 | 测试步骤 | 测试数据 | 预期结果 | 实际结果 | 是否通过 | 缺陷编号 |
|----------|----------|----------|--------|----------|----------|----------|----------|----------|----------|----------|
| TC_CFG_001 | 配置 | TESTFLOW_BASE_URL 覆盖 base_url | P0 | 编译成功 | 设置 `TESTFLOW_BASE_URL`，调用 `loadConfigFromEnv()` | `TESTFLOW_BASE_URL=https://env-override.example.com` | environments.test.base_url 被覆盖 | 正确覆盖为 `https://env-override.example.com` | ✅ | - |
| TC_CFG_002 | 配置 | TESTFLOW_EXTRA JSON 深度合并 | P0 | 编译成功 | 设置 `TESTFLOW_EXTRA='{"poll_interval_ms":9999}'`，调用 `loadConfigFromEnv()` | JSON 格式环境变量 | poll_interval_ms 被覆盖为 9999 | 正确覆盖为 9999 | ✅ | - |
| TC_CFG_003 | 配置 | 无环境变量时使用默认值 | P0 | 编译成功 | 不设置任何 TESTFLOW_* 变量，调用 `loadConfigFromEnv()` | 无环境变量 | 返回原始配置不变 | poll_interval_ms=3000（原始值），base_url 不变 | ✅ | - |
| TC_CFG_004 | 配置 | 环境特定覆盖 TESTFLOW_PREONLINE_BASE_URL | P1 | 编译成功 | 设置 `TESTFLOW_PREONLINE_BASE_URL`，检查仅覆盖 preonline 环境 | `TESTFLOW_PREONLINE_BASE_URL=https://pre.example.com` | 仅 preonline.base_url 被覆盖，test 不受影响 | test.base_url 保持原始值，preonline.base_url 正确覆盖 | ✅ | - |
| TC_CFG_005 | 配置 | loadConfig() 集成 env-loader 位置正确 | P0 | 读取 config.ts L75-84 | 检查 loadConfigFromEnv() 调用位置：JSON 解析后 → env 覆盖 → validate 前 | config.ts L76-81 | env 覆盖在 validate 前 | L77: JSON.parse → L80: `loadConfigFromEnv(cfg)` → L81: `validate(merged, envName)` 位置正确 | ✅ | - |
| TC_CFG_006 | 配置 | CLI 参数优先级高于环境变量 | P1 | 读取 engine.ts L231 | 检查 `args.env || getEnvFromEnv() || undefined` 优先级链 | CLI --env vs TESTFLOW_ENV | CLI > TESTFLOW_ENV > default_env | `args.env`（CLI）优先 → `getEnvFromEnv()`（TESTFLOW_ENV）次之 → `cfg.default_env` 最后 | ✅ | - |
| TC_CFG_007 | 配置 | .env.example 文档完整性 | P1 | 读取 .env.example + env-loader.ts | 1. 提取 env-loader.ts 支持的变量 2. 提取 .env.example 列出的变量 3. 对比 | env-loader: 13 个变量（含 SESSION_COOKIES_PATH, POLL_INTERVAL_MS） | .env.example 覆盖全部 | **缺失 2 个变量**：`TESTFLOW_SESSION_COOKIES_PATH` 和 `TESTFLOW_POLL_INTERVAL_MS` 在 env-loader.ts 中处理但未在 .env.example 中文档化 | ❌ | BUG_CFG_01 |
| TC_CFG_008 | 配置 | 敏感信息无硬编码 | P0 | 全局搜索 | `grep -rn 'AK\|SK\|SECRET\|PASSWORD' src/ --include='*.ts'` 排除变量名 | - | 代码中无硬编码密钥 | 所有 OSS 配置通过 `process.env` 读取，无硬编码。`.dockerignore` 排除 `.env` | ✅ | - |
| TC_CFG_009 | 配置 | .gitignore 排除 .env（安全） | P0 | 读取 .gitignore | `grep -c '.env' .gitignore` | .gitignore 内容 | `.env` 被 gitignored | **.gitignore 不含 `.env`**，开发者创建 .env 后可能误提交 secrets 到仓库。`.dockerignore` 正确排除但 `.gitignore` 遗漏 | ❌ | BUG_CFG_02 |

### 模块 E：回归测试（5 条）

| 用例编号 | 所属模块 | 用例标题 | 优先级 | 前置条件 | 测试步骤 | 测试数据 | 预期结果 | 实际结果 | 是否通过 | 缺陷编号 |
|----------|----------|----------|--------|----------|----------|----------|----------|----------|----------|----------|
| TC_REG_001 | 回归 | TypeScript 类型检查 | P0 | - | `npx tsc --noEmit` | - | 0 errors | EXIT_CODE=0，无错误 | ✅ | - |
| TC_REG_002 | 回归 | 完整编译 | P0 | - | `npm run build` | - | tsc + copy-assets 成功 | tsc 编译成功 + `[copy-assets] environments.json -> dist/` | ✅ | - |
| TC_REG_003 | 回归 | --help 参数可见性 | P0 | 编译成功 | `node dist/bin/run-test.js --help` | - | --upload-reports 参数可见 | `--upload-reports   上传报告到 OSS...` 在帮助文本中可见 | ✅ | - |
| TC_REG_004 | 回归 | dry-run 原有功能不受影响 | P0 | 编译成功 | `node dist/bin/run-test.js --task src/cases --dry-run` | - | 9 用例，8 通过，1 预期失败 | 9 用例，8 通过，"空模型ID" 1 失败（预期），exit code 2 | ✅ | - |
| TC_REG_005 | 回归 | CI 模式 + dry-run 组合 | P1 | 编译成功 | `node dist/bin/run-test.js --task src/cases --ci --dry-run` | - | CI 模式下 dry-run 正常 | 正常输出，9 用例校验完成 | ✅ | - |

---

## 3. 缺陷报告

### BUG_DOCKER_01：Dockerfile 基础镜像版本与代码 ESM 特性不兼容

| 字段 | 内容 |
|------|------|
| **缺陷编号** | BUG_DOCKER_01 |
| **缺陷标题** | Dockerfile 使用 `node:18-alpine` 但代码依赖 `import.meta.dirname`（需 Node 20.11+） |
| **严重程度** | Blocker |
| **优先级** | 紧急 |
| **复现步骤** | 1. 使用 Dockerfile 构建镜像 `docker build -t test-flow .` 2. 运行容器 `docker run --rm test-flow:latest --task src/cases --dry-run` 3. 容器启动执行 `node dist/bin/run-test.js` 4. `config.ts` 的 `resolveConfigPath()` 访问 `import.meta.dirname` 5. Node 18 中该属性为 `undefined` 6. `path.join(undefined, 'environments.json')` 抛出 TypeError |
| **实际结果** | 容器启动即崩溃，错误：`TypeError [ERR_INVALID_ARG_TYPE]: The "path" argument must be of type string. Received undefined` |
| **预期结果** | 容器正常启动，执行测试命令并输出结果 |
| **测试环境** | 本地 Node v26.3.1 模拟 Node 18 行为验证（`path.join(undefined, 'test')` 确认抛 TypeError）；Docker 未安装，静态分析确认 |
| **关联用例** | TC_DOCKER_001, TC_DOCKER_007 |
| **根因分析** | `src/config/config.ts` L11 使用 `import.meta.dirname`（Node.js 20.11.0 新增 API）。`scripts/copy-assets.mjs` L6 使用 `fileURLToPath(import.meta.url)` 方式（Node 18+ 兼容），说明项目中存在两种 ESM 路径处理方式，config.ts 选择了不兼容 Node 18 的方式。`package.json` engines 声明 `>=18.0.0` 但实际代码要求 `>=20.11.0` |
| **影响范围** | Docker 容器化全部功能（Dockerfile + docker-compose.yml）；CI 中如果使用 Docker 镜像也会受影响 |
| **修复建议** | 方案 A（推荐）：Dockerfile L2/L18 改为 `FROM node:20-alpine`；方案 B：config.ts 改用 `fileURLToPath(import.meta.url)` + `path.dirname()` 方式（与 copy-assets.mjs 一致）；方案 C：package.json engines 改为 `>=20.11.0` 并统一 Dockerfile |

### BUG_DOCKER_02：outputDir() 硬编码宿主机路径，Docker volume 挂载无效

| 字段 | 内容 |
|------|------|
| **缺陷编号** | BUG_DOCKER_02 |
| **缺陷标题** | `fs-utils.ts` 的 `outputDir()` 硬编码 `/Users/mac/agents/output/`，容器内路径不匹配 |
| **严重程度** | Blocker |
| **优先级** | 紧急 |
| **复现步骤** | 1. 构建并运行 Docker 容器（假设 BUG_DOCKER_01 已修复） 2. 执行测试，报告通过 `outputDir()` 写入 3. `outputDir()` 返回 `/Users/mac/agents/output/2026-08-17/...` 4. `docker-compose.yml` 挂载 `./output:/app/output` 5. 报告写入 `/Users/mac/agents/output/`（容器内不存在该目录） 6. 挂载点 `/app/output` 无数据 |
| **实际结果** | 报告写入容器内不存在的 `/Users/mac/agents/output/` 路径（或因目录不存在而报错）。volume 挂载 `./output:/app/output` 无数据写入，无法持久化到宿主机 |
| **预期结果** | 报告写入 `/app/output/2026-08-17/...`，通过 volume 挂载持久化到宿主机 `./output/` |
| **测试环境** | 静态代码分析：`fs-utils.ts` L48 |
| **关联用例** | TC_DOCKER_002, TC_DOCKER_006, TC_DOCKER_007 |
| **根因分析** | `src/utils/fs-utils.ts` L48: `const base = \`/Users/mac/agents/output/${todayStr()}\`` 硬编码开发机绝对路径。改造引入了 docker-compose volume 挂载 `/app/output`，但未同步修改 outputDir() 的路径逻辑 |
| **影响范围** | Docker 容器化（volume 挂载无效）；CI 环境（如果 output 路径与预期不一致）；OSS 上传（uploadReports 从 outputBase 递归收集文件，路径不对则无法上传） |
| **修复建议** | 改为环境变量驱动：`const base = path.join(process.env.TESTFLOW_OUTPUT_DIR \|\| path.join(process.cwd(), 'output'), todayStr())`。Dockerfile 添加 `ENV TESTFLOW_OUTPUT_DIR=/app/output`。docker-compose.yml 已挂载 `./output:/app/output` 即可生效 |

### BUG_DOCKER_03：ASSETS_ROOT 硬编码路径，容器内素材库不可用

| 字段 | 内容 |
|------|------|
| **缺陷编号** | BUG_DOCKER_03 |
| **缺陷标题** | `assets.ts` 的 `ASSETS_ROOT` 硬编码 `/Users/mac/agents/Test-panqu`，容器内路径不存在 |
| **严重程度** | Blocker |
| **优先级** | 紧急 |
| **复现步骤** | 1. 构建并运行 Docker 容器（假设 BUG_DOCKER_01/02 已修复） 2. 执行涉及素材上传的用例（如全量回归） 3. `Assets` 类构造函数默认使用 `ASSETS_ROOT = '/Users/mac/agents/Test-panqu'` 4. 容器内该路径不存在 5. 素材上传功能失败 |
| **实际结果** | 容器内 `/Users/mac/agents/Test-panqu` 不存在，涉及素材的用例执行失败 |
| **预期结果** | 素材库路径可配置，容器内通过 volume 挂载或环境变量指向正确路径 |
| **测试环境** | 静态代码分析：`src/integrations/assets.ts` L9 |
| **关联用例** | TC_DOCKER_003 |
| **根因分析** | `src/integrations/assets.ts` L9: `export const ASSETS_ROOT = '/Users/mac/agents/Test-panqu'` 硬编码开发机路径。全量硬编码路径扫描发现：`grep -rn '/Users/mac' src/` 返回 5 处，其中 3 处为硬编码（outputDir + ASSETS_ROOT + 注释），2 处为注释 |
| **影响范围** | Docker 容器中执行涉及素材上传的用例（如 wan3 功能模块的文生视频/图生视频场景）；CI 环境 |
| **修复建议** | 改为环境变量：`export const ASSETS_ROOT = process.env.TESTFLOW_ASSETS_ROOT \|\| '/Users/mac/agents/Test-panqu'`。docker-compose.yml 添加 volume `./Test-panqu:/app/assets:ro` 和 `TESTFLOW_ASSETS_ROOT=/app/assets` 环境变量 |

### BUG_CI_01：GitLab CI test:wan3 的 when:manual 被 rules 忽略

| 字段 | 内容 |
|------|------|
| **缺陷编号** | BUG_CI_01 |
| **缺陷标题** | `test:wan3` job 级别 `when: manual` 与 `rules` 同时存在，`when` 被忽略 |
| **严重程度** | Major |
| **优先级** | 高 |
| **复现步骤** | 1. 将 `.gitlab-ci.yml` 提交到 GitLab 仓库 2. 通过 Web UI 触发流水线（CI_PIPELINE_SOURCE=web） 3. `test:wan3` 的 `rules: [{ if: $CI_PIPELINE_SOURCE == "web" }]` 匹配 4. GitLab CI 规范：rules 存在时 job 级 `when` 被忽略 5. rule 默认 `when: on_success` 6. job 自动执行而非等待手动点击 |
| **实际结果** | `test:wan3` 在 Web 触发后自动执行，未等待手动确认 |
| **预期结果** | `test:wan3` 仅在 Web 触发时出现，且需手动点击 "Run job" 才执行 |
| **测试环境** | 静态分析 `.gitlab-ci.yml` L77-92 |
| **关联用例** | TC_CI_005, TC_CI_006 |
| **根因分析** | `.gitlab-ci.yml` L92: `when: manual` 在 job 级别定义。L90-91: `rules: [{ if: $CI_PIPELINE_SOURCE == "web" }]`。GitLab CI 规范：当 `rules` 关键字存在时，job 级别的 `when`、`only/except` 均被忽略。需将 `when: manual` 移入 rule 内部 |
| **影响范围** | GitLab CI 中 `test:wan3` 调试 job 行为不符合预期。同样的问题在 `test` job（L74 `when: on_success`）也存在，但 `on_success` 是默认值所以无实际影响 |
| **修复建议** | 将 `when: manual` 移入 rule：<br>```yaml<br>rules:<br>  - if: $CI_PIPELINE_SOURCE == "web"<br>    when: manual<br>```<br>删除 job 级别 `when: manual`（L92）。同时建议删除 `test` job 的 `when: on_success`（L74），因为 rules 存在时它也被忽略 |

### BUG_CI_02：CI 模板 secrets 注入不完整

| 字段 | 内容 |
|------|------|
| **缺陷编号** | BUG_CI_02 |
| **缺陷标题** | GitLab CI 和 GitHub Actions 均未注入 env-loader 支持的全部环境变量 |
| **严重程度** | Minor |
| **优先级** | 中 |
| **复现步骤** | 1. 提取 env-loader.ts 支持的变量（13 个） 2. 提取 .env.example 列出的变量（22 个） 3. 提取 GitHub Actions env: 段注入的 secrets（8 个） 4. 提取 GitLab CI Variables 注释列出的变量（8 个） 5. 对比缺失项 |
| **实际结果** | 缺失 8 个变量（两个 CI 平台均缺失）：`TESTFLOW_ACCOUNT`、`TESTFLOW_BASE_URL`、`TESTFLOW_SUBMIT_URL`、`TESTFLOW_STATUS_URL`、`TESTFLOW_DETAIL_URL`、`TESTFLOW_BILLING_URL`、`TESTFLOW_CSRF_PAGE`、`TESTFLOW_FEISHU_MENTION` |
| **预期结果** | CI 模板注入 `.env.example` 中列出的全部环境变量（或注明哪些可选） |
| **测试环境** | 静态分析 `.gitlab-ci.yml` + `.github/workflows/test.yml` + `env-loader.ts` + `.env.example` |
| **关联用例** | TC_CI_007 |
| **根因分析** | CI 模板仅注入了"核心必填"变量（COOKIE/PROJECT_ID/FEISHU/OSS_*），遗漏了 env-loader 支持的环境覆盖变量。env-loader 的 `loadConfigFromEnv()` 会读取这些变量覆盖 environments.json，但如果 CI 不注入它们，则覆盖功能在 CI 环境中无效 |
| **影响范围** | CI 环境中环境变量覆盖功能部分失效。如果 environments.json 中的 URL 在 CI 环境需要不同值（如 CI 专用 API 网关），无法通过环境变量覆盖 |
| **修复建议** | 在 GitHub Actions `env:` 段和 GitLab CI 注释中补充缺失变量。标注哪些为必填、哪些为可选。或添加 `TESTFLOW_EXTRA` JSON 注入支持（一次性覆盖多个字段） |

### BUG_CFG_01：.env.example 缺少 2 个环境变量文档

| 字段 | 内容 |
|------|------|
| **缺陷编号** | BUG_CFG_01 |
| **缺陷标题** | `.env.example` 未文档化 `TESTFLOW_SESSION_COOKIES_PATH` 和 `TESTFLOW_POLL_INTERVAL_MS` |
| **严重程度** | Minor |
| **优先级** | 中 |
| **复现步骤** | 1. 提取 env-loader.ts 中 `getEnvVar()` 调用的所有 key 2. 提取 .env.example 中列出的变量 3. 对比 |
| **实际结果** | env-loader.ts L40 处理 `SESSION_COOKIES_PATH`，L43 处理 `POLL_INTERVAL_MS`，但 `.env.example` 未列出这两个变量 |
| **预期结果** | `.env.example` 文档化 env-loader 支持的所有变量 |
| **测试环境** | 静态分析 env-loader.ts + .env.example |
| **关联用例** | TC_CFG_007 |
| **根因分析** | `.env.example` 创建时遗漏了 env-loader 中支持的 `SESSION_COOKIES_PATH` 和 `POLL_INTERVAL_MS` 变量 |
| **影响范围** | 开发者/运维不知道可以通过环境变量覆盖 session cookies 路径和轮询间隔 |
| **修复建议** | 在 `.env.example` 中补充：<br>```<br># session-cookies.json 路径（默认使用 environments.json 中的配置）<br>TESTFLOW_SESSION_COOKIES_PATH=<br># 轮询间隔毫秒（默认 3000）<br>TESTFLOW_POLL_INTERVAL_MS=<br>``` |

### BUG_CFG_02：.gitignore 未排除 .env 文件（安全风险）

| 字段 | 内容 |
|------|------|
| **缺陷编号** | BUG_CFG_02 |
| **缺陷标题** | `.gitignore` 不含 `.env`，开发者创建 .env 后可能误提交 secrets |
| **严重程度** | Major |
| **优先级** | 高 |
| **复现步骤** | 1. 配置外部化改造新增 `.env.example` 鼓励开发者复制为 `.env` 2. 开发者 `cp .env.example .env` 并填入真实 AK/SK 3. `.gitignore` 内容：`node_modules/ dist/ *.log .DS_Store output/` — 不含 `.env` 4. `git add -A` 会将 `.env` 加入暂存区 5. `git commit` 将 secrets 提交到仓库 |
| **实际结果** | `.env` 文件不在 `.gitignore` 排除范围内，存在 secrets 泄露风险 |
| **预期结果** | `.gitignore` 排除 `.env`（但保留 `.env.example`），与 `.dockerignore` 行为一致 |
| **测试环境** | 静态分析 `.gitignore` + `.dockerignore` 对比 |
| **关联用例** | TC_CFG_009 |
| **根因分析** | 配置外部化改造新增了 `.env.example` 文件和 `--env-file .env` 使用模式，但未同步更新 `.gitignore`。`.dockerignore` 正确排除了 `.env`（L10-11: `.env` / `.env.*` / `!.env.example`），但 `.gitignore` 遗漏 |
| **影响范围** | 所有使用 `.env` 文件的开发者和 CI 环境。一旦 secrets 被提交，即使后续删除，Git 历史仍保留 |
| **修复建议** | 在 `.gitignore` 中添加：<br>```<br>.env<br>.env.*<br>!.env.example<br>``` |

### BUG_CFG_03：package.json engines 版本声明与代码实际要求不符

| 字段 | 内容 |
|------|------|
| **缺陷编号** | BUG_CFG_03 |
| **缺陷标题** | `package.json` engines 声明 `>=18.0.0` 但代码使用 `import.meta.dirname` 需 `>=20.11.0` |
| **严重程度** | Minor |
| **优先级** | 中 |
| **复现步骤** | 1. 读取 `package.json` L21: `"engines": { "node": ">=18.0.0" }` 2. 读取 `config.ts` L11: `import.meta.dirname` 3. 确认 `import.meta.dirname` 在 Node 20.11.0 才可用 |
| **实际结果** | engines 声明 `>=18.0.0`，但代码实际要求 `>=20.11.0`。Dockerfile 基于 `node:18-alpine` 也受此误导 |
| **预期结果** | engines 声明与代码实际最低版本要求一致 |
| **测试环境** | 静态分析 package.json + config.ts |
| **关联用例** | TC_DOCKER_001 |
| **根因分析** | `package.json` engines 字段未随代码演进更新。`import.meta.dirname` 在引入时（可能是之前的提交）未同步更新 engines |
| **影响范围** | 误导开发者认为 Node 18 可用；CI 模板使用 `node:18` 镜像；Dockerfile 使用 `node:18-alpine` |
| **修复建议** | 将 engines 改为 `"node": ">=20.11.0"`，与 Dockerfile 和 CI 模板的基础镜像保持一致 |

### BUG_CFG_04：engine.ts 中 applyEnvToConfig() 调用冗余

| 字段 | 内容 |
|------|------|
| **缺陷编号** | BUG_CFG_04 |
| **缺陷标题** | `loadConfig()` 已通过 `loadConfigFromEnv()` 合并环境变量，engine.ts 再次调用 `applyEnvToConfig()` 重复覆盖 |
| **严重程度** | Trivial |
| **优先级** | 低 |
| **复现步骤** | 1. 读取 `config.ts` L80: `loadConfigFromEnv(cfg)` 在 `loadConfig()` 内部已执行环境变量覆盖 2. 读取 `engine.ts` L236: `cfg = applyEnvToConfig(cfg, envName)` 再次覆盖 project_id/base_url/account 3. 两次覆盖均读取相同环境变量 |
| **实际结果** | 环境变量覆盖执行两次：第一次全面（loadConfigFromEnv），第二次部分（applyEnvToConfig 仅 3 字段） |
| **预期结果** | 环境变量覆盖仅执行一次 |
| **测试环境** | 静态代码分析 |
| **关联用例** | TC_CFG_005, TC_CFG_006 |
| **根因分析** | `env.ts`（旧模块）和 `env-loader.ts`（新模块）功能重叠。engine.ts 同时 import 两者：L20 从 env.ts import `applyEnvToConfig`，config.ts L6 从 env-loader.ts import `loadConfigFromEnv` |
| **影响范围** | 无功能影响（重复覆盖幂等），但增加维护复杂度和微性能开销 |
| **修复建议** | 删除 engine.ts L236 的 `cfg = applyEnvToConfig(cfg, envName || cfg.default_env)` 调用。长期建议合并 env.ts 和 env-loader.ts 为单一模块，标记 env.ts 为 deprecated |

---

## 4. 测试报告

### 4.1 执行概况

| 指标 | 数值 |
|------|------|
| 用例总数 | 40 |
| 通过 | 28 |
| 失败 | 7 |
| 部分通过 | 2 |
| 阻塞 | 1（Docker 未安装） |
| 缺陷总数 | 8 |
| Blocker | 3 |
| Major | 2 |
| Minor | 2 |
| Trivial | 1 |
| 通过率 | 70.0%（28/40） |
| 可执行用例通过率 | 71.8%（28/39，排除 1 个阻塞） |

### 4.2 缺陷统计

**按严重程度分布：**

| 严重程度 | 数量 | 缺陷编号 |
|----------|------|----------|
| Blocker | 3 | BUG_DOCKER_01, BUG_DOCKER_02, BUG_DOCKER_03 |
| Major | 2 | BUG_CI_01, BUG_CFG_02 |
| Minor | 2 | BUG_CI_02, BUG_CFG_01, BUG_CFG_03 |
| Trivial | 1 | BUG_CFG_04 |

**按模块分布：**

| 模块 | 缺陷数 | Blocker | Major | Minor | Trivial |
|------|--------|---------|-------|-------|---------|
| Docker | 3 | 3 | 0 | 0 | 0 |
| CI/CD | 2 | 0 | 1 | 1 | 0 |
| OSS | 0 | 0 | 0 | 0 | 0 |
| 配置 | 3 | 0 | 1 | 1 | 1 |
| 回归 | 0 | 0 | 0 | 0 | 0 |

### 4.3 质量结论

| 改造项 | 用例数 | 通过率 | Blocker | Major | 结论 |
|--------|--------|--------|---------|-------|------|
| **Docker 容器化** | 7 | 28.6%（2/7） | 3 | 0 | ❌ **不可发布** — 3 个 Blocker 阻塞：基础镜像版本不兼容 + 2 处硬编码路径。需修复全部 Blocker 后重新验证 |
| **CI/CD 流水线** | 9 | 66.7%（6/9） | 0 | 1 | ⚠️ **有条件发布** — YAML 语法通过，核心流程可用。test:wan3 手动触发行为需修复；secrets 注入需补全 |
| **OSS 报告上传** | 10 | 100%（10/10） | 0 | 0 | ✅ **可发布** — 配置读取/重试/收集/URL 生成/飞书集成全部验证通过 |
| **配置外部化** | 9 | 66.7%（6/9） | 0 | 1 | ⚠️ **有条件发布** — 核心覆盖逻辑正确，但 .gitignore 安全缺陷 + .env.example 不完整需修复 |
| **回归测试** | 5 | 100%（5/5） | 0 | 0 | ✅ **通过** — 类型检查/编译/help/dry-run 全部正常，原有功能不受影响 |

**总体结论**：❌ **不可发布**。3 个 Blocker（全部集中在 Docker 容器化模块）阻塞发布。OSS 上传和回归测试模块质量优秀。需优先修复 Docker 相关 Blocker，同时修复 CI/CD 和配置模块的 Major/Minor 缺陷。

### 4.4 质量自检清单

| 检查项 | 状态 | 说明 |
|--------|------|------|
| Dockerfile 基础镜像版本与代码特性兼容性核对 | ✅ 已检查 | 发现 BUG_DOCKER_01：node:18 vs import.meta.dirname |
| 代码中所有硬编码绝对路径对容器化的影响 | ✅ 已检查 | `grep -rn '/Users/mac' src/` 发现 3 处硬编码：outputDir()、ASSETS_ROOT、注释 |
| docker-compose 卷挂载路径与代码输出路径一致性 | ✅ 已检查 | 发现 BUG_DOCKER_02：outputDir 返回 /Users/mac/agents/output/ ≠ 挂载点 /app/output |
| GitLab CI 中 rules 与 job 级 when 的互斥 | ✅ 已检查 | 发现 BUG_CI_01：test:wan3 when:manual 被 rules 忽略 |
| GitHub Actions secrets 注入完整性 | ✅ 已检查 | 发现 BUG_CI_02：缺失 8 个环境变量 |
| OSS 配置缺失/部分/完整三种场景测试 | ✅ 已测试 | 3/3 通过（TC_OSS_001-003） |
| TESTFLOW_EXTRA JSON 合并与 CLI 参数优先级 | ✅ 已测试 | 2/2 通过（TC_CFG_002, TC_CFG_006） |
| tsc/build/help/dry-run 回归 | ✅ 已执行 | 5/5 通过（TC_REG_001-005） |
| 所有缺陷有根因分析/影响范围/修复建议 | ✅ 已输出 | 8 个缺陷均含完整字段 |
| 质量结论和风险清单 | ✅ 已输出 | 见 4.3 和 4.5 节 |

### 4.5 风险清单

| 编号 | 风险描述 | 影响范围 | 严重程度 | 规避措施 |
|------|----------|----------|----------|----------|
| RISK-01 | Docker 镜像构建和运行未实际验证（Docker 未安装） | Docker 容器化全部功能 | 高 | 在 CI 环境或安装 Docker 的机器上补充 TC_DOCKER_007 用例验证 |
| RISK-02 | `import.meta.dirname` 在 Node 18 不可用 | Docker 容器启动崩溃 | 🔴 阻塞 | 修复 BUG_DOCKER_01：升级基础镜像为 node:20-alpine |
| RISK-03 | `outputDir()` + `ASSETS_ROOT` 硬编码绝对路径 | Docker volume 挂载无效 + 素材库不可用 | 🔴 阻塞 | 修复 BUG_DOCKER_02/03：改为环境变量驱动 |
| RISK-04 | `.gitignore` 未排除 `.env`，secrets 可能泄露 | 全项目安全 | 高 | 修复 BUG_CFG_02：添加 .env 到 .gitignore |
| RISK-05 | OSS 上传在 CI 环境中未端到端验证 | 上传逻辑可能有运行时错误 | 中 | 配置真实 OSS 后补充端到端上传测试 |
| RISK-06 | 飞书通知 reportUrls 未在 CI 环境验证 | 飞书卡片渲染可能异常 | 低 | 配置飞书 webhook 后验证卡片渲染 |
| RISK-07 | env.ts 与 env-loader.ts 功能重叠 | 配置覆盖逻辑混乱，维护困难 | 中 | 统一为单一模块，标记 env.ts 为 deprecated |
| RISK-08 | Dockerfile 复制 environments.json 路径与 copy-assets.mjs 重复 | 构建冗余（无害） | 极低 | 可接受，或移除 Dockerfile L29 的显式 COPY |
| RISK-09 | package.json engines 声明不准确 | 误导开发者使用 Node 18 | 中 | 修复 BUG_CFG_03：改为 >=20.11.0 |
| RISK-10 | GitLab CI test job 重复 npm run build | CI 耗时增加约 30s | 低 | 保留作 cache miss 兜底，或改为条件执行 |

### 4.6 回归建议

| 需回归模块 | 回归范围 | 优先级 | 原因 |
|-----------|----------|--------|------|
| Docker 容器化 | Dockerfile 基础镜像升级后重新执行全量 Docker 用例 | P0 | 修复 BUG_DOCKER_01 后需验证容器可正常启动和运行 |
| fs-utils.ts | outputDir() 路径改为环境变量后，验证本地 + 容器输出路径一致 | P0 | 修复 BUG_DOCKER_02 后需验证报告写入和 volume 持久化 |
| assets.ts | ASSETS_ROOT 改为环境变量后，验证素材上传功能正常 | P0 | 修复 BUG_DOCKER_03 后需验证素材路径可配 |
| .gitignore | 添加 .env 排除后，验证 git status 不再跟踪 .env | P1 | 修复 BUG_CFG_02 后验证安全 |
| .gitlab-ci.yml | 修复 when:manual 位置后，验证 GitLab CI 中 test:wan3 行为 | P1 | 修复 BUG_CI_01 后需在 GitLab 平台验证 |
| .env.example | 补充缺失变量后，验证文档完整性 | P2 | 修复 BUG_CFG_01 后验证文档 |
| 全量回归 | tsc + build + dry-run | P0 | 任何代码修改后必须执行基础回归 |

### 4.7 改进建议

#### Dockerfile 改进

1. **基础镜像升级**：`node:18-alpine` → `node:20-alpine`（修复 BUG_DOCKER_01）
2. **输出目录参数化**：添加 `ENV TESTFLOW_OUTPUT_DIR=/app/output`，配合代码改造（修复 BUG_DOCKER_02）
3. **素材路径参数化**：添加 `ENV TESTFLOW_ASSETS_ROOT=/app/assets` + volume 挂载（修复 BUG_DOCKER_03）
4. **镜像标签版本化**：`docker build -t test-flow:$(date +%Y%m%d) .` 而非仅 `latest`
5. **添加 LABEL 元数据**：`LABEL maintainer="team@example.com" version="3.0.0"`
6. **添加 .dockerignore 补充**：考虑排除 `tasks/` 目录（旧格式 JSON 用例，Docker 内使用 src/cases/）

#### CI 模板改进

1. **修复 when:manual 位置**（BUG_CI_01）：移入 rules 条件内部
2. **补全 secrets 注入**（BUG_CI_02）：GitHub Actions env: 段补充缺失的 8 个变量；GitLab CI Variables 注释同步更新
3. **添加 CI 缓存优化**：考虑 `actions/cache` 或 GitLab `cache` 策略，进一步缩短 CI 时间
4. **添加失败通知**：CI 失败时推送飞书/Slack/钉钉通知到团队
5. **添加 CI 健康检查**：可选添加 `npm run dry-run` 作为 CI 预检步骤

#### OSS 上传改进

1. **并发上传**：大量报告文件时使用 `p-limit` 并发上传提升速度
2. **上传进度日志**：添加进度百分比日志（如 `上传中 [3/10]`）
3. **MD5 校验**：上传后对比本地与远端 MD5 确保数据完整性
4. **清理旧报告**：可选 `--oss-retention-days` 参数，自动清理 OSS 中过期报告
5. **多后端抽象**：抽象为 `StorageBackend` 接口支持 S3/MinIO 等

#### 配置外置改进

1. **修复 .gitignore**（BUG_CFG_02）：添加 `.env` / `.env.*` / `!.env.example`
2. **补全 .env.example**（BUG_CFG_01）：补充 `TESTFLOW_SESSION_COOKIES_PATH` 和 `TESTFLOW_POLL_INTERVAL_MS`
3. **修复 engines 版本**（BUG_CFG_03）：改为 `>=20.11.0`
4. **统一 env 模块**（BUG_CFG_04）：合并 env.ts 和 env-loader.ts 为单一模块
5. **配置变更审计**：记录哪些配置项被环境变量覆盖，输出到 metrics 或日志
6. **.env 文件自动加载**：可选集成 `dotenv` 在开发环境自动加载 .env

---

## 5. 环境变量覆盖矩阵

| 变量名 | env-loader.ts | .env.example | .gitlab-ci.yml | GitHub Actions | 说明 |
|--------|:---:|:---:|:---:|:---:|------|
| TESTFLOW_ENV | ✅ | ✅ | - | - | 默认环境 |
| TESTFLOW_COOKIE | ✅ | ✅ | ✅ | ✅ | 会话 cookie |
| TESTFLOW_PROJECT_ID | ✅ | ✅ | ✅ | ✅ | 项目 ID |
| TESTFLOW_ACCOUNT | ✅ | ✅ | ❌ | ❌ | 账号名 |
| TESTFLOW_BASE_URL | ✅ | ✅ | ❌ | ❌ | API base URL |
| TESTFLOW_SUBMIT_URL | ✅ | ✅ | ❌ | ❌ | 提交接口 |
| TESTFLOW_STATUS_URL | ✅ | ✅ | ❌ | ❌ | 状态接口 |
| TESTFLOW_DETAIL_URL | ✅ | ✅ | ❌ | ❌ | 详情接口 |
| TESTFLOW_BILLING_URL | ✅ | ✅ | ❌ | ❌ | 计费接口 |
| TESTFLOW_CSRF_PAGE | ✅ | ✅ | ❌ | ❌ | CSRF 页面 |
| TESTFLOW_EXTRA | ✅ | ✅ | - | - | JSON 扩展 |
| TESTFLOW_SESSION_COOKIES_PATH | ✅ | ❌ | - | - | **缺失文档** |
| TESTFLOW_POLL_INTERVAL_MS | ✅ | ❌ | - | - | **缺失文档** |
| TESTFLOW_FEISHU_WEBHOOK | ✅ | ✅ | ✅ | ✅ | 飞书 webhook |
| TESTFLOW_FEISHU_MENTION | ✅ | ✅ | ❌ | ❌ | 飞书 @ |
| TESTFLOW_OSS_ENDPOINT | - | ✅ | ✅ | ✅ | OSS endpoint |
| TESTFLOW_OSS_BUCKET | - | ✅ | ✅ | ✅ | OSS bucket |
| TESTFLOW_OSS_ACCESS_KEY_ID | - | ✅ | ✅ | ✅ | OSS AK |
| TESTFLOW_OSS_ACCESS_KEY_SECRET | - | ✅ | ✅ | ✅ | OSS SK |
| TESTFLOW_REPORT_BASE_URL | - | ✅ | ✅ | ✅ | 报告 URL 前缀 |
| TESTFLOW_*_PREONLINE | - | ✅ (4) | - | - | 预发布环境变量 |
