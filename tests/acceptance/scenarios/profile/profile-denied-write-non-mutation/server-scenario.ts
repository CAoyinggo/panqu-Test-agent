import {
  createProfileFixtureApiSpecs,
  defineControlledServerScenario,
} from '../../../helpers/controlled-scenario-server.js';

const scenarioId = 'SCN-profile-denied-write-non-mutation';
const profileId = 'profile-denied-target';
const ownerActorId = 'profile-denied-owner';
const unauthorizedActorId = 'profile-denied-non-owner';

export const serverScenario = defineControlledServerScenario({
  scenarioId,
  prepareHook: 'prepare-profile-denied-write',
  cleanupHook: 'cleanup-profile-denied-write',
  variables: {
    TARGET_OWNER_ID: ownerActorId,
    TARGET_PROFILE_USER_ID: profileId,
    UNAUTHORIZED_ACTOR_ID: unauthorizedActorId,
    UNAUTHORIZED_ACTOR_TOKEN_REF: 'LOCAL_FIXTURE_USER_B_TOKEN_REF',
    UNAUTHORIZED_DISPLAY_NAME: 'unauthorized-change',
    TENANT_ID: 'fixture-tenant-a',
    PROJECT_ID: 'fixture-project-a',
  },
  actorHeaders: {
    '${UNAUTHORIZED_ACTOR_TOKEN_REF}': { Authorization: 'Bearer controlled-profile-non-owner' },
  },
  identities: {
    'controlled-profile-non-owner': {
      actorId: unauthorizedActorId,
      tenantId: 'fixture-tenant-a',
      projectId: 'fixture-project-a',
    },
  },
  apiSpecs: createProfileFixtureApiSpecs({
    scenarioId,
    profileId,
    observerReads: true,
    writeFields: ['displayName'],
    writeStatus: 403,
  }),
  fixture: {
    kind: 'PROFILE',
    profileId,
    ownerActorId,
    displayName: 'fixture-original-name',
    email: 'fixture-owner@example.test',
    role: 'MEMBER',
    tenantId: 'fixture-tenant-a',
    projectId: 'fixture-project-a',
  },
  expectedOperationCount: 3,
  cleanupExpectation: {
    profiles: 1,
    payloads: 0,
    uploads: 0,
    tasks: 0,
    results: 0,
    total: 1,
    profileMutations: 0,
  },
});
