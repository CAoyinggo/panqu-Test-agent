import {
  createProfileFixtureApiSpecs,
  defineControlledServerScenario,
} from '../../../helpers/controlled-scenario-server.js';

const scenarioId = 'SCN-profile-update-persistence';
const profileId = 'profile-persistence-user';
const actorId = 'profile-persistence-owner';

export const serverScenario = defineControlledServerScenario({
  scenarioId,
  prepareHook: 'prepare-profile-persistence',
  cleanupHook: 'cleanup-profile-persistence',
  variables: {
    ACTOR_ID: actorId,
    ACTOR_TOKEN_REF: 'LOCAL_FIXTURE_USER_A_TOKEN_REF',
    TENANT_ID: 'fixture-tenant-a',
    PROJECT_ID: 'fixture-project-a',
    PROFILE_USER_ID: profileId,
    PROFILE_DISPLAY_NAME: 'fixture-updated-name',
  },
  actorHeaders: {
    '${ACTOR_TOKEN_REF}': { Authorization: 'Bearer controlled-profile-owner' },
  },
  identities: {
    'controlled-profile-owner': {
      actorId,
      tenantId: 'fixture-tenant-a',
      projectId: 'fixture-project-a',
    },
  },
  apiSpecs: createProfileFixtureApiSpecs({
    scenarioId,
    profileId,
    observerReads: false,
    writeFields: ['displayName'],
    writeStatus: 200,
  }),
  fixture: {
    kind: 'PROFILE',
    profileId,
    ownerActorId: actorId,
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
    profileMutations: 1,
  },
});
