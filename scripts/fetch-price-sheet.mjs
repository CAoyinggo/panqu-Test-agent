// Panqu AI DevTest - 飞书各模型官方价格表自动同步脚本
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

function loadCredentials() {
  try {
    const appId = execFileSync(
      'security',
      ['find-generic-password', '-a', 'panqu-ai', '-s', 'codex.feishu.app-id', '-w'],
      {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
      },
    ).trim();
    const appSecret = execFileSync(
      'security',
      ['find-generic-password', '-a', 'panqu-ai', '-s', 'codex.feishu.app-secret', '-w'],
      {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
      },
    ).trim();
    if (appId && appSecret) {
      return { app_id: appId, app_secret: appSecret };
    }
  } catch {
    // 凭据缺失或 Keychain 拒绝访问时关闭流程。
  }

  throw new Error(
    '[Feishu] 缺少 macOS Keychain 账户 panqu-ai 下的 codex.feishu.app-id 或 codex.feishu.app-secret 访问权限',
  );
}

function request(url, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    if (urlObj.protocol !== 'https:' || urlObj.hostname !== 'open.feishu.cn') {
      return reject(new Error(`[Feishu] 目标主机受限，只允许访问 https://open.feishu.cn: ${urlObj.origin}`));
    }
    const req = https.request(
      {
        hostname: urlObj.hostname,
        port: 443,
        path: urlObj.pathname + urlObj.search,
        method: options.method || 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...(options.headers || {}),
        },
        timeout: 15000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            resolve(JSON.parse(text));
          } catch {
            resolve({ code: -1, msg: text });
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('请求超时'));
    });
    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

async function getTenantAccessToken(base, creds) {
  console.log('[Feishu] 正在通过 Keychain 凭据获取租户访问令牌...');
  const tokenRes = await request(
    `${base}/open-apis/auth/v3/tenant_access_token/internal`,
    {
      method: 'POST',
    },
    {
      app_id: creds.app_id,
      app_secret: creds.app_secret,
    },
  );

  if (tokenRes.code !== 0 || !tokenRes.tenant_access_token) {
    throw new Error(`[Feishu] 获取 Token 失败: ${tokenRes.msg || '未知错误'}`);
  }
  return tokenRes.tenant_access_token;
}

export async function fetchPriceSheet(
  sheetUrl = 'https://panqu-ai.feishu.cn/wiki/NNxfwgI2fih5iekmKABcSn2Wnne?sheet=35279c',
) {
  const creds = loadCredentials();
  const base = 'https://open.feishu.cn';

  // 1. 获取 tenant_access_token
  const token = await getTenantAccessToken(base, creds);
  const authHeaders = { Authorization: `Bearer ${token}` };

  // 2. 解析 Wiki URL
  const wikiMatch = sheetUrl.match(/\/wiki\/([A-Za-z0-9]+)/);
  if (!wikiMatch) {
    throw new Error(`[Feishu] 无法识别的 Wiki 链接: ${sheetUrl}`);
  }
  const wikiToken = wikiMatch[1];
  const urlObj = new URL(sheetUrl);
  const targetSheetId = urlObj.searchParams.get('sheet') || '35279c';

  // 3. 获取 Wiki 节点元数据
  console.log(`[Feishu] 正在获取 Wiki 节点信息 (Token: ${wikiToken})...`);
  const nodeRes = await request(`${base}/open-apis/wiki/v2/spaces/get_node?token=${wikiToken}`, {
    headers: authHeaders,
  });

  if (nodeRes.code === 131006) {
    throw new Error(`[Feishu] 文档 ${wikiToken} 缺少应用阅读权限 (code: 131006)`);
  }

  if (nodeRes.code !== 0 || !nodeRes.data?.node) {
    throw new Error(`[Feishu] 获取 Wiki 节点失败: ${nodeRes.msg || '未知错误'}`);
  }

  const { obj_token, obj_type } = nodeRes.data.node;
  console.log(`[Feishu] 节点类型: ${obj_type}, 文档 Token: ${obj_token}`);

  // 4. 读取电子表格数据
  if (obj_type === 'sheet') {
    console.log(`[Feishu] 正在读取子表 [${targetSheetId}] 的数值范围...`);
    const sheetData = await request(`${base}/open-apis/sheets/v2/spreadsheets/${obj_token}/values/${targetSheetId}`, {
      headers: authHeaders,
    });

    if (sheetData.code !== 0) {
      // 尝试读取第一页或全部范围
      const fallbackData = await request(
        `${base}/open-apis/sheets/v2/spreadsheets/${obj_token}/values/${obj_token}!A1:Z100`,
        {
          headers: authHeaders,
        },
      );
      if (fallbackData.code === 0) {
        return fallbackData.data?.valueRange?.values || [];
      }
      throw new Error(`[Feishu] 获取表格数据失败: ${sheetData.msg || '未知错误'}`);
    }

    return sheetData.data?.valueRange?.values || [];
  }

  // 5. 若是 docx 文档则调用 raw_content
  if (obj_type === 'docx') {
    const rawRes = await request(`${base}/open-apis/docx/v1/documents/${obj_token}/raw_content`, {
      headers: authHeaders,
    });
    if (rawRes.code === 0) {
      return rawRes.data?.content;
    }
  }

  throw new Error(`[Feishu] 暂不支持的节点类型: ${obj_type}`);
}

