// Autonomous Release → CI/CD 模块统一导出（Phase 23.4）
export {
  releaseExitCode,
  buildReleaseDecision,
  writeReleaseDecision,
  readReleaseDecisionFile,
  loadReleaseDecision,
  latestReleaseDecision,
  releaseDecisionPath,
  type ReleaseVerdict,
  type ReleaseCheck,
  type Evidence,
  type ReleaseDecision,
  type ReleaseContractInput,
} from './release-ci.js';

export type { ReleaseDecisionInput } from '../release-decision/index.js';
