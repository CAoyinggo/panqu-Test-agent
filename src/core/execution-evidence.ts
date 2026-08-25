/** 断言证据分类。只有 BUSINESS 能决定测试业务是否通过。 */
export type AssertionKind = 'BUSINESS' | 'INFORMATIONAL' | 'TEARDOWN' | 'SYSTEM' | 'SKIPPED';

export interface AssertionEvidenceLike {
  name?: string;
  pass: boolean;
  kind?: AssertionKind;
}

/**
 * 兼容旧断言：未显式分类的历史业务断言按 BUSINESS 处理；已知 teardown 名称
 * 仍强制归为 TEARDOWN，避免旧数据在迁移期间参与 PASS。
 */
export function assertionKindOf(assertion: AssertionEvidenceLike): AssertionKind {
  if (assertion.kind) return assertion.kind;
  if (/^执行后核对[:：]/.test(assertion.name ?? '')) return 'TEARDOWN';
  return 'BUSINESS';
}

/** 唯一可以参与 PASS 的有效业务断言集合。 */
export function effectiveAssertions<T extends AssertionEvidenceLike>(assertions: readonly T[] | undefined): T[] {
  return (assertions ?? []).filter((assertion) => assertionKindOf(assertion) === 'BUSINESS');
}

/** 断言证据是否足以支持 PASS（执行/Processor 条件由调用方另行提供）。 */
export function businessAssertionsPassed(assertions: readonly AssertionEvidenceLike[] | undefined): boolean {
  const effective = effectiveAssertions(assertions);
  return effective.length > 0 && effective.every((assertion) => assertion.pass);
}
