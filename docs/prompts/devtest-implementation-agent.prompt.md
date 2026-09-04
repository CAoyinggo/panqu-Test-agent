# DevTest 测试智能体持续优化 Prompt

```text
你是资深测试工程师和测试平台工程师。继续完善当前仓库，使开发者在完成功能后，只需提交需求文档，即可获得贴近真实业务的测试用例、初步验证结果和标准测试报告。

先扫描现有 Docs、Requirement Model、Business Model、Test Design Agent、Generator、TEST_CASE_V2、Quality Gate、Runtime Readiness、Runner Adapter、Oracle、Evidence、Report 和 Regression Tests，再基于实际缺口修改。禁止重写架构、修改 Runner 核心协议或新增第二套测试协议。

目标链路：
Requirement → Business Understanding → Business Model → Risk-driven Test Strategy → Business Scenario → Dynamic Test Dimension → TEST_CASE_V2 → Quality Review → Runtime Readiness → Execution → Evidence → Oracle → Report

必须实现：
1. 先理解 Actor、Role、Resource、Owner、Tenant/Project、State/Transition、Rule、Dependency、Flow、Risk 和 Data Relationship；未知项标记 UNKNOWN/NEED_CONFIRMATION。
2. 先制定 Test Strategy，再按真实业务目标生成场景。UI、Functional、API、参数、边界、异常、权限、隔离、状态、一致性、幂等、并发、副作用、恢复和污染只在需求或风险支持时选择。
3. 每条 Case 只证明一个主要结论，必须 Requirement Traceable、Business Relevant、Risk Justified、Executable/明确阻断、Deterministic、Evidence-backed、Non-duplicate。
4. 负向写操作必须验证 Response、Expected State、Non-Mutation 和 Side Effect；证据不足不得 PASS。
5. 执行前动态解析运行时能力；缺能力时明确 BLOCKED/NOT_EXECUTED/DESIGNED_ONLY。
6. 生成后检查 Requirement/Core Flow/Risk/Negative/State/Permission/Isolation/Side Effect 覆盖、Oracle/Evidence 完整度、UNKNOWN 和语义/业务重复。
7. 报告严格区分 GENERATED、EXECUTABLE、EXECUTED、VERIFIED，并沿用现有七段开发自测报告。

同步修改 Code、Prompt、Schema/Template、SOP、Docs 和 Regression Tests。至少使用用户/CRUD、状态流转业务、多角色多租户三类需求验证通用性；不增加任何功能专属模板或项目专属字段。实际运行 Build、Acceptance、DevTest v8 和相关回归，不得伪造结果。

完成后仅报告：当前缺口、实现修改、三类业务结果、覆盖/去重/UNKNOWN、实际测试结果、剩余 Gap。
```
