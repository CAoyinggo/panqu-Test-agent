# Legacy 断言 DSL 兼容文档

> **LEGACY 边界**：本文描述已有 `TaskDef.assert` / Assertion Engine 的操作符和兼容调用。新 DevTest TestCase 必须先按 [TestCase V2 字段与生成规则](testing/testcase-v2-schema.md) 声明 Requirement/Fact trace、Oracle 和 Evidence Requirement，再将可执行断言映射到本 DSL。本 DSL 单独通过不等于 DevTest Case PASS。

## 架构概览

```
┌─────────────────────────────────────────────────────────┐
│                    用例定义 (TaskDef)                      │
│  assert?: AssertionConfig    adapter?: 'wan3' | 'default' │
└──────────────┬──────────────────────────┬─────────────────┘
               │                          │
     ┌─────────▼──────────┐    ┌──────────▼──────────────┐
     │  通用断言引擎        │    │  业务适配器              │
     │  assertion-engine   │    │  wan3-adapter            │
     │  ├ path-extractor   │    │  (调用现有 7 个断言模块)   │
     │  ├ operators (16个) │    │  db/billing/status/...   │
     │  └ 组合逻辑 AND/OR  │    └─────────────────────────┘
     └────────────────────┘
               │
     ┌─────────▼──────────┐
     │  CheckResult[]      │
     │  (统一结果格式)      │
     └─────────────────────┘
```

### 分层说明

| 层级 | 职责 | 业务耦合 |
|------|------|----------|
| 通用断言核心 | DSL 解析、操作符、JSON Path、组合逻辑 | 无 |
| 业务适配层 | wan3.0 专用断言（计费/状态/安全等） | wan3.0 |
| 用例定义层 | 声明式 `assert` 字段 + `adapter` 选择 | 可选 |

### 核心文件

| 文件 | 说明 |
|------|------|
| `src/core/assertion-engine.ts` | 通用断言引擎（DSL 解析、组合逻辑、超时/重试） |
| `src/core/assertion-operators.ts` | 16 个操作符实现 |
| `src/core/path-extractor.ts` | JSON Path 提取器（纯函数） |
| `src/assertions/adapters/wan3-adapter.ts` | wan3.0 业务适配器 |
| `src/cases/define.ts` | 断言 DSL 辅助函数 |

---

## 断言上下文 (AssertionContext)

断言引擎从统一上下文中提取值：

```typescript
interface AssertionContext {
  response?: { status: number; json: any; headers?: Record<string, string>; durationMs?: number };
  submit?: Record<string, unknown>;     // 提交结果
  billing?: Record<string, unknown>;    // 计费数据
  headers?: Record<string, string>;     // 响应头
  env?: Record<string, unknown>;        // 环境状态
  metrics?: Record<string, number>;     // 性能指标
  custom?: Record<string, unknown>;     // 自定义上下文
}
```

### target 映射

| target | 对应上下文 | 典型用途 |
|--------|-----------|----------|
| `response` | `context.response` | HTTP 状态码、响应体字段 |
| `submit` | `context.submit` | 提交结果（taskId、status 等） |
| `billing` | `context.billing` | 积分消耗、快照差值 |
| `headers` | `context.headers` | 响应头（content-type 等） |
| `env` | `context.env` | 环境变量、配置 |
| `metrics` | `context.metrics` | 性能指标（durationMs 等） |
| `custom` | `context.custom` | 任意自定义数据 |

---

## JSON Path 提取

支持点路径 + 数组索引 + 通配符，最大递归深度 10 层。

### 路径语法

| 语法 | 示例 | 说明 |
|------|------|------|
| 点路径 | `body.data.id` | 嵌套属性访问 |
| 数组索引 | `body.data[0].id` | 按下标取数组元素 |
| 通配符 | `body.data[*].name` | 遍历数组所有元素，返回数组 |
| 带连字符 key | `headers.content-type` | 直接属性名访问 |
| 字符串 key | `body.["key.name"]` | 含特殊字符的 key |

### 示例

```javascript
const obj = {
  body: { data: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }], total: 2 },
  headers: { 'content-type': 'application/json' },
  status: 200,
};

extractPath(obj, 'body.data[0].id')        // → 1
extractPath(obj, 'body.data[*].name')       // → ['A', 'B']
extractPath(obj, 'body.total')             // → 2
extractPath(obj, 'headers.content-type')    // → 'application/json'
extractPath(obj, 'status')                  // → 200
```

