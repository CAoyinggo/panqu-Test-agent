# Developer Handoff Release Checklist

以下清单由 `npm run acceptance:test`、`npm run test:p0`、全量测试、Agent Eval 和构建共同验证。发布前必须执行文末命令并保存结果。

- [x] Requirement 可解析
- [x] AC 可追溯
- [x] Test Point 可生成
- [x] API Case 可生成
- [x] 参数边界正常
- [x] 权限场景正常
- [x] 数据隔离正常
- [x] API 可真实执行
- [x] PASS/FAIL 正确
- [x] BLOCKED 正确
- [x] NOT_EXECUTED 正确
- [x] Defect 分类正确
- [x] 报告生成
- [x] 报告脱敏
- [x] Run 可重跑
- [x] Run 不互相污染
- [x] 报告不覆盖
- [x] video/WAN3 回归通过
- [x] P0 回归通过
- [x] Agent Eval 通过
- [x] Build 通过

```bash
npm run build
npm run acceptance:test
npm run test:p0 -- --reporter=dot
npm test -- --reporter=dot
npm run agent:eval
git diff --check
```

最后四项只能在上述交付前命令真实通过后勾选。
