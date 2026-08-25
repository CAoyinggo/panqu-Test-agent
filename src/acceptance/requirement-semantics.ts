export type AccessPolarity = 'ALLOW' | 'DENY' | 'UNKNOWN';

const DENY = /(?:无权|没有权利|没有权限|无权限|不允许|不可以|不可|不能|不得|禁止|应当被阻止|应该被阻止|必须被阻止|应当拒绝|应该拒绝|必须拒绝|被拒绝|被阻止|越权|forbidden|denied|deny|must\s+not|should\s+not|cannot|can\s*not|may\s+not|not\s+allowed|isn['’]?t\s+allowed)/i;
const ALLOW = /(?:有权|有权限|允许|可以|可(?:以)?(?:访问|查看|修改|删除|操作)|allowed|permitted|has\s+permission|\bcan\b|\bmay\b)/i;
const ACCESS_ACTION = /(?:权限|权利|访问|查看|读取|修改|编辑|删除|创建|操作|管理|数据|订单|资源|记录|permission|access|read|view|update|edit|delete|create|manage|record|resource|order|data)/i;

/** Canonical permission polarity shared by design, binding and Case routing. */
export function accessPolarity(text: string): AccessPolarity {
  if (DENY.test(text)) return 'DENY';
  if (ALLOW.test(text)) return 'ALLOW';
  return 'UNKNOWN';
}

export function hasAccessControlSemantics(text: string): boolean {
  return accessPolarity(text) !== 'UNKNOWN' && ACCESS_ACTION.test(text);
}
