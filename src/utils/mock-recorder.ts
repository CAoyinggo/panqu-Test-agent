// Mock 录制回放器：拦截 HTTP 请求，录制/回放 fixtures
// 通过 monkey-patch globalThis.fetch 实现，不依赖代理服务器
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { logger } from './logger.js';
import { ensureDir } from './fs-utils.js';

// ── 类型定义 ──

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

export interface RecordedResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: unknown;
  durationMs: number;
}

export interface Fixture {
  id: string;
  request: RecordedRequest;
  response: RecordedResponse;
  recordedAt: string;
  /** 路径模式（含通配符，如 /users/:id） */
  pathPattern?: string;
  /** 请求体 hash（用于匹配） */
  bodyHash?: string;
}

export interface RecordOptions {
  /** fixtures 存储目录 */
  fixturesDir: string;
  /** URL 过滤（只录制匹配的 URL） */
  urlFilter?: RegExp;
  /** 请求头过滤（不录制 cookie 等敏感头） */
  headerFilter?: string[];
  /** 路径通配规则 */
  pathWildcards?: Array<{ pattern: string; regex: RegExp }>;
}

export interface ReplayOptions {
  /** fixtures 目录 */
  fixturesDir: string;
  /** 匹配策略：strict（URL+方法+body hash）或 loose（URL+方法） */
  matchStrategy?: 'strict' | 'loose';
  /** 未匹配时的行为：passthrough（真实请求）/error（报错）/skip（返回空） */
  onMissing?: 'passthrough' | 'error' | 'skip';
  /** 路径通配规则 */
  pathWildcards?: Array<{ pattern: string; regex: RegExp }>;
}

// ── 工具函数 ──

function hashBody(body: unknown): string {
  if (body === undefined || body === null) return '';
  const str = typeof body === 'string' ? body : JSON.stringify(body);
  return crypto.createHash('sha256').update(str).digest('hex').slice(0, 16);
}

/** 将路径模式（/users/:id）转为正则 */
function pathPatternToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const withWildcards = escaped.replace(/:(\w+)/g, '([^/]+)');
  return new RegExp('^' + withWildcards + '/?$');
}

/** 将 URL 路径与通配模式匹配 */
function matchPath(url: string, patterns?: Array<{ pattern: string; regex: RegExp }>): string | undefined {
  if (!patterns) return undefined;
  // 提取 URL 路径部分
  let urlPath: string;
  try {
    const u = new URL(url);
    urlPath = u.pathname;
  } catch {
    urlPath = url;
  }

  for (const { pattern, regex } of patterns) {
    if (regex.test(urlPath)) return pattern;
  }
  return undefined;
}

/** 过滤敏感请求头 */
function filterHeaders(headers: Record<string, string>, filter?: string[]): Record<string, string> {
  if (!filter) return headers;
  const filtered: Record<string, string> = {};
  const lowerFilter = filter.map((h) => h.toLowerCase());
  for (const [key, value] of Object.entries(headers)) {
    if (!lowerFilter.includes(key.toLowerCase())) {
      filtered[key] = value;
    }
  }
  return filtered;
}

// ── RecordSession：录制模式 ──

export class RecordSession {
  private fixtures: Fixture[] = [];
  private originalFetch: typeof fetch;
  private options: RecordOptions;
  private recording = false;

  constructor(options: RecordOptions) {
    this.options = options;
    this.originalFetch = globalThis.fetch;

    // 预编译路径通配
    if (options.pathWildcards) {
      this.options.pathWildcards = options.pathWildcards.map((wc) => ({
        pattern: wc.pattern,
        regex: pathPatternToRegex(wc.pattern),
      }));
    }
  }

