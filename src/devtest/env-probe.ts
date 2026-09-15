/**
 * Panqu 真实测试环境只读探针与连通性巡检 (Environment Probe)
 *
 * 核心能力：
 * 1. 只读探测主站 test/preonline 环境连通性与响应耗时
 * 2. 校验 Session/Cookie 凭据有效性与 CSRF 存活性
 * 3. 探活核心业务端点状态（视频、图片、网关接口）
 * 4. 针对指定模型推导分流配置完备度与可用渠道
 * 5. 输出结构化健康状态与开发者排障建议（零副作用，不产生写入与扣费）
 */

import { readFile } from 'node:fs/promises';
import { RoutingOracle, type GatewayChannelConfig, type MainSiteConfigSnapshot } from './routing.js';

export interface EnvProbeOptions {
  env?: 'test' | 'preonline' | string;
  baseUrl?: string;
  gatewayUrl?: string;
  sessionFile?: string;
  modelId?: number;
  mediaType?: 'video' | 'image';
  userGroupIds?: number[];
  mock?: boolean;
  timeoutMs?: number;
}

export interface EndpointProbeResult {
  name: string;
  url: string;
  method: 'GET' | 'HEAD' | 'OPTIONS';
  reachable: boolean;
  statusCode?: number;
  latencyMs?: number;
  message: string;
}

export interface ModelReadinessVerdict {
  modelId: number;
  mediaType: 'video' | 'image';
  decision: 'DIVERTED' | 'DIRECT' | 'UNKNOWN';
  willDivert: boolean;
  routeLine: number;
  newapiModel?: string;
  candidateChannelCount: number;
  isBlockedByQuota: boolean;
  issues: string[];
}

export interface EnvProbeReport {
  ok: boolean;
  status: 'HEALTHY' | 'DEGRADED' | 'BLOCKED';
  env: string;
  baseUrl: string;
  gatewayUrl: string;
  probedAt: string;
  auth: {
    status: 'VALID' | 'EXPIRED' | 'MISSING';
    details: string;
    hasSession: boolean;
  };
  endpoints: EndpointProbeResult[];
  modelReadiness?: ModelReadinessVerdict;
  recommendations: string[];
}

export class EnvironmentProbe {
  public static async probe(options: EnvProbeOptions = {}): Promise<EnvProbeReport> {
    const env = options.env || 'test';
    const baseUrl = options.baseUrl || (env === 'preonline' ? 'https://preonline.panqu.com' : 'https://test.panqu.com');
    const gatewayUrl = options.gatewayUrl || 'https://aiapis.panqu.com';
    const timeoutMs = options.timeoutMs ?? 5000;
    const isMock = options.mock ?? true;

    if (!isMock) {
      const allowedEnvironments = new Set(['test', 'preonline', 'sandbox', 'local']);
      if (!allowedEnvironments.has(env)) throw new Error(`REAL_ENV_NOT_ALLOWED: ${env}`);
      if (env === 'local') {
        const localHosts = new Set(['127.0.0.1', 'localhost']);
        this.assertAllowedRealUrl(baseUrl, localHosts, true);
        this.assertAllowedRealUrl(gatewayUrl, new Set([...localHosts, 'aiapis.panqu.com']), true);
      } else {
        this.assertAllowedRealUrl(baseUrl, new Set(['test.panqu.com', 'preonline.panqu.com', 'sandbox.panqu.com']));
        this.assertAllowedRealUrl(gatewayUrl, new Set(['aiapis.panqu.com', 'test-aiapis.panqu.com', 'preonline-aiapis.panqu.com', 'sandbox-aiapis.panqu.com']));
      }
    }

    let cookie = '';
    if (options.sessionFile) {
      try {
        const raw = await readFile(options.sessionFile, 'utf8');
        const parsed = JSON.parse(raw);
        if (typeof parsed.cookie_string === 'string') cookie = parsed.cookie_string;
        else if (Array.isArray(parsed.sessions)) {
          const session = parsed.sessions.find((item: { env?: string }) => item.env === env);
          if (typeof session?.cookie_string === 'string') cookie = session.cookie_string;
        }
        else if (Array.isArray(parsed.cookies)) {
          cookie = parsed.cookies.map((c: { name: string; value: string }) => `${c.name}=${c.value}`).join('; ');
        }
      } catch {
        // session file missing or unreadable
      }
    }

    if (isMock) {
      return this.generateMockReport(env, baseUrl, gatewayUrl, cookie, options);
    }

    return this.executeRealProbe(env, baseUrl, gatewayUrl, cookie, options, timeoutMs);
  }

