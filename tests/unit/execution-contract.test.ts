import { afterEach, describe, expect, it } from 'vitest';
import { toCanonicalSceneId } from '../../src/core/canonical-scene.js';
import { evaluateCoreExecution } from '../../src/core/execution-status.js';
import { findHandler, registerScene, SCENES, type RunTaskResult } from '../../src/core/engine.js';
import { VideoSceneHandler } from '../../src/plugins/scenes/video.js';
import { normalizeTestCase, toLoadedCase, toTaskDef } from '../../src/agents/test-design/testcase-schema.js';
import { caseResultFromEngine } from '../../src/agents/execution/execution-run-tool.js';
import { computeOutcome } from '../../src/agents/execution/execution-schema.js';

const passingCheck = { name: 'taskId', pass: true, detail: '任务已真实提交', level: 'P0' as const };

function videoCase(assertions: unknown[] = [{ target: 'submit', path: 'taskId', operator: 'exists' }]) {
  return normalizeTestCase({
    id: 'tc-video-1',
    feature: 'wan3',
    name: 'video canonical contract',
    priority: 'P0',
    tags: ['P0'],
    steps: [{ action: 'submit', scene: 'video', input: { prompt: 'hello' } }],
    assertions,
  });
}

afterEach(() => {
  for (const key of Object.keys(SCENES)) delete SCENES[key];
});

describe('DSL → Canonical Scene → Processor → Runner → Result 契约', () => {
  it('video 被归一化并路由到明确支持 video 的 Processor，真实执行和断言通过才 PASS', () => {
    const tc = videoCase();
    const def = toTaskDef(tc);
    expect(def.scene).toBe('video');
    expect(toCanonicalSceneId(def.scene)).toBe('video');

    const processor = new VideoSceneHandler();
    expect(processor.supportedScenes).toEqual(['video']);
    expect(processor.supports('video')).toBe(true);
    registerScene(processor.name, processor);
    expect(findHandler(def.scene)).toBe(processor);

    const core = evaluateCoreExecution({ hasProcessor: true, processorInvoked: true, checks: [passingCheck] });
    expect(core).toMatchObject({ executed: true, status: 'PASS', passRate: 100 });

    const result = caseResultFromEngine(toLoadedCase(tc), {
      files: [], checks: [passingCheck], executed: true, status: 'PASS', passRate: 100, hasBlockingIssue: false,
    }, 10);
    expect(result).toMatchObject({ executed: true, status: 'PASS', pass: true, passRate: 100 });
  });

  it('unsupported scene 无法转成 canonical ID，也不能误路由到已注册 Processor', () => {
    const tc = normalizeTestCase({
      id: 'tc-audio-1', feature: 'audio', name: 'unsupported audio scene', priority: 'P0', tags: ['P0'],
      steps: [{ action: 'submit', scene: 'audio', input: { prompt: 'hello' } }],
      assertions: [{ target: 'submit', path: 'taskId', operator: 'exists' }],
    });
    const def = toTaskDef(tc);
    expect(def.scene).toBe('audio');
    expect(toCanonicalSceneId(def.scene)).toBeNull();

    registerScene('video', new VideoSceneHandler());
    expect(findHandler(def.scene)).toBeNull();
    expect(evaluateCoreExecution({ hasProcessor: false, processorInvoked: false, checks: [] }))
      .toMatchObject({ executed: false, status: 'NOT_EXECUTED', passRate: 0 });
  });

  it('Processor 不存在时统一 NOT_EXECUTED，绝不 PASS', () => {
    expect(findHandler('video')).toBeNull();
    const core = evaluateCoreExecution({ hasProcessor: false, processorInvoked: false, checks: [] });
    expect(core).toMatchObject({ executed: false, status: 'NOT_EXECUTED', passRate: 0 });

    const engineResult: RunTaskResult = {
      files: [], checks: [], executed: false, status: 'NOT_EXECUTED', passRate: 0, hasBlockingIssue: true,
    };
    const result = caseResultFromEngine(toLoadedCase(videoCase()), engineResult, 1);
    expect(result).toMatchObject({ executed: false, status: 'NOT_EXECUTED', pass: false, passRate: 0 });
  });

  it('Processor 已匹配但未实际调用时统一 NOT_EXECUTED，绝不 PASS', () => {
    const core = evaluateCoreExecution({ hasProcessor: true, processorInvoked: false, checks: [passingCheck] });
    expect(core).toMatchObject({ executed: false, status: 'NOT_EXECUTED', passRate: 0 });

    const outcome = computeOutcome('wan3', [{
      caseId: 'not-run', name: 'not-run', executed: false, status: 'NOT_EXECUTED', pass: true, passRate: 100,
    }]);
    expect(outcome).toMatchObject({ executed: false, passed: 0, failed: 1, passRate: 0 });
    expect(outcome.results[0]).toMatchObject({ pass: false, passRate: 0, status: 'NOT_EXECUTED' });
  });

  it('真实调用但没有有效断言时统一 BLOCKED，绝不默认 PASS', () => {
    expect(toTaskDef(videoCase([])).assert).toBeUndefined();
    const core = evaluateCoreExecution({ hasProcessor: true, processorInvoked: true, checks: [] });
    expect(core).toMatchObject({ executed: true, status: 'BLOCKED', passRate: 0 });

    const result = caseResultFromEngine(toLoadedCase(videoCase([])), {
      files: [], checks: [], executed: true, status: 'BLOCKED', passRate: 0, hasBlockingIssue: true,
    }, 1);
    expect(result).toMatchObject({ executed: true, status: 'BLOCKED', pass: false, passRate: 0 });
  });

  it('Processor 执行被阻断或抛错时统一 BLOCKED，绝不进入 PASS', () => {
    const core = evaluateCoreExecution({
      hasProcessor: true,
      processorInvoked: true,
      error: new Error('Processor 被执行策略阻断'),
      checks: [passingCheck],
    });
    expect(core).toMatchObject({ executed: false, status: 'BLOCKED', passRate: 0 });

    const result = caseResultFromEngine(toLoadedCase(videoCase()), {
      files: [], checks: [passingCheck], executed: false, status: 'BLOCKED', passRate: 0, hasBlockingIssue: true,
    }, 1);
    expect(result).toMatchObject({ executed: false, status: 'BLOCKED', pass: false, passRate: 0 });
  });
});