  /** 启动录制：monkey-patch fetch */
  start(): void {
    if (this.recording) return;
    this.recording = true;
    ensureDir(this.options.fixturesDir);

    const self = this;
    globalThis.fetch = async function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = (init?.method || 'GET').toUpperCase();

      // URL 过滤
      if (self.options.urlFilter && !self.options.urlFilter.test(url)) {
        return self.originalFetch(input as any, init);
      }

      const t0 = Date.now();

      // 真实请求
      const res = await self.originalFetch(input as any, init);
      const durationMs = Date.now() - t0;

      // 提取响应数据
      const cloned = res.clone();
      const respText = await cloned.text();
      let respBody: unknown;
      try {
        respBody = JSON.parse(respText);
      } catch {
        respBody = respText.slice(0, 5000);
      }

      // 提取请求头
      const reqHeaders: Record<string, string> = {};
      if (init?.headers) {
        const h = init.headers;
        if (h instanceof Headers) {
          h.forEach((v, k) => { reqHeaders[k] = v; });
        } else if (Array.isArray(h)) {
          for (const [k, v] of h) reqHeaders[k] = v;
        } else {
          Object.assign(reqHeaders, h);
        }
      }

      // 提取请求体
      let reqBody: unknown = undefined;
      if (init?.body) {
        if (typeof init.body === 'string') {
          try { reqBody = JSON.parse(init.body); } catch { reqBody = init.body.slice(0, 5000); }
        } else if (init.body instanceof FormData) {
          reqBody = '(FormData)';
        }
      }

      // 响应头
      const respHeaders: Record<string, string> = {};
      res.headers.forEach((v, k) => { respHeaders[k] = v; });

      // 路径匹配
      const pathPattern = matchPath(url, self.options.pathWildcards);

      const fixture: Fixture = {
        id: crypto.randomUUID(),
        request: {
          url,
          method,
          headers: filterHeaders(reqHeaders, self.options.headerFilter),
          body: reqBody,
        },
        response: {
          status: res.status,
          statusText: res.statusText,
          headers: filterHeaders(respHeaders, self.options.headerFilter),
          body: respBody,
          durationMs,
        },
        recordedAt: new Date().toISOString(),
        pathPattern,
        bodyHash: hashBody(reqBody),
      };

      self.fixtures.push(fixture);
      logger.debug(`  📹 录制: ${method} ${url} → ${res.status} (${durationMs}ms)`);

      return res;
    };

    logger.info(`🎬 Mock 录制已启动（fixtures → ${this.options.fixturesDir}）`);
  }

  /** 停止录制并保存 fixtures */
  stop(): Fixture[] {
    if (!this.recording) return this.fixtures;
    this.recording = false;
    globalThis.fetch = this.originalFetch;

    // 保存到文件
    const fixtureFile = path.join(this.options.fixturesDir, 'fixtures.json');
    fs.writeFileSync(fixtureFile, JSON.stringify(this.fixtures, null, 2), 'utf-8');
    logger.info(`⏹ Mock 录制已停止（共 ${this.fixtures.length} 条 fixtures → ${fixtureFile}）`);

    return this.fixtures;
  }

  /** 获取已录制的 fixtures */
  getFixtures(): Fixture[] {
    return this.fixtures;
  }
}

// ── ReplaySession：回放模式 ──

export class ReplaySession {
  private fixtures: Fixture[] = [];
  private originalFetch: typeof fetch;
  private options: ReplayOptions;
  private replaying = false;
  private matchCount = 0;
  private missCount = 0;

  constructor(options: ReplayOptions) {
    this.options = options;
    this.originalFetch = globalThis.fetch;

    // 预编译路径通配
    if (options.pathWildcards) {
      this.options.pathWildcards = options.pathWildcards.map((wc) => ({
        pattern: wc.pattern,
        regex: pathPatternToRegex(wc.pattern),
      }));
    }

    this.loadFixtures();
  }