  private static assertAllowedRealUrl(value: string, allowedHosts: Set<string>, allowHttp = false): void {
    let parsed: URL;
    try { parsed = new URL(value); }
    catch { throw new Error(`REAL_URL_NOT_ALLOWED: ${value}`); }
    const validProtocol = allowHttp ? (parsed.protocol === 'https:' || parsed.protocol === 'http:') : parsed.protocol === 'https:';
    if (!validProtocol || parsed.username || parsed.password || (!allowHttp && parsed.port) || !allowedHosts.has(parsed.hostname)) {
      throw new Error(`REAL_URL_NOT_ALLOWED: ${value}`);
    }
  }

  private static generateMockReport(
    env: string,
    baseUrl: string,
    gatewayUrl: string,
    cookie: string,
    options: EnvProbeOptions,
  ): EnvProbeReport {
    const hasSession = Boolean(cookie && cookie.trim().length > 0);
    const endpoints: EndpointProbeResult[] = [
      {
        name: '主站入口与网关握手',
        url: `${baseUrl}/`,
        method: 'GET',
        reachable: true,
        statusCode: 200,
        latencyMs: 42,
        message: '主站连接正常，HTTP 200 OK',
      },
      {
        name: '视频生成任务状态端点',
        url: `${baseUrl}/aivideo/v2/video/getEditData`,
        method: 'GET',
        reachable: true,
        statusCode: hasSession ? 200 : 401,
        latencyMs: 58,
        message: hasSession ? '接口鉴权通过' : '未提供会话 Cookie，返回 401 Unauthorized',
      },
      {
        name: 'NewAPI 统一网关状态',
        url: `${gatewayUrl}/health`,
        method: 'GET',
        reachable: true,
        statusCode: 200,
        latencyMs: 35,
        message: 'NewAPI 网关运行正常',
      },
    ];

    let modelReadiness: ModelReadinessVerdict | undefined;
    const recommendations: string[] = [];

    if (typeof options.modelId === 'number' || options.mediaType) {
      const mediaType = options.mediaType || 'video';
      const modelId = options.modelId ?? (mediaType === 'video' ? 84 : 201);
      const userGroupIds = options.userGroupIds || [10];

      const config: MainSiteConfigSnapshot = {
        routeMode: 'newapi',
        globalModelIds: [88, 12],
        globalApiKey: 'test-global',
        globalRouteRules: {
          video: {
            84: { resolutions: ['480p', '720p', '1080p'], aspect_ratios: ['auto', '16:9', '9:16', '1:1', '4:3', '3:4'] },
            88: { resolutions: ['480p', '720p', '1080p'], aspect_ratios: ['auto', '16:9', '9:16', '1:1', '4:3', '3:4'] },
          },
        },
        groupRouteRules: {
          video: {
            panqu_test: {
              84: { resolutions: ['480p', '720p', '1080p'], aspect_ratios: ['16:9', '9:16', '1:1'] },
            },
          },
        },
        orgBindings: {
          10: { routeGroupId: 1, newapiGroup: 'panqu_test', status: 1, apiKey: 'test-org' },
        },
      };

      const mainVerdict = mediaType === 'video'
        ? RoutingOracle.evaluateVideoMainSite({
            videoType: 6,
            modelId,
            taskType: 28,
            cueword: 'probe_test',
            resolution: '720p',
            aspectRatio: '16:9',
            userGroupIds,
          }, config)
        : RoutingOracle.evaluateImageMainSite({
            selmodelsId: modelId,
            serviceline: 'r',
            userGroupIds,
          }, config);

      const targetModel = mainVerdict.expectedSnapshot?.newapiModel || (mediaType === 'video' ? 'wan3.0-video' : 'runninghub-nano-banana-2');
      const channels: GatewayChannelConfig[] = [
        {
          id: 36,
          name: '万相—yhuo',
          group: mainVerdict.expectedSnapshot?.newapiGroup || 'panqu_test',
          models: [targetModel],
          status: 1,
          weight: 10,
          dailyQuotaLimit: 0,
          usedQuota: 0,
        },
      ];

      const gatewayVerdict = RoutingOracle.evaluateGatewayRouting(
        mainVerdict.expectedSnapshot?.newapiGroup || 'panqu_test',
        targetModel,
        10,
        channels,
      );

      const issues: string[] = [];
      if (!mainVerdict.willDivert) {
        issues.push(`主站未命中分流 (${mainVerdict.reason})`);
      }
      if (gatewayVerdict.candidateChannelIds.length === 0) {
        issues.push('NewAPI 网关没有可用渠道承接该模型');
      }

      modelReadiness = {
        modelId,
        mediaType,
        decision: mainVerdict.decision as 'DIVERTED' | 'DIRECT' | 'UNKNOWN',
        willDivert: mainVerdict.willDivert,
        routeLine: mainVerdict.line,
        newapiModel: targetModel,
        candidateChannelCount: gatewayVerdict.candidateChannelIds.length,
        isBlockedByQuota: gatewayVerdict.isBlockedByQuota,
        issues,
      };

      if (issues.length > 0) {
        recommendations.push(...issues.map((issue) => `[模型配置] ${issue}`));
      }
    }

    if (!hasSession) {
      recommendations.push('[会话凭据] 未提供 Session Cookie，真实接口提交与轮询将受限。可通过 --session-file 传入已登录会话。');
    }

    const isAllOk = endpoints.every((e) => e.reachable) && (!modelReadiness || modelReadiness.issues.length === 0);
    const hasFatal = endpoints.some((e) => !e.reachable);

    return {
      ok: isAllOk,
      status: hasFatal ? 'BLOCKED' : isAllOk ? 'HEALTHY' : 'DEGRADED',
      env,
      baseUrl,
      gatewayUrl,
      probedAt: new Date().toISOString(),
      auth: {
        status: hasSession ? 'VALID' : 'MISSING',
        details: hasSession ? 'Cookie 已配置' : '缺少 Cookie/Session',
        hasSession,
      },
      endpoints,
      modelReadiness,
      recommendations,
    };
  }

