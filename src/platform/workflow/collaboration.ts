// Collaboration（Phase 39.5）：Comment / Mention / Assignment / Watcher
// 失败 Case 上 QA 可以 @user 并产生通知（复用平台 Notification Channel）。
// 资源类型：run / case / suite / plan。

import type { Entity, Repository } from '../storage/repository.js';
import { generateEntityId } from '../storage/repository.js';

export type CollaborationResourceType = 'run' | 'case' | 'suite' | 'plan';

/** 单条评论 */
export interface CommentEntry {
  commentId: string;
  author: string;
  body: string;
  /** 从正文解析的 @user 列表 */
  mentions: string[];
  createdAt: string;
}

/** 协作条目（每 资源类型+资源 id 一条聚合） */
export interface CollaborationItem extends Entity {
  id: string;
  resourceType: CollaborationResourceType;
  resourceId: string;
  projectId: string;
  comments: CommentEntry[];
  assignees: string[];
  watchers: string[];
  createdAt: string;
  updatedAt: string;
}

/** 解析正文中的 @mention（@username 或 @user:xxx） */
export function parseMentions(body: string): string[] {
  const matches = body.match(/@([\w.-]+)/g) ?? [];
  return [...new Set(matches.map((m) => m.slice(1)))];
}

export class CollaborationService {
  constructor(private readonly repo: Repository<CollaborationItem>) {}

  /** 获取（不存在则创建聚合项） */
  async ensure(resourceType: CollaborationResourceType, resourceId: string, projectId: string): Promise<CollaborationItem> {
    const existing = await this.repo.get(`collab-${resourceType}-${resourceId}`);
    if (existing) return existing;
    const now = new Date().toISOString();
    const item: CollaborationItem = {
      id: `collab-${resourceType}-${resourceId}`,
      resourceType,
      resourceId,
      projectId,
      comments: [],
      assignees: [],
      watchers: [],
      createdAt: now,
      updatedAt: now,
    };
    await this.repo.create(item);
    return item;
  }

  async get(resourceType: CollaborationResourceType, resourceId: string): Promise<CollaborationItem | null> {
    return this.repo.get(`collab-${resourceType}-${resourceId}`);
  }

  async list(filter?: Partial<CollaborationItem>): Promise<CollaborationItem[]> {
    return this.repo.query(filter ?? {});
  }

  /** 添加评论（解析 @mention 返回被提及用户） */
  async addComment(input: {
    resourceType: CollaborationResourceType;
    resourceId: string;
    projectId: string;
    author: string;
    body: string;
    now?: () => string;
  }): Promise<{ item: CollaborationItem; mentions: string[] }> {
    const item = await this.ensure(input.resourceType, input.resourceId, input.projectId);
    const now = input.now ? input.now() : new Date().toISOString();
    const mentions = parseMentions(input.body);
    const comment: CommentEntry = {
      commentId: generateEntityId('comment'),
      author: input.author,
      body: input.body,
      mentions,
      createdAt: now,
    };
    const updated: CollaborationItem = {
      ...item,
      comments: [...item.comments, comment],
      updatedAt: now,
    };
    await this.repo.update(updated.id, updated);
    return { item: updated, mentions };
  }

  /** 列表评论 */
  async comments(resourceType: CollaborationResourceType, resourceId: string): Promise<CommentEntry[]> {
    const item = await this.get(resourceType, resourceId);
    return item?.comments ?? [];
  }

  /** 指派 */
  async assign(input: {
    resourceType: CollaborationResourceType;
    resourceId: string;
    projectId: string;
    assignees: string[];
  }): Promise<CollaborationItem> {
    const item = await this.ensure(input.resourceType, input.resourceId, input.projectId);
    const updated: CollaborationItem = {
      ...item,
      assignees: [...new Set(input.assignees)],
      updatedAt: new Date().toISOString(),
    };
    await this.repo.update(updated.id, updated);
    return updated;
  }

  /** 关注 / 取消关注 */
  async setWatcher(input: {
    resourceType: CollaborationResourceType;
    resourceId: string;
    projectId: string;
    user: string;
    watching: boolean;
  }): Promise<CollaborationItem> {
    const item = await this.ensure(input.resourceType, input.resourceId, input.projectId);
    const watchers = input.watching
      ? [...new Set([...item.watchers, input.user])]
      : item.watchers.filter((w) => w !== input.user);
    const updated: CollaborationItem = { ...item, watchers, updatedAt: new Date().toISOString() };
    await this.repo.update(updated.id, updated);
    return updated;
  }

  async count(): Promise<number> {
    return this.repo.count();
  }
}
