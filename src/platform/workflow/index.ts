// Workflow 模块门面（Phase 39）：QA Workbench 统一出口
// 聚合 Suite / Plan / Template / Versioning / Collaboration / Report / QA Home。
// 经 PlatformService 注入，API 与 CLI 共用（禁止维护两套逻辑）。

import { TestSuiteService } from './test-suite.js';
import { TestPlanService } from './test-plan.js';
import { RunTemplateService } from './run-template.js';
import { AssetVersioningService } from './asset-versioning.js';
import { CollaborationService } from './collaboration.js';
import { RunReportService } from './run-report.js';
import { QaHomeService } from './qa-home.js';

export { TestSuiteService, type TestSuite, type CreateSuiteInput, type TestSuiteStatus } from './test-suite.js';
export { TestPlanService, type TestPlan, type CreatePlanInput, type TestPlanMode } from './test-plan.js';
export { RunTemplateService, type RunTemplate, type CreateTemplateInput, type RunConfigSource } from './run-template.js';
export { AssetVersioningService, type AssetVersion, type AssetDiff, type AssetVersionSummary, type AssetType } from './asset-versioning.js';
export { CollaborationService, type CollaborationItem, type CommentEntry, type CollaborationResourceType, parseMentions } from './collaboration.js';
export { RunReportService, type RunReportSummary, type RunShare, type ReportRisk } from './run-report.js';
export { QaHomeService, type QaHome, type ActionItem } from './qa-home.js';

export interface WorkflowServiceDeps {
  suites: TestSuiteService;
  plans: TestPlanService;
  templates: RunTemplateService;
  versions: AssetVersioningService;
  collaboration: CollaborationService;
  reports: RunReportService;
  qaHome: QaHomeService;
}

export class WorkflowService {
  constructor(public readonly deps: WorkflowServiceDeps) {}

  get suites(): TestSuiteService {
    return this.deps.suites;
  }
  get plans(): TestPlanService {
    return this.deps.plans;
  }
  get templates(): RunTemplateService {
    return this.deps.templates;
  }
  get versions(): AssetVersioningService {
    return this.deps.versions;
  }
  get collaboration(): CollaborationService {
    return this.deps.collaboration;
  }
  get reports(): RunReportService {
    return this.deps.reports;
  }
  get qaHome(): QaHomeService {
    return this.deps.qaHome;
  }
}
