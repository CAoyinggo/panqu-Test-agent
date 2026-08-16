// 场景处理器自动扫描：放入 src/plugins/scenes/*.ts 即自动注册，无需改 engine.ts
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { SceneHandler } from '../core/scene-handler.js';
import { logger } from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 自动扫描 scenes/ 目录，动态导入并注册场景处理器。
 * 每个场景文件需 export 一个实现了 SceneHandler 接口的类。
 * 注册 key 取自实例的 name 属性。
 */
export async function autoLoadScenes(): Promise<Record<string, SceneHandler>> {
  const scenesDir = path.join(__dirname, 'scenes');
  const handlers: Record<string, SceneHandler> = {};

  if (!fs.existsSync(scenesDir)) {
    logger.warn(`场景目录不存在：${scenesDir}`);
    return handlers;
  }

  const files = fs.readdirSync(scenesDir).filter((f) => f.endsWith('.js') && !f.endsWith('.d.ts') && !f.endsWith('.map'));
  logger.info(`扫描场景处理器：${scenesDir}（找到 ${files.length} 个文件）`);

  for (const file of files) {
    const filePath = path.join(scenesDir, file);
    try {
      const mod = await import(pathToFileURL(filePath).href);
      // 查找导出的类（构造函数），实例化后注册
      for (const [, exportValue] of Object.entries(mod)) {
        if (typeof exportValue === 'function' && (exportValue as any).prototype) {
          const instance = new (exportValue as any)() as SceneHandler;
          if (instance.name && typeof instance.match === 'function') {
            handlers[instance.name] = instance;
            logger.info(`  自动注册场景处理器：${instance.name}（${file}）`);
            break;
          }
        }
      }
    } catch (e: any) {
      logger.warn(`  加载场景处理器失败 ${file}：${e.message}`);
    }
  }

  return handlers;
}
