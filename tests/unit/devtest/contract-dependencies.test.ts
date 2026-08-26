import { describe, expect, it } from 'vitest';
import { createPhase1ContractResolver } from '../../../src/contracts/seed-contracts.js';
import { discoverReferencedContractDependencies } from '../../../src/devtest/contract-dependencies.js';

describe('DevTest referenced Contract dependencies', () => {
  it('按 Registry identity 识别 Wan3/Workflow/VideoHub，且不猜 Method/Path', () => {
    const dependencies = discoverReferencedContractDependencies(
      'Wan3 使用 Workflow qnck，通过 VideoHub submit 提交任务。',
      createPhase1ContractResolver(),
    );
    expect(dependencies.map((item) => item.contractId)).toEqual(expect.arrayContaining([
      'model.wan3', 'enum.wan3.workflow', 'api.videohub.submit',
    ]));
    expect(dependencies.find((item) => item.contractId === 'api.videohub.submit')?.fingerprint).toBeTruthy();
  });

  it('未提及的 Contract 不会自动附加', () => {
    expect(discoverReferencedContractDependencies('普通用户资料需求', createPhase1ContractResolver())).toEqual([]);
  });
});