  /** 加载 fixtures 文件 */
  private loadFixtures(): void {
    if (!fs.existsSync(this.options.fixturesDir)) {
      logger.warn(`⚠ fixtures 目录不存在: ${this.options.fixturesDir}`);
      return;
    }

    // 加载所有 fixtures.json
    const files = fs.readdirSync(this.options.fixturesDir).filter((f) => f.endsWith('.json'));
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(this.options.fixturesDir, file), 'utf-8'));
        if (Array.isArray(data)) {
          this.fixtures.push(...data);
        } else if (data.fixtures && Array.isArray(data.fixtures)) {
          this.fixtures.push(...data.fixtures);
        }
      } catch (e: any) {
        logger.warn(`⚠ 加载 fixtures 失败 ${file}: ${e.message}`);
      }
    }
    logger.info(`💾 Mock 回放已加载 ${this.fixtures.length} 条 fixtures`);
  }

  /** 匹配 fixture */
  private matchFixture(url: string, method: string, body?: unknown): Fixture | null {
    // 标准化 URL 路径
    let urlPath: string;
    try {
      urlPath = new URL(url).pathname + new URL(url).search;
    } catch {
      urlPath = url;
    }

    const strategy = this.options.matchStrategy || 'strict';
    const bodyHash = strategy === 'strict' ? hashBody(body) : undefined;

    for (const f of this.fixtures) {
      // 方法匹配
      if (f.request.method !== method) continue;

      // URL 匹配（支持通配）
      let urlMatch = false;
      if (f.pathPattern && this.options.pathWildcards) {
        // 使用通配匹配
        const pattern = this.options.pathWildcards.find((wc) => wc.pattern === f.pathPattern);
        if (pattern) {
          urlMatch = pattern.regex.test(urlPath.split('?')[0]);
        }
      } else {
        // 直接 URL 匹配（忽略查询参数中的时间戳）
        const fUrl = f.request.url.split('?')[0];
        const tUrl = url.split('?')[0];
        urlMatch = fUrl === tUrl;
      }

      if (!urlMatch) continue;

      // body hash 匹配（strict 模式）
      if (bodyHash && f.bodyHash && bodyHash !== f.bodyHash) continue;

      return f;
    }

    return null;
  }

  /** 启动回放：monkey-patch fetch */
  start(): void {
    if (this.replaying) return;
    this.replaying = true;

    const self = this;
    globalThis.fetch = async function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = (init?.method || 'GET').toUpperCase();

      // 提取请求体
      let reqBody: unknown = undefined;
      if (init?.body) {
        if (typeof init.body === 'string') {
          try { reqBody = JSON.parse(init.body); } catch { reqBody = init.body; }
        }
      }

      const fixture = self.matchFixture(url, method, reqBody);

      if (fixture) {
        self.matchCount++;
        const body = typeof fixture.response.body === 'string'
          ? fixture.response.body
          : JSON.stringify(fixture.response.body);

        logger.debug(`  ▶ 回放: ${method} ${url} → ${fixture.response.status} (fixture: ${fixture.id.slice(0, 8)})`);

        return new Response(body, {
          status: fixture.response.status,
          statusText: fixture.response.statusText,
          headers: fixture.response.headers,
        });
      }

      // 未匹配
      self.missCount++;
      logger.warn(`  ⚠ 未找到 fixture: ${method} ${url}`);

      switch (self.options.onMissing) {
        case 'error':
          throw new Error(`Mock fixture 未找到: ${method} ${url}`);
        case 'skip':
          return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
        case 'passthrough':
        default:
          return self.originalFetch(input as any, init);
      }
    };

    logger.info(`▶ Mock 回放已启动（策略: ${this.options.matchStrategy || 'strict'}）`);
  }

  /** 停止回放 */
  stop(): { matched: number; missed: number } {
    if (!this.replaying) return { matched: this.matchCount, missed: this.missCount };
    this.replaying = false;
    globalThis.fetch = this.originalFetch;
    logger.info(`⏹ Mock 回放已停止（命中 ${this.matchCount}，未命中 ${this.missCount}）`);
    return { matched: this.matchCount, missed: this.missCount };
  }
}

// ── 便捷工厂函数 ──

/** 创建录制会话 */
export function createRecordSession(fixturesDir: string, opts: Partial<RecordOptions> = {}): RecordSession {
  return new RecordSession({
    fixturesDir,
    headerFilter: ['cookie', 'authorization'],
    ...opts,
  });
}

/** 创建回放会话 */
export function createReplaySession(fixturesDir: string, opts: Partial<ReplayOptions> = {}): ReplaySession {
  return new ReplaySession({
    fixturesDir,
    matchStrategy: 'loose',
    onMissing: 'passthrough',
    ...opts,
  });
}
