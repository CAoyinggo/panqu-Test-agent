// 报告上传 OSS：将测试报告上传到阿里云 OSS，生成可分享链接
// 使用 ali-oss SDK，复用 withRetry 机制支持失败重试
import fs from 'node:fs';
import path from 'node:path';
import { logger } from './logger.js';
import { withRetry } from './retry.js';
import { todayStr } from './fs-utils.js';

/** OSS 上传配置 */
export interface OssConfig {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  accessKeySecret: string;
  /** 报告公开访问 URL 前缀（如 https://reports.example.com/test-flow） */
  baseUrl?: string;
}

/** 上传结果 */
export interface UploadResult {
  uploaded: string[];   // 上传成功的文件路径
  urls: string[];       // 可分享的 URL 列表
  errors: string[];    // 失败的文件与原因
}

/** 上传的报告文件扩展名 */
const REPORT_EXTENSIONS = ['.html', '.json', '.xml'];

/** 从环境变量构建 OSS 配置 */
export function getOssConfigFromEnv(): OssConfig | null {
  const endpoint = process.env.TESTFLOW_OSS_ENDPOINT;
  const bucket = process.env.TESTFLOW_OSS_BUCKET;
  const accessKeyId = process.env.TESTFLOW_OSS_ACCESS_KEY_ID;
  const accessKeySecret = process.env.TESTFLOW_OSS_ACCESS_KEY_SECRET;
  const baseUrl = process.env.TESTFLOW_REPORT_BASE_URL;

  if (!endpoint || !bucket || !accessKeyId || !accessKeySecret) {
    return null;
  }

  return { endpoint, bucket, accessKeyId, accessKeySecret, baseUrl };
}

/** 检查 OSS 配置是否可用 */
export function isOssConfigured(): boolean {
  return getOssConfigFromEnv() !== null;
}

/**
 * 上传 output/<日期>/ 目录下所有报告到 OSS
 * @param outputBaseDir output 根目录路径（如 /Users/mac/agents/output）
 * @param config OSS 配置
 * @returns 上传结果（URL 列表）
 */
export async function uploadReports(outputBaseDir: string, config: OssConfig): Promise<UploadResult> {
  // 动态导入 ali-oss（CommonJS 模块，ESM 中需 default import）
  const OSS = (await import('ali-oss')).default;
  const client = new OSS({
    endpoint: config.endpoint,
    bucket: config.bucket,
    accessKeyId: config.accessKeyId,
    accessKeySecret: config.accessKeySecret,
  });

  const today = todayStr();
  const todayDir = path.join(outputBaseDir, today);
  const result: UploadResult = { uploaded: [], urls: [], errors: [] };

  if (!fs.existsSync(todayDir)) {
    logger.warn(`报告目录不存在：${todayDir}，跳过上传`);
    return result;
  }

  // 递归收集所有报告文件
  const reportFiles = collectReportFiles(todayDir);
  if (reportFiles.length === 0) {
    logger.warn('未找到可上传的报告文件');
    return result;
  }

  logger.info(`开始上传 ${reportFiles.length} 个报告文件到 OSS（${config.bucket}）...`);

  for (const filePath of reportFiles) {
    const relativePath = path.relative(outputBaseDir, filePath);
    // OSS key 用正斜杠（如 2026-08-17/wan3/report.html）
    const ossKey = relativePath.split(path.sep).join('/');

    try {
      await withRetry(
        async () => {
          const data = fs.readFileSync(filePath);
          const ext = path.extname(filePath);
          const headers: Record<string, string> = {};
          if (ext === '.html') headers['Content-Type'] = 'text/html; charset=utf-8';
          else if (ext === '.json') headers['Content-Type'] = 'application/json; charset=utf-8';
          else if (ext === '.xml') headers['Content-Type'] = 'application/xml; charset=utf-8';
          return client.put(ossKey, data, { headers });
        },
        { retries: 3, timeout: 30000, retryable: true },
      );

      result.uploaded.push(filePath);

      // 生成可分享 URL
      const url = config.baseUrl
        ? `${config.baseUrl}/${ossKey}`
        : `https://${config.bucket}.${config.endpoint}/${ossKey}`;
      result.urls.push(url);

      logger.debug(`  ✅ 上传成功：${ossKey}`);
    } catch (e: any) {
      result.errors.push(`${filePath}: ${e.message}`);
      logger.warn(`  ❌ 上传失败：${filePath} - ${e.message}`);
    }
  }

  logger.info(`上传完成：${result.uploaded.length}/${reportFiles.length} 成功` +
    (result.errors.length ? `，${result.errors.length} 失败` : ''));

  return result;
}

/** 递归收集指定目录下所有报告文件 */
function collectReportFiles(dir: string): string[] {
  const files: string[] = [];
  if (!fs.existsSync(dir)) return files;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectReportFiles(fullPath));
    } else if (REPORT_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) {
      files.push(fullPath);
    }
  }
  return files;
}
