# Panqu NewAPI 分流与接入问题排查手册 (Troubleshooting)

在进行 NewAPI 对接、新模型接入或分流自测时，如遇到任务未如期分流或生成失败，按以下排查决策树进行快速定位。

---

## 一、为什么我的任务没有走 NewAPI 分流（回退直连）？

```
任务未分流排查决策树
       │
       ├─► 检查 1：分流总模式是否关闭？
       │     查看 aivideo_diversion_config 中 newapi_route_mode：
       │     - 若为 'off'，所有任务走直连（正常业务行为）；
       │     - 若为 'legacy'，走旧版概率分流；
       │     - 必须为 'newapi' 才进入两级分流。
       │
       ├─► 检查 2：是否触发了硬性资格拦截（isRequestEligible）？
       │     - cueword 字数是否 > 5000？（若是，直接报错拦截）；
       │     - output_format 是否为 'mov'？（MOV 格式不支持分流）；
       │     - 是否包含真人人像识别结果？（真人人像不走 NewAPI）；
       │     - 模型是否为 Seedance 且带了 ref_videos？（Seedance 参考视频走直连）；
       │     - 模型是否为 16 (Seedance 2.0 Fast) 或 58 (Seedance 2.0 Mini)？（此两模型走直连）。
       │
       ├─► 检查 3：该模型是否开启了全量开放（is_newapi_global）？
       │     - 若 is_newapi_global == 1：
       │         * 检查 Ai.php 中是否有对应的 getNewAPIModelAlias() 映射；
       │         * 检查 aivideo_diversion_config 中 newapi_global_api_key 是否配置；
       │         * 满足后应直接走分流（newapi_org_id = 0）。
       │
       └─► 检查 4：若为非全量模型 (is_newapi_global == 0)：
             - 检查渠道能力并集（newapi_route_rules）：
                 请求的分辨率/画幅是否在全局已启用渠道中配置？
             - 检查当前用户角色组组织绑定（pq_newapi_route_group_org）：
                 用户所属角色组是否绑定了有效路由组？路由组 status 是否为 1 且 Key 非空？
             - 检查分组能力（newapi_route_group_rules）：
                 路由组所属的 newapi_group 下是否有渠道承接该分辨率和画幅？
```

---

## 二、为什么任务进入 NewAPI 后报错 503 或 No Channel？

1. **渠道未挂载对应模型**：
   - 检查 `https://aiapis.panqu.com/keys` 中对应渠道（如 #36 Wan3.0）是否已配置请求模型名称（如 `wan3.0-video`）；
2. **分组（Group）不匹配**：
   - 主站任务携带的 `newapi_group`（如 `panqu_test`）是否在该渠道支持的分组列表中？
   - 若渠道仅对 `default` 开放，而主站请求使用了特定业务分组，NewAPI 将找不到可用渠道；
3. **渠道每日积分限额（daily_quota_limit）耗尽**：
   - NewAPI 渠道配置了每日额度，若当前任务所需积分加上已用额度超过上限，NewAPI 将跳过该渠道；
4. **渠道权重为 0 或被禁用**：
   - 检查渠道状态是否为启用，权重是否大于 0。

---

## 三、常见日志与排查 SQL

### 1. 查询模型配置状态
```sql
SELECT id, show_name, newapi_model_alias, is_newapi_global 
FROM pq_model_config 
WHERE id IN (84, 88);
```

### 2. 查询分流全局规则
```sql
SELECT name, value 
FROM pq_aivideo_diversion_config 
WHERE line = 10;
```

### 3. 查询当前用户的组织与路由组绑定
```sql
SELECT a.id AS auth_group_id, a.name AS group_name, o.route_group_id, g.name AS route_group_name, g.newapi_group, g.status
FROM pq_auth_group a
JOIN pq_newapi_route_group_org o ON a.id = o.org_id
JOIN pq_newapi_route_group g ON o.route_group_id = g.id
WHERE a.id = 10;
```

### 4. 查询任务分流快照
```sql
SELECT id, type, is_need_fallback, status, extra 
FROM pq_aivideo_new 
WHERE id = 128;
```
查看 `extra` 字段内是否持久化了 `newapi_model`、`newapi_group` 与 `points`。
