import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  evaluateDiversionDecision,
  evaluateImageDiversionDecision,
  evaluateNewApiChannelSelection,
  evaluateConsumerFallbackDecision,
  runPanquDiversionFlow,
  type DiversionConfigSnapshot,
  type NewApiChannelConfig,
} from '../../../src/devtest/panqu-diversion-flow.js';

const roots: string[] = [];

async function put(root: string, file: string, content: string) {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), content);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

describe('Panqu API Diversion Flow', () => {
  const baseConfig: DiversionConfigSnapshot = {
    routeMode: 'newapi',
    globalModelIds: [84, 88], // Wan 3.0, Wan 3.0 Prime
    globalApiKey: 'sk-test-global-key',
    globalRouteRules: {
      video: {
        105: { resolutions: ['480p', '720p', '1080p'], aspect_ratios: ['16:9', '9:16', '1:1', '4:3', '3:4'] },
        84: { resolutions: ['480p', '720p', '1080p'], aspect_ratios: ['auto', '16:9', '9:16', '1:1', '4:3', '3:4'] },
      },
    },
    groupRouteRules: {
      video: {
        panqu_test: {
          105: { resolutions: ['480p', '720p'], aspect_ratios: ['16:9', '9:16'] },
        },
      },
    },
    orgBindings: {
      10: { routeGroupId: 1, newapiGroup: 'panqu_test', status: 1, apiKey: 'sk-test-org-key' },
    },
  };

  describe('evaluateDiversionDecision - 两级分流决策树', () => {
    it('分流模式 off 时直接阻断并回归直连 (line=0)', () => {
      const res = evaluateDiversionDecision(
        { videoType: 105, modelId: 105 },
        { ...baseConfig, routeMode: 'off' },
      );
      expect(res.decision).toBe('FALLBACK_DIRECT');
      expect(res.line).toBe(0);
    });

    it('分流模式 legacy 时回退原概率分流 (line>0)', () => {
      const res = evaluateDiversionDecision(
        { videoType: 105, modelId: 105 },
        { ...baseConfig, routeMode: 'legacy' },
      );
      expect(res.decision).toBe('FALLBACK_LEGACY');
      expect(res.line).toBe(6);
    });

    it('提示词超过 5000 字时被硬性拦截', () => {
      const res = evaluateDiversionDecision(
        { videoType: 105, modelId: 105, cueword: 'X'.repeat(5001) },
        baseConfig,
      );
      expect(res.decision).toBe('BLOCKED_ILLEGAL');
      expect(res.line).toBe(0);
    });

    it('输出格式为 mov 时拦截回退直连', () => {
      const res = evaluateDiversionDecision(
        { videoType: 105, modelId: 105, outputFormat: 'mov' },
        baseConfig,
      );
      expect(res.decision).toBe('FALLBACK_DIRECT');
    });

    it('全量开放模型 (is_newapi_global=1) 绕过组织路由组直达 NewAPI 全局 (orgId=0, line=10)', () => {
      const res = evaluateDiversionDecision(
        { videoType: 105, modelId: 84 },
        baseConfig,
        (id) => `alias-${id}`,
      );
      expect(res.decision).toBe('NEWAPI_GLOBAL');
      expect(res.line).toBe(10);
      expect(res.newapiOrgId).toBe(0);
      expect(res.newapiModel).toBe('alias-84');
    });

    it('非全量模型匹配组织与路由组成功分流', () => {
      const res = evaluateDiversionDecision(
        {
          videoType: 105,
          modelId: 105,
          resolution: '720p',
          aspectRatio: '16:9',
          userGroupIds: [10],
        },
        baseConfig,
        (id) => `alias-${id}`,
      );
      expect(res.decision).toBe('NEWAPI_ORG_GROUP');
      expect(res.line).toBe(10);
      expect(res.newapiOrgId).toBe(10);
      expect(res.newapiRouteGroupId).toBe(1);
      expect(res.newapiGroup).toBe('panqu_test');
    });

    it('未绑定路由组的角色组回退直连', () => {
      const res = evaluateDiversionDecision(
        {
          videoType: 105,
          modelId: 105,
          resolution: '720p',
          aspectRatio: '16:9',
          userGroupIds: [999], // 未绑定
        },
        baseConfig,
      );
      expect(res.decision).toBe('FALLBACK_DIRECT');
    });

    it('请求包含渠道不支持的分辨率 (8k) 时前置拦截回退', () => {
      const res = evaluateDiversionDecision(
        {
          videoType: 105,
          modelId: 105,
          resolution: '8k',
          aspectRatio: '16:9',
          userGroupIds: [10],
        },
        baseConfig,
      );
      expect(res.decision).toBe('FALLBACK_DIRECT');
    });
  });

  describe('evaluateImageDiversionDecision - 生图分流资格前置校验', () => {
    it('别名为空时静默走原渠道 (diverted=false)', () => {
      const res = evaluateImageDiversionDecision(
        { selmodelsId: 201, serviceline: 'r', userGroupIds: [10] },
        baseConfig,
        () => '',
      );
      expect(res.diverted).toBe(false);
      expect(res.reason).toContain('模型别名留空');
    });

    it('服务线路非 r 时静默走原渠道', () => {
      const res = evaluateImageDiversionDecision(
        { selmodelsId: 201, serviceline: 't', userGroupIds: [10] },
        baseConfig,
        (id) => `alias-${id}`,
      );
      expect(res.diverted).toBe(false);
      expect(res.reason).toContain('非 r');
    });

    it('尺寸类型为 pixels 时不分流', () => {
      const res = evaluateImageDiversionDecision(
        { selmodelsId: 201, serviceline: 'r', sizeType: 'pixels', userGroupIds: [10] },
        baseConfig,
        (id) => `alias-${id}`,
      );
      expect(res.diverted).toBe(false);
      expect(res.reason).toContain('pixels');
    });

    it('参考图数量超过 10 张时拦截不分流', () => {
      const res = evaluateImageDiversionDecision(
        {
          selmodelsId: 201,
          serviceline: 'r',
          imageList: Array(11).fill('http://example.com/ref.png'),
          userGroupIds: [10],
        },
        baseConfig,
        (id) => `alias-${id}`,
      );
      expect(res.diverted).toBe(false);
      expect(res.reason).toContain('超过上限 10 张');
    });

    it('满足全部规则时成功分流并返回路由快照', () => {
      const res = evaluateImageDiversionDecision(
        {
          selmodelsId: 201,
          serviceline: 'r',
          sizeType: 'resolution',
          imageList: ['http://example.com/ref1.png'],
          userGroupIds: [10],
        },
        baseConfig,
        (id) => `alias-${id}`,
      );
      expect(res.diverted).toBe(true);
      expect(res.snapshot).toBeDefined();
      expect(res.snapshot?.orgId).toBe(10);
      expect(res.snapshot?.routeGroupId).toBe(1);
      expect(res.snapshot?.newapiGroup).toBe('panqu_test');
      expect(res.snapshot?.newapiModel).toBe('alias-201');
    });
  });

  describe('evaluateNewApiChannelSelection - 网关渠道分组与每日限额熔断', () => {
    const testChannels: NewApiChannelConfig[] = [
      {
        id: 36,
        name: '万相-yhuo',
        group: 'panqu_test',
        models: ['wan2.1-t2v-plus'],
        status: 1,
        weight: 100,
        dailyQuotaLimit: 50000,
        usedQuota: 10000,
      },
      {
        id: 41,
        name: 'TD-Seedance',
        group: 'panqu_test',
        models: ['seedance-2.0'],
        status: 1,
        weight: 80,
        dailyQuotaLimit: 20000,
        usedQuota: 19950,
      },
      {
        id: 39,
        name: 'RunningHub-默认',
        group: 'default',
        models: ['wan2.1-t2v-plus'],
        status: 1,
        weight: 50,
        dailyQuotaLimit: 0,
        usedQuota: 1000,
      },
    ];

    it('非 default 分组渠道严格隔离，跨分组请求不可见', () => {
      const res = evaluateNewApiChannelSelection('vip_group', 'wan2.1-t2v-plus', 10, testChannels);
      expect(res.candidateChannelIds).toEqual([39]); // 仅 default 可见
    });

    it('渠道每日积分超限时触发配额熔断剔除', () => {
      const res = evaluateNewApiChannelSelection('panqu_test', 'seedance-2.0', 100, testChannels);
      expect(res.isBlockedByQuota).toBe(true);
      expect(res.selectedChannel).toBeUndefined();
    });

    it('多可用渠道中优先选择高权重渠道', () => {
      const res = evaluateNewApiChannelSelection('panqu_test', 'wan2.1-t2v-plus', 10, testChannels);
      expect(res.selectedChannel?.id).toBe(36);
    });
  });

  describe('evaluateConsumerFallbackDecision - 消费端失败兜底策略', () => {
    it('Wan 3.0 系列任务失败自动改写 line=1 投递原生百炼队列', () => {
      const res = evaluateConsumerFallbackDecision({ taskType: 105, selmodelsId: 84, status: 7 });
      expect(res.fallbackAction).toBe('WAN3_NATIVE_RETRY');
      expect(res.targetLine).toBe(1);
      expect(res.targetQueue).toBe('video_wanxiang3_queue');
      expect(res.recordRetryLog).toBe(true);
    });

    it('SD 系列任务失败投递火山重试队列并写入 retrylog', () => {
      const res = evaluateConsumerFallbackDecision({ taskType: 6, selmodelsId: 6, status: 7 });
      expect(res.fallbackAction).toBe('VOLCENGINE_RETRY_QUEUE');
      expect(res.targetLine).toBe(10);
      expect(res.targetQueue).toBe('video_panqu_retry_queue');
      expect(res.recordRetryLog).toBe(true);
    });

    it('非 SD 且非 wan3 模型失败直接报错中断，不进重试列表', () => {
      const res = evaluateConsumerFallbackDecision({ taskType: 99, selmodelsId: 999, status: 7 });
      expect(res.fallbackAction).toBe('DIRECT_FAIL_NO_RETRY');
      expect(res.recordRetryLog).toBe(false);
    });
  });

  describe('runPanquDiversionFlow - 全流程执行与产物生成', () => {
    it('在模拟 fixture 仓库中执行分流测试流程并生成完整产物', async () => {
      const root = await mkdtemp(path.join(await realpath(tmpdir()), 'panqu-divflow-'));
      roots.push(root);

      // 准备 PHP 契约文件 fixture
      await put(
        root,
        'aibaseos/application/admin/service/NewapiDiversionRuleService.php',
        `<?php
namespace app\\admin\\service;
class NewapiDiversionRuleService {
  public const LINE = 10;
  public function getGlobalModelIds() { return Db::name('model_config')->where('is_newapi_global', 1)->column('id'); }
}`,
      );

      await put(
        root,
        'aibaseos/application/admin/service/NewapiRouteService.php',
        `<?php
namespace app\\admin\\service;
class NewapiRouteService {
  public function resolveByGroupIds(array $groupIds) { return ['org_id' => 10, 'route_group' => []]; }
  public function isRouteGroupUsable(array $routeGroup) { return true; }
}`,
      );

      await put(
        root,
        'aibaseos/application/admin/service/NewapiImageDiversionService.php',
        `<?php
namespace app\\admin\\service;
class NewapiImageDiversionService {
  public const MAX_REFERENCE_IMAGES = 10;
  public function applySnapshot(array $extra, int $selmodelsId, string $serviceline, array $groupIds): array {
    $extra['newapi_image'] = 1;
    return $extra;
  }
}`,
      );

      await put(
        root,
        'aibaseos/application/admin/model/NewapiTaskLog.php',
        `<?php
namespace app\\admin\\model;
class NewapiTaskLog {
  const STATUS_INIT = 'INIT';
}`,
      );

      await put(
        root,
        'aibaseos/application/admin/controller/aivideo/Videonew.php',
        `<?php
namespace app\\admin\\controller\\aivideo;
use app\\admin\\service\\NewapiDiversionRuleService;
class Videonew {
  public function check_diversion(&$extra = [], int $videoType = 0) { return 10; }
}`,
      );

      await put(
        root,
        'aibaseos/application/route.php',
        `<?php
Route::get('aivideo/diversion', 'admin/aivideo.Diversion/index');
Route::get('aivideo/channel', 'admin/aivideo.Channel/index');`,
      );

      const outDir = path.join(root, 'output', 'divflow');
      const report = await runPanquDiversionFlow({
        projectRoot: root,
        outputDir: outDir,
      });

      expect(report.summary.total).toBe(28);
      expect(report.summary.pass).toBe(28);
      expect(report.summary.fail).toBe(0);
      expect(report.artifacts.reportJson).toContain('diversion-flow-report.json');
      expect(report.artifacts.reportMd).toContain('开发自测测试报告.md');
      expect(report.artifacts.casesMd).toContain('测试用例.md');
    });

    it.skipIf(!process.env.PANQU_SOURCE_FIXTURE_ROOT)('显式选择真实源码快照时执行完整源码诊断（非业务执行）', async () => {
      const realRoot = process.env.PANQU_SOURCE_FIXTURE_ROOT!;
      const report = await runPanquDiversionFlow({
        projectRoot: realRoot,
        outputDir: path.join(tmpdir(), 'real-panqu-flow-out'),
      });
      expect(report.summary.total).toBe(28);
      expect(report.summary.pass).toBe(28);
      expect(report.summary.fail).toBe(0);
      expect(report.summary.passRate).toBe('100%');
    }, 20000);

    it.skipIf(!process.env.PANQU_SOURCE_FIXTURE_ROOT)('显式选择匹配模型 84 的源码快照时输出定向诊断', async () => {
      const realRoot = process.env.PANQU_SOURCE_FIXTURE_ROOT!;
      const report = await runPanquDiversionFlow({
        projectRoot: realRoot,
        targetModelId: 84,
        outputDir: path.join(tmpdir(), 'real-panqu-flow-model84'),
      });
      expect(report.targetModelCheck).toBeDefined();
      expect(report.targetModelCheck?.modelId).toBe(84);
      expect(report.targetModelCheck?.readinessScore).toBe(100);
      expect(report.targetModelCheck?.modelAlias).toBe('wan3.0-video');
      expect(report.targetModelCheck?.isGlobalModel).toBe(true);
      expect(report.artifacts.reportMd).toBeDefined();
    }, 20000);
  });
});
