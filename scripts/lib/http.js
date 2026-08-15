// HTTP 封装：登录态注入、CSRF token 获取、统一请求日志
const fs = require('fs');

const API_HEADERS = {
  'accept': 'application/json, text/javascript, */*; q=0.01',
  'x-requested-with': 'XMLHttpRequest',
};

class Http {
  constructor(baseUrl, cookieString) {
    this.baseUrl = baseUrl.replace(/\/$/, '') + '/';
    this.cookieString = cookieString;
  }

  async getCsrfToken(pagePath) {
    const res = await fetch(this.baseUrl + pagePath, { headers: { 'cookie': this.cookieString } });
    const html = await res.text();
    const m = html.match(/__token__["']?\s*value=["']([^"']+)["']/);
    return m ? m[1] : '';
  }

  // 通用请求：path 相对路径，返回 JSON（解析失败返回 {raw}）
  async api(name, method, path, { form = null, body = null, headers = {} } = {}) {
    const t0 = Date.now();
    const h = { ...API_HEADERS, ...headers, 'cookie': this.cookieString };
    const opts = { method, headers: h };
    if (form) opts.body = form;
    else if (body) {
      opts.body = JSON.stringify(body);
      h['content-type'] = 'application/json';
    }
    const res = await fetch(this.baseUrl + path, opts);
    const txt = await res.text();
    let j = {};
    try { j = JSON.parse(txt); } catch { j = { raw: txt.slice(0, 300) }; }
    console.log(`  [${name}] ${method} ${path} -> ${res.status} (${Date.now() - t0}ms)`);
    return { status: res.status, json: j };
  }

  // 加载会话
  static loadSession(sessionPath, env) {
    const S = JSON.parse(fs.readFileSync(sessionPath, 'utf-8'));
    const s = S.sessions.find(x => x.env === env);
    if (!s) throw new Error(`未找到环境 ${env} 的登录态`);
    return s;
  }
}

module.exports = { Http, API_HEADERS };