---

## 操作符

### 完整操作符列表

| 操作符 | 语义 | expected 类型 | 失败 detail 示例 |
|--------|------|---------------|-----------------|
| `equals` | 严格相等 `===` | 任意 | `expected: 1, actual: 0` |
| `notEquals` | 不等 `!==` | 任意 | `value should not be 0, but got 1` |
| `contains` | 字符串子串 / 数组元素 | string / any | `expected to contain "完成", got "处理中"` |
| `notContains` | 不包含 | string / any | `should not contain "timeout", but found in "timeout error"` |
| `exists` | 非 undefined/null | 无 | `value is undefined or null` |
| `notExists` | 为 undefined/null | 无 | `value is "data", expected undefined/null` |
| `gt` | 大于 | number | `expected > 5, actual: 3` |
| `gte` | 大于等于 | number | `expected >= 5, actual: 3` |
| `lt` | 小于 | number | `expected < 5, actual: 10` |
| `lte` | 小于等于 | number | `expected <= 5, actual: 10` |
| `in` | 值在列表中 | array | `"失败" not in ["完成", "成功"]` |
| `notIn` | 值不在列表中 | array | `"完成" should not be in ["失败", "超时"]` |
| `regex` | 正则匹配 | string (pattern) | `pattern /提示词.*必填/ didn't match "..."` |
| `type` | 类型校验 | string | `expected type: number, actual: string` |
| `length` | 数组/字符串/对象长度 | number | `expected length: 3, actual: 5` |
| `deepEquals` | 深度相等 | object/array | `expected: {"a":2}, actual: {"a":1} - diff: value differs` |
| `jsonSchema` | JSON Schema 校验 | object (schema) | `JSON Schema validation failed: /text: must be string` |

### type 操作符支持的类型值

| 类型值 | 匹配 |
|--------|------|
| `string` | `typeof === 'string'` |
| `number` | `typeof === 'number'` |
| `boolean` | `typeof === 'boolean'` |
| `object` | `typeof === 'object'` 且非数组非 null |
| `array` | `Array.isArray()` |
| `null` | `=== null` |
| `undefined` | `=== undefined` |
| `function` | `typeof === 'function'` |

### jsonSchema 操作符

`jsonSchema` 使用动态 `import('ajv')` 按需加载。AJV 未安装、加载失败、Schema 非法或编译失败时必须 **fail-close**：

- 本条断言不得返回 `pass=true`；
- Case 必须记录 `BLOCKED`/`EXECUTION_ERROR`，具体归类由运行阶段决定；
- 报告必须保留加载/编译错误，不得冒充 schema 已验证；
- 必须证据未产生时，Evidence Coverage 与 Verified Coverage 均不得计入。

```bash
# 使用 jsonSchema 操作符的执行环境必须安装 ajv
npm install ajv
```

---

## 断言规则结构

```typescript
interface AssertionRule {
  target: 'response' | 'submit' | 'billing' | 'headers' | 'env' | 'metrics' | 'custom';
  path?: string;                    // JSON Path，如 body.data[0].id
  operator: AssertionOperator;      // 操作符
  expected?: unknown;               // 期望值
  message?: string;                 // 自定义失败消息
  timeoutMs?: number;              // 断言超时（默认 5000ms）
  retry?: { count: number; intervalMs: number };  // 断言重试（指数退避）
  severity?: 'P0' | 'P1' | 'P2';   // 失败级别
}
```

`AssertionRule` 是 Legacy 执行器的最小操作符输入，它本身没有 Requirement/Fact/Evidence 追溯字段。TestCase V2 的 `AssertionDefinition` 必须在外层补齐稳定 `id`、`acceptanceCriteriaIds`、`factIds`、`evidenceRequirementIds` 和确定性 `oracle`；不得因 Legacy operator 返回 pass 就直接宣布 DevTest PASS。

---

## 组合逻辑

### mode 字段

| mode | 别名 | 语义 | 行 |
|------|------|------|------|
| `all` | `and` | AND（全部必须通过） | 任一失败立即中断 |
| `any` | `or` | OR（任一通过即可） | 任一成功立即中断 |
| `soft` | - | 软断言（收集全部） | 不中断，收集所有结果 |

