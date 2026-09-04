/** 将通用占位模板物化为 Parser/Runner 的业务中立测试 fixture。 */
export function materializeScenarioTemplate(template: string, scenarioId = 'SCN-generic-persistence'): string {
  const replacements: Array<[string, string]> = [
    ['SCN-<domain>-<intent>', scenarioId],
    ['- <按风险选择 PERSISTENCE / NON_MUTATION / IDEMPOTENCY / AUTHORIZATION / ...>', '- PERSISTENCE'],
    ['<processor-ref-1>', 'api'], ['<processor-ref-2>', 'api'],
    ['<method-1>', 'POST'], ['<method-2>', 'GET'],
    ['<path-1>', '/api/resources'], ['<path-2>', '/api/resources/${STEP-001.resourceId}'],
    ['<request-ref-1>', '{"name":"${RESOURCE_NAME}"}'], ['<request-ref-2>', '-'],
    ['<capture-1>', 'resourceId=body.data.id'], ['<capture-2>', 'persistedName=body.data.name'],
    ['<target-ref-1>', 'status'], ['<operator-1>', 'EQUALS'], ['<expected-1>', '201'],
    ['<target-ref-2>', 'body.data.name'], ['<operator-2>', 'EQUALS'], ['<expected-from-2>', 'input.RESOURCE_NAME'],
    ['<prepare-hook-ref>', 'prepare-resource'], ['<cleanup-hook-ref>', 'cleanup-resource'],
    ['- <环境、服务、Processor、Evidence Provider；无则写 NONE>', '- NONE'],
  ];
  return replacements.reduce((value, [from, to]) => value.replace(from, to), template);
}
