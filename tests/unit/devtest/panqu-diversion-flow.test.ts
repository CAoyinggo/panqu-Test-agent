import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  evaluateDiversionDecision,
  runPanquDiversionFlow,
  type DiversionConfigSnapshot,
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

      expect(report.summary.total).toBe(21);
      expect(report.summary.pass).toBeGreaterThanOrEqual(20);
      expect(report.summary.fail).toBe(0);
      expect(report.artifacts.reportJson).toContain('diversion-flow-report.json');
      expect(report.artifacts.reportMd).toContain('开发自测测试报告.md');
      expect(report.artifacts.casesMd).toContain('测试用例.md');
    });

    it('可在实际 /Users/mac/agents/panqu-ai 仓库直接执行', async () => {
      const realRoot = '/Users/mac/agents/panqu-ai';
      const report = await runPanquDiversionFlow({
        projectRoot: realRoot,
        outputDir: path.join(tmpdir(), 'real-panqu-flow-out'),
      });
      expect(report.summary.total).toBe(21);
      expect(report.summary.pass).toBe(21);
      expect(report.summary.fail).toBe(0);
      expect(report.summary.passRate).toBe('100%');
    }, 20000);
  });
});
