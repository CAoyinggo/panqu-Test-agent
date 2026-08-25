// Canonical Scene：DSL、Processor 与 Runner 之间唯一使用的场景标识。
// 历史中文 scene 仅作为输入别名，进入执行链路前必须归一化。

export const CANONICAL_SCENE_IDS = ['video', 'api'] as const;

export type CanonicalSceneId = (typeof CANONICAL_SCENE_IDS)[number];

/** 将 DSL/历史用例中的 scene 归一化为 canonical ID；未知场景返回 null。 */
export function toCanonicalSceneId(scene: string | undefined | null): CanonicalSceneId | null {
  const value = String(scene ?? '').trim().toLowerCase();
  if (!value) return null;
  if (value === 'video') return 'video';
  if (value === 'api' || value === 'http') return 'api';
  if (/文生视频|图生视频|全能参考|首尾帧|视频生成/.test(value)) return 'video';
  return null;
}

export function isCanonicalSceneId(scene: string): scene is CanonicalSceneId {
  return (CANONICAL_SCENE_IDS as readonly string[]).includes(scene);
}