### 嵌套组合

支持任意深度嵌套，使用 `mode` 或 `combinator` 字段：

```json
{
  "assert": {
    "mode": "all",
    "rules": [
      { "target": "response", "path": "status", "operator": "equals", "expected": 200 },
      {
        "mode": "or",
        "rules": [
          { "target": "submit", "path": "status", "operator": "equals", "expected": "完成" },
          { "target": "submit", "path": "status", "operator": "equals", "expected": "成功" }
        ]
      },
      { "target": "billing", "path": "actualConsumed", "operator": "equals", "expected": 240 }
    ]
  }
}
```

等价写法（使用 `combinator`）：

```json
{
  "combinator": "or",
  "rules": [...]
}
```

---

## TypeScript 辅助函数

`src/cases/define.ts` 提供以下辅助函数：

```typescript
import { assertRules, assertAll, assertAny, assertSoft, assert } from '../define.js';

// assertAll: AND 模式
const config1 = assertAll(
  assert('response', 'status', 'equals', 200),
  assert('response', 'body.code', 'equals', 1),
);

// assertAny: OR 模式
const config2 = assertAny(
  assert('submit', 'status', 'equals', '完成'),
  assert('submit', 'status', 'equals', '成功'),
);

// assertSoft: 软断言模式
const config3 = assertSoft(
  assert('response', 'body.data.image_url', 'exists'),
  assert('response', 'body.data.width', 'gte', 512),
);

// assertRules: 数组形式（等价 assertAll）
const config4 = assertRules([
  assert('response', 'status', 'equals', 200),
  assert('response', 'body.code', 'equals', 1),
]);
```

---

## 完整示例

### 示例 1：图片生成功能

```json
{
  "name": "文生图-赛博朋克风格",
  "scene": "图片生成",
  "adapter": "default",
  "assert": {
    "mode": "all",
    "rules": [
      { "target": "response", "path": "status", "operator": "equals", "expected": 200 },
      { "target": "response", "path": "json.code", "operator": "equals", "expected": 1 },
      { "target": "response", "path": "json.data.image_url", "operator": "exists" },
      { "target": "response", "path": "json.data.width", "operator": "gte", "expected": 512 },
      { "target": "response", "path": "json.data.image_url", "operator": "regex", "expected": "^https?://" },
      { "target": "response", "path": "json.data.model", "operator": "equals", "expected": "stable-diffusion-xl" },
      { "target": "billing", "path": "cost", "operator": "equals", "expected": 10 }
    ]
  }
}
```

### 示例 2：音频生成功能

```json
{
  "name": "文生音-温暖女声",
  "scene": "音频生成",
  "adapter": "default",
  "assert": {
    "mode": "soft",
    "rules": [
      { "target": "response", "path": "json.data.audio_url", "operator": "exists" },
      { "target": "response", "path": "json.data.duration_seconds", "operator": "gt", "expected": 0 },
      { "target": "response", "path": "json.data.audio_url", "operator": "regex", "expected": "\\.mp3$" },
      { "target": "billing", "path": "cost", "operator": "lte", "expected": 50 }
    ]
  }
}
```

### 示例 3：文本生成功能

```json
{
  "name": "文本生成-产品文案",
  "scene": "文本生成",
  "adapter": "default",
  "assert": {
    "mode": "all",
    "rules": [
      { "target": "response", "path": "json.data.text", "operator": "exists" },
      { "target": "response", "path": "json.data.text", "operator": "length", "expected": 10 },
      { "target": "response", "path": "json.data.tokens", "operator": "gt", "expected": 0 },
      { "target": "response", "path": "json.data.text", "operator": "contains", "expected": "产品" },
      { "target": "response", "path": "json.data.model", "operator": "type", "expected": "string" },
      {
        "target": "response",
        "path": "json.data",
        "operator": "jsonSchema",
        "expected": {
          "type": "object",
          "required": ["text", "tokens", "model"],
          "properties": {
            "text": { "type": "string", "minLength": 1 },
            "tokens": { "type": "number", "minimum": 0 }
          }
        }
      }
    ]
  }
}
```

### 示例 4：视频编辑功能（含嵌套组合）

