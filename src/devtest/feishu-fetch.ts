/**
 * DevTest 飞书文档直读。
 *
 * 实战经验（继承自旧测试智能体 runner/fetch-feishu.js）：
 * - raw_content 接口才返回全文（含表格），blocks 接口经常返回空，禁止改回 blocks；
 * - wiki 链接必须先经 get_node 解析出 obj_token，再走 docx raw_content；
 * - 凭证只从进程环境读取，secret 不得出现在日志与产物中。
 */

export interface FeishuCredentials {
  app_id: string;
  app_secret: string;
  api_base_url?: string;
}

const DEFAULT_API_BASE = 'https://open.feishu.cn';

export function parseFeishuUrl(url: string): { type: 'wiki' | 'docx' | 'doc'; id: string } | null {
  const wikiMatch = url.match(/\/wiki\/([A-Za-z0-9]+)/);
  if (wikiMatch) return { type: 'wiki', id: wikiMatch[1] };
  const docxMatch = url.match(/\/docx\/([A-Za-z0-9]+)/);
  if (docxMatch) return { type: 'docx', id: docxMatch[1] };
  const docMatch = url.match(/\/doc\/([A-Za-z0-9]+)/);
  if (docMatch) return { type: 'doc', id: docMatch[1] };
  return null;
}

/** 凭证仅允许由环境变量注入；禁止读取仓库内或本机凭证文件。 */
export async function loadFeishuCredentials(explicitPath?: string): Promise<FeishuCredentials> {
  if (explicitPath || process.env.FEISHU_CREDENTIALS) {
    throw new Error('FEISHU_CREDENTIALS_FILE_FORBIDDEN：凭证文件不允许使用，请注入 FEISHU_APP_ID/FEISHU_APP_SECRET');
  }
  if (process.env.FEISHU_APP_ID && process.env.FEISHU_APP_SECRET) {
    return {
      app_id: process.env.FEISHU_APP_ID,
      app_secret: process.env.FEISHU_APP_SECRET,
      api_base_url: process.env.FEISHU_API_BASE_URL,
    };
  }
  throw new Error('FEISHU_CREDENTIALS_MISSING：请通过环境变量 FEISHU_APP_ID/FEISHU_APP_SECRET 提供自建应用凭证');
}

async function feishuRequest<T>(url: string, init: RequestInit & { body?: string }): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`FEISHU_HTTP_${response.status}：${url.split('/open-apis/')[1] ?? url} 请求失败`);
  }
  return await response.json() as T;
}

/**
 * 拉取飞书文档纯文本内容（wiki/docx/doc）。
 * 失败时抛出带结构化前缀的错误，由上层归入问题清单，绝不静默降级为空文档。
 */
export async function fetchFeishuDoc(url: string, credentials: FeishuCredentials): Promise<string> {
  const base = (credentials.api_base_url || DEFAULT_API_BASE).replace(/\/$/, '');
  const tokenResponse = await feishuRequest<{ tenant_access_token?: string; code?: number; msg?: string }>(
    `${base}/open-apis/auth/v3/tenant_access_token/internal`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: credentials.app_id, app_secret: credentials.app_secret }),
    },
  );
  if (!tokenResponse.tenant_access_token) {
    throw new Error(`FEISHU_TOKEN_FAILED：获取 tenant_access_token 失败：${tokenResponse.msg ?? 'unknown'}`);
  }
  const auth = { Authorization: `Bearer ${tokenResponse.tenant_access_token}` };

  const parsed = parseFeishuUrl(url);
  if (!parsed) throw new Error(`FEISHU_URL_INVALID：无法解析飞书文档链接：${url}`);
  let docId = parsed.id;
  if (parsed.type === 'wiki') {
    const node = await feishuRequest<{ data?: { node?: { obj_token?: string } } }>(
      `${base}/open-apis/wiki/v2/spaces/get_node?token=${encodeURIComponent(parsed.id)}`,
      { method: 'GET', headers: auth },
    );
    docId = node.data?.node?.obj_token ?? '';
    if (!docId) throw new Error('FEISHU_WIKI_NODE_FAILED：wiki 节点解析失败，未取得 obj_token');
  }

  // 仅走 raw_content：blocks 接口在实战中返回空，属于已知死路。
  const raw = await feishuRequest<{ code?: number; msg?: string; data?: { content?: string } }>(
    `${base}/open-apis/docx/v1/documents/${encodeURIComponent(docId)}/raw_content`,
    { method: 'GET', headers: auth },
  );
  const content = raw.data?.content;
  if (raw.code !== 0 || typeof content !== 'string' || !content.trim()) {
    throw new Error(`FEISHU_RAW_CONTENT_EMPTY：文档内容为空或不可读（code=${raw.code ?? 'n/a'}）。旧版文档（/doc/）可能不受支持，请在飞书中另存为 docx 后重试。`);
  }
  return content;
}
