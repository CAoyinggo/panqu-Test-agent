import {
  createWorkflowFixtureApiSpecs,
  defineControlledServerScenario,
} from '../../../helpers/controlled-scenario-server.js';

const scenarioId = 'SCN-generic-multi-api-operation-binding';
const runId = 'controlled-workflow-run-a';
const taskId = `task-${runId}`;

export const serverScenario = defineControlledServerScenario({
  scenarioId,
  prepareHook: 'prepare-controlled-workflow',
  cleanupHook: 'cleanup-controlled-workflow',
  variables: {
    ACTOR_ID: 'controlled-workflow-actor',
    ACTOR_TOKEN_REF: 'LOCAL_FIXTURE_WORKFLOW_USER_TOKEN_REF',
    TENANT_ID: 'fixture-tenant-a',
    PROJECT_ID: 'fixture-project-a',
    RUN_ID: runId,
  },
  actorHeaders: {
    '${ACTOR_TOKEN_REF}': { Authorization: 'Bearer controlled-workflow-owner' },
  },
  identities: {
    'controlled-workflow-owner': {
      actorId: 'controlled-workflow-actor',
      tenantId: 'fixture-tenant-a',
      projectId: 'fixture-project-a',
    },
  },
  apiSpecs: createWorkflowFixtureApiSpecs({ scenarioId, runId, taskId }),
  fixture: {
    kind: 'WORKFLOW',
    runId,
    contentRef: 'fixture://payload/input-a.bin',
    uploadId: `upload-${runId}`,
    taskId,
    resultRef: `fixture://results/${taskId}`,
  },
  expectedOperationCount: 5,
  cleanupExpectation: {
    profiles: 0,
    payloads: 1,
    uploads: 1,
    tasks: 1,
    results: 1,
    total: 4,
    profileMutations: 0,
  },
});
