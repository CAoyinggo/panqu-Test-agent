# Panqu NewAPI 新模型接入与自测操作指南 (SOP)

本文档面向研发与测试工程师，提供从新模型配置、NewAPI 联调、管理后台配置到自动化验证的端到端标准操作程序（SOP）。

---

## 一、新模型接入准备清单

- [ ] **模型 ID 与别名**：确认在 `pq_model_config` 表中已分配 `id`，在 `Ai.php` 的 `getNewAPIModelAlias()` 中完成主站 ID 与 NewAPI 别名的映射（如 `wan3.0-video`）；
- [ ] **全量开关初始态**：明确 `is_newapi_global` 是置 1（全量走全局渠道）还是置 0（仅对特定组织分流）；
- [ ] **NewAPI 只读核对**：在 `https://aiapis.panqu.com/keys` 确认测试分组 `panqu_test` 下存在可用渠道且配置了该模型；
- [ ] **模型能力与规格**：确认模型支持的生成分类（视频/图片）、分辨率集合、画幅比例集合以及是否支持全能参考/首尾帧。

---

## 二、CMS 渠道管理配置

1. 打开主站 CMS 后台：`https://test.panqu.com`；
2. 进入【运营管理】→【渠道管理】；
3. 找到目标渠道（如 Wan 3.0、TalkingData 或 RunningHub）点击编辑；
4. 在「基础配置」中配置：
   - 切换分类：视频生成 / 图片生成；
   - 勾选模型能力：全能参考（可选是否支持参考视频）、首尾帧；
   - 勾选支持分辨率（如 480P、720P、768P、1080P）；
   - 勾选支持宽高比（如自适应、16:9、9:16、1:1 等）；
5. 点击保存。主站将自动更新 `newapi_route_rules` 与 `newapi_route_group_rules` 配置。

---

## 三、全链路测试验证步骤

### 1. 静态与单元测试快速核查
在 `test-flow` 仓库下执行自动化分流流程测试：
```bash
node ./dist/bin/run-devtest.js flow api-diversion --project-root /path/to/panqu-ai
```
核对输出的 21 项契约用例是否全数 PASS。

### 2. CMS 全量开关单项自测
若需要自测开关切换：
1. 先记录模型原 `is_newapi_global` 状态（如 0）；
2. 点击开启并确认持久化成功；
3. 发起一条测试任务验证走入全局 NewAPI 渠道；
4. **必须回滚**：再次点击切换回 0，复核数据库或接口确认零残留。

### 3. 端到端真机任务提交
1. 任务名称命名规范：必须使用带有 `devtest_` 前缀的唯一标识，例如：
   - `devtest_0910_wan3_e2e`
   - `devtest_0910_prime_e2e`
   - `devtest_0910_td_e2e`
2. 观察任务快照：检查 `pq_aivideo_new.extra` 是否成功写入 `newapi_model`、`newapi_group` 与 `points`；
3. 扣费核对：在生成完成后检查用户积分余额，确认实扣积分与预估一致（10 积分 = 1 元）。
