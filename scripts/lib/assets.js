// 素材库扫描与相对路径解析
// 素材库根目录：/Users/mac/agents/Test-panqu/（audio/photo/video/txt）
// 任务定义中引用素材用相对路径：test-assets/photo/xx.png → 解析为完整本地路径
const fs = require('fs');
const path = require('path');

const ASSETS_ROOT = '/Users/mac/agents/Test-panqu';
const SUBDIRS = ['audio', 'photo', 'video', 'txt'];

const EXT_TYPE = {
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.gif': 'image', '.webp': 'image', '.bmp': 'image',
  '.mp3': 'audio', '.wav': 'audio', '.ogg': 'audio', '.flac': 'audio', '.m4a': 'audio', '.wma': 'audio',
  '.opus': 'audio', '.ac3': 'audio', '.aiff': 'audio',
  '.mp4': 'video', '.mov': 'video', '.avi': 'video', '.mkv': 'video', '.webm': 'video',
  '.txt': 'text',
};

// 素材相对路径判定：test-assets/<type>/ 或 <type>/ 前缀（photo/audio/video/txt）
const ASSET_RE = /^(test-assets\/(audio|photo|video|txt)\/|(audio|photo|video|txt)\/)/;

class Assets {
  constructor(root = ASSETS_ROOT) {
    this.root = root;
  }

  // 扫描素材库，返回 { byType: {image:[], audio:[], video:[], text:[]}, bySubdir: {...} }
  scan() {
    const byType = { image: [], audio: [], video: [], text: [] };
    const bySubdir = {};
    if (!fs.existsSync(this.root)) {
      console.log('  ⚠ 素材库不存在：' + this.root);
      return { byType, bySubdir, exists: false };
    }
    for (const sub of SUBDIRS) {
      const dir = path.join(this.root, sub);
      if (!fs.existsSync(dir)) continue;
      const items = [];
      for (const f of fs.readdirSync(dir)) {
        const full = path.join(dir, f);
        const st = fs.statSync(full);
        if (!st.isFile()) continue;
        const ext = path.extname(f).toLowerCase();
        const type = EXT_TYPE[ext] || 'other';
        const rel = 'test-assets/' + sub + '/' + f;
        items.push({ name: f, subdir: sub, type, rel, full, size: st.size });
        if (byType[type]) byType[type].push({ ...items[items.length - 1] });
      }
      bySubdir[sub] = items;
    }
    return { byType, bySubdir, exists: true };
  }

  // 解析相对路径（test-assets/... 或 photo/xx.png）为完整本地路径
  resolve(relPath) {
    if (!relPath) return null;
    let clean = String(relPath).trim();
    // 支持 test-assets/photo/xx.png 或 photo/xx.png
    clean = clean.replace(/^test-assets\//, '');
    if (/^[\\/]/.test(clean)) {
      // 绝对路径直接返回
      return fs.existsSync(clean) ? clean : null;
    }
    const full = path.join(this.root, clean);
    return fs.existsSync(full) ? full : null;
  }
}

// 递归收集 extra 值中的素材相对路径引用
function collectAssetRefs(v, out = []) {
  if (Array.isArray(v)) {
    for (const item of v) collectAssetRefs(item, out);
  } else if (v && typeof v === 'object') {
    for (const k of Object.keys(v)) collectAssetRefs(v[k], out);
  } else if (typeof v === 'string' && ASSET_RE.test(v)) {
    out.push(v);
  }
  return out;
}

// 按扩展名推断 MIME 类型
function mimeOf(full) {
  const ext = path.extname(full).toLowerCase();
  return {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
    '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
    '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
    '.m4a': 'audio/mp4', '.wma': 'audio/x-ms-wma', '.opus': 'audio/opus', '.ac3': 'audio/ac3',
    '.aiff': 'audio/aiff', '.aif': 'audio/aiff',
  }[ext] || 'application/octet-stream';
}

// 上传素材库文件到平台文件服务（/ajax/upload），返回完整 URL
async function uploadAsset(http, assets, relPath) {
  const full = assets.resolve(relPath);
  if (!full || !fs.existsSync(full)) {
    console.log('  ⚠ 素材未找到: ' + relPath);
    return null;
  }
  const fd = new FormData();
  fd.append('file', new Blob([fs.readFileSync(full)], { type: mimeOf(full) }), path.basename(full));
  const r = await http.api('素材上传', 'POST', 'ajax/upload', { form: fd });
  const j = r.json;
  if (j.code === 1 && j.data && j.data.fullurl) {
    console.log('  ⬆ 上传素材 ' + relPath + ' -> ' + j.data.fullurl);
    return j.data.fullurl;
  }
  console.log('  ⚠ 上传失败 ' + relPath + ': ' + JSON.stringify(j).slice(0, 200));
  return null;
}

// 将 extra 值序列化为后端可接收格式：数组/对象 -> JSON 字符串；素材相对路径 -> 上传后 URL
async function resolveExtraValue(http, assets, v) {
  if (Array.isArray(v)) {
    const out = [];
    for (const item of v) {
      if (typeof item === 'string' && ASSET_RE.test(item)) out.push((await uploadAsset(http, assets, item)) || item);
      else out.push(item);
    }
    return JSON.stringify(out);
  }
  if (v && typeof v === 'object') {
    const o = { ...v };
    if (typeof o.url === 'string' && ASSET_RE.test(o.url)) o.url = (await uploadAsset(http, assets, o.url)) || o.url;
    return JSON.stringify(o);
  }
  const vStr = String(v);
  if (ASSET_RE.test(vStr)) return (await uploadAsset(http, assets, vStr)) || vStr;
  return vStr;
}

module.exports = { Assets, ASSETS_ROOT, ASSET_RE, collectAssetRefs, mimeOf, uploadAsset, resolveExtraValue };
