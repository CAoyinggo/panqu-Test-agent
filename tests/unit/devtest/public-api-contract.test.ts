import { describe, expect, expectTypeOf, it } from 'vitest';
import * as devtestIndex from '../../../src/devtest/index.js';
import * as coreKernel from '../../../src/devtest/core-kernel.js';

describe('Public API Contract & Package Entrypoint Tests', () => {
  it('[Contract-PublicAPI-1] Exploration runtime exports must exist and be defined', () => {
    expect(devtestIndex.PanquExplorationRunner).toBeDefined();
    expect(typeof devtestIndex.PanquExplorationRunner).toBe('function');

    expect(devtestIndex.runMutationCandidate).toBeDefined();
    expect(typeof devtestIndex.runMutationCandidate).toBe('function');

    expect(devtestIndex.PanquLearningStore).toBeDefined();
    expect(typeof devtestIndex.PanquLearningStore).toBe('function');

    expect(devtestIndex.extractLearningExperiences).toBeDefined();
    expect(typeof devtestIndex.extractLearningExperiences).toBe('function');

    expect(devtestIndex.buildActionHistoryCounts).toBeDefined();
    expect(typeof devtestIndex.buildActionHistoryCounts).toBe('function');

    expect(devtestIndex.feedResultIntoLearning).toBeDefined();
    expect(typeof devtestIndex.feedResultIntoLearning).toBe('function');
  });

  it('[Contract-PublicAPI-2] Core 4 actions must exist and preserve TypeScript signatures', () => {
    expect(typeof devtestIndex.probe).toBe('function');
    expect(typeof devtestIndex.plan).toBe('function');
    expect(typeof devtestIndex.execute).toBe('function');
    expect(typeof devtestIndex.verify).toBe('function');
    expect(typeof devtestIndex.executeCanonical).toBe('function');

    // Type-level signature assertions
    expectTypeOf(devtestIndex.probe).toEqualTypeOf<
      (options?: devtestIndex.ProbeKernelOptions) => Promise<devtestIndex.ProbeKernelResult>
    >();
    expectTypeOf(devtestIndex.plan).toEqualTypeOf<
      (options: devtestIndex.PlanKernelOptions) => Promise<devtestIndex.PlanKernelResult>
    >();
    expectTypeOf(devtestIndex.execute).toEqualTypeOf<
      (options: devtestIndex.ExecuteKernelOptions) => Promise<devtestIndex.ExecuteKernelResult>
    >();
    expectTypeOf(devtestIndex.verify).toEqualTypeOf<
      (options: devtestIndex.VerifyKernelOptions) => Promise<devtestIndex.VerifyKernelResult>
    >();
    expectTypeOf(devtestIndex.executeCanonical).toEqualTypeOf<
      (
        spec: Readonly<devtestIndex.CanonicalTestSpec>,
        dependencies: devtestIndex.ExecuteCanonicalDependencies,
      ) => Promise<devtestIndex.ExecuteKernelResult>
    >();
  });

  it('[Contract-PublicAPI-2b] Dist package entrypoint resolves correctly and provides runtime exports', async () => {
    const distPath = '../../../dist/src/devtest/index.js';
    const dist = await import(/* @vite-ignore */ distPath);
    expect(dist.PanquExplorationRunner).toBeDefined();
    expect(dist.PanquLearningStore).toBeDefined();
    expect(typeof dist.probe).toBe('function');
    expect(typeof dist.plan).toBe('function');
    expect(typeof dist.execute).toBe('function');
    expect(typeof dist.verify).toBe('function');
    expect(typeof dist.executeCanonical).toBe('function');
  });

  it('[Contract-PublicAPI-3] Internal verify() helpers must NOT be exported in core-kernel or index', () => {
    const internalHelpers = [
      'resolveVerifyContext',
      'collectTaskEvidence',
      'collectMediaEvidence',
      'collectBillingEvidence',
      'computeRegressionDiff',
      'buildDiffItems',
      'computeFinalVerdict',
    ];

    for (const helperName of internalHelpers) {
      expect((devtestIndex as any)[helperName]).toBeUndefined();
      expect((coreKernel as any)[helperName]).toBeUndefined();
    }
  });

  it('[Contract-PublicAPI-4] Key domain, routing, billing, and protocol symbols must be defined', () => {
    // Protocol
    expect(devtestIndex.validateCanonicalTestSpec).toBeDefined();
    expect(devtestIndex.validateEvidenceEnvelope).toBeDefined();
    expect(devtestIndex.evaluateCanonicalVerdict).toBeDefined();

    // Oracles
    expect(devtestIndex.RoutingOracle).toBeDefined();
    expect(devtestIndex.BillingOracle).toBeDefined();

    // Adapters & sinks
    expect(devtestIndex.UIBrowserEvidenceProducer).toBeDefined();
    expect(devtestIndex.UIVisualAiEvidenceProducer).toBeDefined();
    expect(devtestIndex.NdjsonResultSink).toBeDefined();
    expect(devtestIndex.mapVerdictToExportRecord).toBeDefined();

    // Trace & audit
    expect(devtestIndex.resolveRequirementTraceForSpec).toBeDefined();
    expect(devtestIndex.ABSORBED_CAPABILITIES_AUDIT).toBeDefined();
    expect(devtestIndex.DEVTEST_VERSION).toBeDefined();
  });
});
