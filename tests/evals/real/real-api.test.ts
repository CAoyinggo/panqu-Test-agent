// 三档评测：Real API 档（Phase 20.8）
// 需 RUN_REAL_E2E=true 才运行，否则整组跳过。全部为只读验证：
//   - 真实配置 / 环境快照完整性（base_url / project_id / 各端点 URL）
//   - 会话与凭证就绪（getRealHttp 校验登录态）
// 不发送任何真实提交（真实提交需另设 REAL_E2E_SUBMIT=true，见 e2e/real 覆盖）。
import { describe, it, expect } from 'vitest';
import { describeReal, itReal, getRealEnv, getRealHttp, REAL_ENV } from '../../e2e/real/real-env.js';
import { REAL_API_ENABLED, evalTiers } from './real-eval-env.js';
import { guardProductionAction } from '../../../src/config/environment-policy.js';

describe.skipIf(!REAL_API_ENABLED)('Eval-RealAPI：真实 API 档（只读）', () => {
  itReal('环境快照完整（base_url / project_id / 各端点 URL 就绪）', () => {
    const env = getRealEnv(REAL_ENV);
    expect(env.baseUrl).toBeTruthy();
    expect(env.projectId).toBeGreaterThan(0);
    expect(env.submitUrl).toBeTruthy();
    expect(env.statusUrl).toBeTruthy();
    expect(env.detailUrl).toBeTruthy();
    expect(env.billingUrl).toBeTruthy();
    expect(env.account).toBeTruthy();
  });

  itReal('会话与凭证就绪（登录态可加载）', () => {
    const { http, session } = getRealHttp(REAL_ENV);
    expect(session.cookie_string).toBeTruthy();
    expect(http).toBeDefined();
  });

  it('档位摘要可读（Real API 已启用）', () => {
    expect(REAL_API_ENABLED).toBe(true);
    const t = evalTiers();
    expect(t.realAPI).toBe(true);
  });

  // 说明性：真实环境约束检查（无需网络）
  it('真实环境不显式允许 production 时 production 守卫拒绝', () => {
    const { guardProductionAction } = require('../../../src/config/environment-policy.js') as typeof import('../../../src/config/environment-policy.js');
    expect(guardProductionAction('production', 'read-only').allowed).toBe(false);
  });
});
