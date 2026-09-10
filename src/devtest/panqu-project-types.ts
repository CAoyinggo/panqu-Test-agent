/** Project observations are implementation evidence, never confirmed product requirements. */
export interface PanquSourceRef { file: string; line: number; sha256: string }

export type PanquHost = 'NUXT_VUE_FLOW' | 'NEXT_XYFLOW' | 'UNKNOWN' | 'AMBIGUOUS' | 'PANQU_HYBRID_MONOREPO' | 'THINKPHP_BACKEND';
export type PanquBodyKind = 'NONE' | 'JSON' | 'FORM_DATA' | 'UNKNOWN';
export type PanquResponseProtocol = 'PHP_CODE_1' | 'GO_HTTP_200' | 'NEST_JSON' | 'UNVERIFIED';

export interface PanquSourceAction {
  id: string;
  symbol: string;
  wrapper: string;
  method?: string;
  methodBasis: 'EXPLICIT' | 'VERIFIED_WRAPPER_DEFAULT' | 'UNRESOLVED';
  path?: string;
  body: PanquBodyKind;
  responseProtocol: PanquResponseProtocol;
  source: PanquSourceRef;
  wrapperSource?: PanquSourceRef;
  unresolved: string[];
}

export interface PanquProjectContext {
  schema: 'panqu.project.v1';
  provenance: 'SOURCE_OBSERVATION_ONLY';
  host: PanquHost;
  fingerprint: string;
  complete: boolean;
  sources: Array<PanquSourceRef & { imports: string[]; exports: string[] }>;
  actions: PanquSourceAction[];
  nodes: Array<{ kind: string; source: PanquSourceRef }>;
  changedFiles: string[];
  affectedFiles: string[];
  submodules?: string[];
  regressionCandidates: Array<{ file: string; status: 'NOT_EXECUTED'; evidenceLevel: 'SOURCE_CONTRACT' | 'UNCLASSIFIED_LOCAL_TEST' }>;
  diagnostics: Array<{ code: string; file?: string; message: string }>;
}

export interface PanquProjectAssessment {
  sourceDiagnostics: PanquProjectContext['diagnostics'];
  overview: { inspectedFiles: number; requestCallSites: number; nodeKinds: string[] };
  host: PanquHost;
  submodules?: string[];
  fingerprint: string;
  provenance: 'SOURCE_OBSERVATION_ONLY';
  relevantActions: PanquSourceAction[];
  blockers: Array<{ code: string; message: string; operationKey?: string }>;
  regressionCandidates: PanquProjectContext['regressionCandidates'];
  limitations: string[];
}
