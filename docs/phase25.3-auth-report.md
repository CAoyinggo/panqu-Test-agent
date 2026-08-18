# Phase 25.3 Authentication / User System 报告

## 一、目标与结论

Phase 24 仅有 `Bearer Token + X-Actor + X-Role`（Header 直信任、无真实用户）。
25.3 升级为**真实用户系统 + JWT 认证 + RBAC 资源作用域**：

```text
POST /auth/login → JWT → Authorization: Bearer → Auth Middleware → User → RBAC → Service
```

X-Actor / X-Role 降级为 **development/test 内部模式**（生产默认关闭）。
RBAC 增加 Project / Environment / Business Scope（项目隔离 + 环境隔离）。

**结论：25.3 完成。** 全部验收指标 PASS：

```text
npm test                  1300 PASS（新增 54）
agent:test                 450 PASS
```

## 二、新增能力

### 1. `src/platform/auth/`（认证模块）
| 文件 | 能力 |
| --- | --- |
| `user.ts` | `User` 接口（id/username/displayName/email/roles/status/scopes/createdAt）+ `UserScopes`（projects/environments/businesses） |
| `password.ts` | scrypt 密码哈希（node:crypto 内置，timingSafeEqual 防时序攻击） |
| `user-store.ts` | `UserStore`：`Repository<UserRecord>` 持久化 + 幂等种子用户（并发安全） |
| `jwt.ts` | HS256 JWT（RFC 7519）：sign / verify / decode；支持 access/refresh 类型、过期、时间确定性注入 |
| `auth-service.ts` | `AuthService`：login / logout / refresh（旋转）/ info / verify；access 登出吊销、refresh 吊销；可选审计 |

### 2. RBAC 作用域（`src/platform/rbac/scopes.ts`）
```text
canAccessProject / canAccessEnvironment / canAccessBusiness
assertRunAccess / filterProjectsByScope / isAdmin
```
- QA-A → `wan3` / `test+staging`；QA-B → `order` / `test`；越权一律拒绝
- 无作用域 = 全部；显式空数组 = 完全禁止；ADMIN 全局

### 3. API Server（`src/platform/api/server.ts`）
- **认证优先级**：JWT（AuthService）优先 → 静态 Token + X-Header（仅 development/test）→ 401
- **production 关闭 X-Header 直信任**（S6 生产安全）：`mode === 'production'` 时静态 Token + X-Header 一律 401
- 新增认证端点：`POST /auth/login`、`POST /auth/logout`、`POST /auth/refresh`、`GET /auth/info`
- Run / 审批端点按 JWT 用户作用域强制校验（`withRunScope` / `withApprovalScope`）
- 项目 / Run 列表按作用域过滤；请求自动生成 `requestId` / `traceId`（响应与错误体均携带）
- Phase 24 API 完全兼容（旧测试不依赖 JWT 时仍走内部模式通过）

### 4. Service Layer（`src/platform/service/`）
- `CreateRunRequest` 增加 `scopes?`；`createRun` 在 RBAC 后执行项目 + 环境作用域断言
- 工厂创建 `users`（UserStore）与 `auth`（AuthService），同一存储后端落库
- `AuditAction` 扩展 `auth.login / auth.logout / auth.refresh`（AuthService 可选审计）

### 5. CLI（`bin/platform-cli.ts`）
启动时 `await bundle.auth.ensureSeeded()`；新增 `auth` 命令组：
`auth login/refresh/logout/info/users`。

## 三、测试

### 单元
- `tests/unit/jwt.test.ts`（9 例）：往返 / 篡改 / 错误密钥 / 过期 / 未生效 / 类型 / 结构 / 解码 / 时间确定性
- `tests/unit/auth.test.ts`（13 例）：密码哈希 / UserStore 幂等种子 / login/logout/refresh/info/verify / 禁用用户 / 生产默认口令禁用 / 审计
- `tests/unit/rbac-scope.test.ts`（10 例）：Project / Environment / Business Scope / 断言式 / 列表过滤

### 集成
- `tests/integration/auth-rbac.test.ts`（14 例）：S1 登录→JWT→API→User；S2 项目隔离（QA-A→wan3 PASS / order DENY）；环境隔离；VIEWER 无 TEST_RUN；审计；SQLite 后端认证
- `tests/integration/api-auth.test.ts`（8 例）：JWT 有效/无效/伪造；X-Header 内部模式（development/test）；production 拒绝 X-Header（S6）；requestId/traceId 契约

### 验证
```text
npm test                  1300 PASS
agent:test                 450 PASS
```

## 四、风险与说明

- Breaking Change：无。`Repository<T>` 未变；Phase 24 API（含 X-Header 内部模式）向后兼容；
  `ApiServerOptions` 新增字段均为可选
- 生产默认口令：`AuthService.login` 在 `allowDefaultCredentials=false` 时拒绝全部默认种子账号；
  该开关由 25.8 运行模式统一注入
- 未接外部 OAuth / LDAP（任务书允许第一阶段 JWT 即可）
- 强约束满足：未新增 Agent、未重写引擎、未破坏 Phase 24 API、未删除 JSON/Memory 兼容层