```json
{
  "name": "视频编辑-裁剪拼接",
  "scene": "视频编辑",
  "adapter": "default",
  "assert": {
    "mode": "all",
    "rules": [
      { "target": "response", "path": "status", "operator": "equals", "expected": 200 },
      {
        "mode": "or",
        "rules": [
          { "target": "submit", "path": "status", "operator": "equals", "expected": "完成" },
          { "target": "submit", "path": "status", "operator": "equals", "expected": "处理中" }
        ]
      },
      { "target": "response", "path": "json.data.output_url", "operator": "regex", "expected": "\\.(mp4|mov)$" },
      { "target": "billing", "path": "cost", "operator": "lte", "expected": 100 }
    ]
  }
}
```

### 示例 5：含超时和重试的断言

```json
{
  "name": "异步任务-轮询完成",
  "scene": "文生视频",
  "adapter": "wan3",
  "assert": {
    "mode": "all",
    "rules": [
      {
        "target": "submit",
        "path": "status",
        "operator": "equals",
        "expected": "完成",
        "message": "任务应在 30 秒内完成",
        "timeoutMs": 30000,
        "retry": { "count": 5, "intervalMs": 2000 },
        "severity": "P0"
      }
    ]
  }
}
```

---

## 迁移指南：为新功能模块添加断言

### 方式 1：纯声明式（推荐，无需写 TypeScript）

1. 在用例 JSON 或 TS 定义中添加 `assert` 字段
2. 设置 `adapter: "default"`（不运行 wan3 业务断言）
3. 定义断言规则

```typescript
import { defineCase, assertAll, assert } from '../define.js';

export default defineCase({
  name: '图片生成-测试',
  scene: '图片生成',
  adapter: 'default',
  assert: assertAll(
    assert('response', 'status', 'equals', 200, 'HTTP 200'),
    assert('response', 'json.code', 'equals', 1, '业务码 1'),
    assert('response', 'json.data.image_url', 'exists', '图片 URL 存在'),
  ),
  // ... 其他字段
});
```

### 方式 2：复用 wan3 适配器 + 自定义断言

如果新功能与 wan3.0 类似（有积分、状态流转等），可以同时使用 wan3 适配器和自定义断言：

```typescript
export default defineCase({
  name: '新视频功能-测试',
  scene: '文生视频',
  adapter: 'wan3',  // 运行 wan3 断言集
  assert: assertAll(
    assert('response', 'json.data.new_field', 'exists'),
    assert('response', 'json.data.width', 'gte', 1080),
  ),
  // ...
});
```

### 方式 3：创建新适配器

1. 在 `src/assertions/adapters/` 下创建新适配器文件
2. 在 `wan3-adapter.ts` 的 `runAdapterAssertions` 中注册

```typescript
// src/assertions/adapters/image-adapter.ts
import type { CheckResult } from '../../core/types.js';

export function runImageAdapter(ctx: AdapterContext): CheckResult[] {
  // 业务特定断言逻辑
  return [
    { name: '图片尺寸校验', pass: true, detail: '1024x1024' },
  ];
}
```

在 `wan3-adapter.ts` 的 `runAdapterAssertions` 中添加：

```typescript
case 'image':
  return runImageAdapter(ctx as ImageAdapterContext);
```

### pipeline 集成

`pipeline.ts` 中的断言执行顺序：

1. `runDefaultAssertions()` — wan3 默认断言（向后兼容）
2. `runGenericAssertions()` — 用例 `assert` 字段声明的通用断言
3. `runAdapterAssertions()` — 业务适配器（非 wan3 时触发）

断言失败后的行为由 `taskDef.onFail` 控制：
- `stop`（默认）：中断后续步骤
- `continue`：继续执行，收集所有结果

---

## 向后兼容性

| 变更 | 兼容性 | 说明 |
|------|--------|------|
| `TaskDef.assert` | 新增可选字段 | 不设则不运行通用断言 |
| `TaskDef.adapter` | 新增可选字段 | 不设则仅运行默认断言 |
| `TaskDef.onFail` | 新增可选字段 | 默认 `stop` |
| `CheckResult` 扩展 | 新增可选字段 | 现有代码不受影响 |
| `runDefaultAssertions` | 未修改 | 原样调用 |
| 现有 wan3 用例 | 行为一致 | 无 `assert` 字段时跳过通用断言 |