export async function fetchAllSheets(wikiUrl = 'https://panqu-ai.feishu.cn/wiki/NNxfwgI2fih5iekmKABcSn2Wnne') {
  const creds = loadCredentials();
  const base = 'https://open.feishu.cn';

  const token = await getTenantAccessToken(base, creds);
  const authHeaders = { Authorization: `Bearer ${token}` };

  const wikiMatch = wikiUrl.match(/\/wiki\/([A-Za-z0-9]+)/);
  const wikiToken = wikiMatch ? wikiMatch[1] : 'NNxfwgI2fih5iekmKABcSn2Wnne';

  const nodeRes = await request(`${base}/open-apis/wiki/v2/spaces/get_node?token=${wikiToken}`, {
    headers: authHeaders,
  });
  if (nodeRes.code === 131006) throw new Error(`[Feishu] 文档 ${wikiToken} 缺少应用阅读权限 (code: 131006)`);
  const objToken = nodeRes.data?.node?.obj_token;
  if (!objToken) throw new Error('[Feishu] 获取电子表格 Token 失败');

  const metaRes = await request(`${base}/open-apis/sheets/v3/spreadsheets/${objToken}/sheets/query`, {
    headers: authHeaders,
  });

  const sheets = metaRes.data?.sheets || [];
  const results = {};

  for (const s of sheets) {
    if (s.title.includes('不用看')) continue;
    console.log(`[Feishu] 正在读取子表: ${s.title} (${s.sheet_id})...`);
    const sheetData = await request(`${base}/open-apis/sheets/v2/spreadsheets/${objToken}/values/${s.sheet_id}`, {
      headers: authHeaders,
    });
    results[s.title] = {
      sheetId: s.sheet_id,
      values: sheetData.data?.valueRange?.values || [],
    };
  }

  return results;
}

// CLI 执行入口
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const shouldSyncAll = process.argv.includes('--all') || process.argv.includes('--sync');
  if (shouldSyncAll) {
    fetchAllSheets()
      .then((data) => {
        const outPath = path.resolve(
          rootDir,
          'src/devtest/assets/panqu-billing/references/feishu-live-pricing-cache.json',
        );
        fs.writeFileSync(
          outPath,
          JSON.stringify(
            {
              syncedAt: new Date().toISOString(),
              sourceUrl: 'https://panqu-ai.feishu.cn/wiki/NNxfwgI2fih5iekmKABcSn2Wnne',
              sheets: data,
            },
            null,
            2,
          ) + '\n',
          'utf8',
        );
        console.log(`\n✅ 全量子表已同步至: ${outPath}`);
      })
      .catch((err) => {
        console.error('\n❌ 同步异常:', err.message);
        process.exit(1);
      });
  } else {
    const inputUrl = process.argv[2] && process.argv[2].startsWith('http') ? process.argv[2] : undefined;
    fetchPriceSheet(inputUrl)
      .then((data) => {
        console.log('\n✅ 成功拉取价格表数据:');
        if (Array.isArray(data)) {
          console.table(data.slice(0, 20));
        } else {
          console.log(data);
        }
      })
      .catch((err) => {
        console.error('\n❌ 获取异常:', err.message);
        process.exit(1);
      });
  }
}
