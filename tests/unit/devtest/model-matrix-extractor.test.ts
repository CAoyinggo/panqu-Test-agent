import { describe, expect, it } from 'vitest';
import { ModelMatrixExtractor } from '../../../src/devtest/model-matrix-extractor.js';

describe('ModelMatrixExtractor - 业务模型规格逆向提取器', () => {
  it('提取全部核心模型规格，包含视频与图片模型', async () => {
    const all = await ModelMatrixExtractor.extractAll();

    expect(Object.keys(all).length).toBeGreaterThanOrEqual(7);

    // Wan 3.0 (84)
    expect(all[84]).toBeDefined();
    expect(all[84].mediaType).toBe('video');
    expect(all[84].supportedResolutions).toEqual(['480p', '720p', '1080p']);
    expect(all[84].supportedAspectRatios).toContain('16:9');
    expect(all[84].supportedAspectRatios).toContain('9:16');

    // Wan 3.0 Prime (88)
    expect(all[88]).toBeDefined();
    expect(all[88].alias).toBe('wan3.0-prime');
    expect(all[88].flowType).toBe('DIRECT');

    // Seedance 2.5 (78)
    expect(all[78]).toBeDefined();
    expect(all[78].durationRange).toEqual([4, 12]);

    // Image 2.5 Flare Economy (901)
    expect(all[901]).toBeDefined();
    expect(all[901].mediaType).toBe('image');
    expect(all[901].flowType).toBe('DIRECT');
    expect(all[901].supportedAspectRatios.length).toBe(15);
  });

  it('提取单个模型规格并生成正交参数用例集合', async () => {
    const spec = await ModelMatrixExtractor.extractModel(84);
    expect(spec).toBeDefined();
    if (!spec) return;

    expect(spec.modelName).toBe('Wan 3.0');
    expect(spec.alias).toBe('wan3.0-video');

    const scenarios = ModelMatrixExtractor.generateSpecMatrixScenarios(spec);
    expect(scenarios.length).toBeGreaterThanOrEqual(3);
    expect(scenarios.every((s) => s.resolution && s.aspectRatio)).toBe(true);
    expect(scenarios.some((s) => s.resolution === '720p')).toBe(true);
  });
});