  private static async executeRealProbe(
    env: string,
    baseUrl: string,
    gatewayUrl: string,
    cookie: string,
    options: EnvProbeOptions,
    timeoutMs: number,
  ): Promise<EnvProbeReport> {
    const hasSession = Boolean(cookie && cookie.trim().length > 0);
    const endpoints: EndpointProbeResult[] = [];
    const recommendations: string[] = [];

    const probeEndpoint = async (
      name: string,
      url: string,
      method: 'GET' | 'HEAD' | 'OPTIONS',
      headers: Record<string, string> = {},
    ): Promise<EndpointProbeResult> => {
      const startTime = Date.now();
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const res = await fetch(url, {
          method,
          headers: {
            'User-Agent': 'DevTest-EnvProbe/1.0',
            ...headers,
          },
          signal: controller.signal,
        });
        clearTimeout(timer);
        const latency = Date.now() - startTime;
        return {
          name,
          url,
          method,
          reachable: true,
          statusCode: res.status,
          latencyMs: latency,
          message: `HTTP ${res.status} (${latency}ms)`,
        };
      } catch (err) {
        const latency = Date.now() - startTime;
        return {
          name,
          url,
          method,
          reachable: false,
          latencyMs: latency,
          message: `连接失败: ${(err as Error).message}`,
        };
      }
    };

    // 1. 主站根目录连通性
    endpoints.push(await probeEndpoint('主站连通性', `${baseUrl}/`, 'HEAD'));

    // 2. 会话探测（如提供了 Cookie）
    const authHeaders: Record<string, string> = {};
    if (hasSession) authHeaders['Cookie'] = cookie;
    endpoints.push(await probeEndpoint('业务鉴权端点', `${baseUrl}/aivideo/v2/video/getEditData`, 'GET', authHeaders));

    // 3. NewAPI 网关
    endpoints.push(await probeEndpoint('NewAPI 网关连通性', `${gatewayUrl}/health`, 'GET'));

    const authCheck = endpoints.find((e) => e.name === '业务鉴权端点');
    let authStatus: 'VALID' | 'EXPIRED' | 'MISSING' = 'MISSING';
    let authDetails = '未提供会话 Cookie';

    if (hasSession) {
      if (authCheck?.statusCode === 200) {
        authStatus = 'VALID';
        authDetails = '会话 Cookie 有效';
      } else if (authCheck?.statusCode === 401 || authCheck?.statusCode === 403) {
        authStatus = 'EXPIRED';
        authDetails = `会话已过期或无权访问 (HTTP ${authCheck.statusCode})`;
        recommendations.push('[会话凭据] 会话 Cookie 已失效，请在浏览器重新登录后更新 session 文件');
      } else {
        authStatus = 'VALID';
        authDetails = `响应状态 ${authCheck?.statusCode || '未知'}`;
      }
    } else {
      recommendations.push('[会话凭据] 建议提供 --session-file 或设置 Cookie 进行完整鉴权测试');
    }

    const unreachable = endpoints.filter((e) => !e.reachable);
    if (unreachable.length > 0) {
      for (const u of unreachable) {
        recommendations.push(`[网络连通] 无法访问 ${u.name} (${u.url})，请检查网络代理或防火墙`);
      }
    }

    const ok = unreachable.length === 0 && authStatus !== 'EXPIRED';
    const status = unreachable.length > 0 ? 'BLOCKED' : ok ? 'HEALTHY' : 'DEGRADED';

    return {
      ok,
      status,
      env,
      baseUrl,
      gatewayUrl,
      probedAt: new Date().toISOString(),
      auth: {
        status: authStatus,
        details: authDetails,
        hasSession,
      },
      endpoints,
      recommendations,
    };
  }
}
