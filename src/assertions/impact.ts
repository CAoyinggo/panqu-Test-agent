// 影响分析：基于任务定义 + 场景类型生成表/模块级影响清单
import type { TaskDef, ImpactItem } from '../core/types.js';

export function buildImpactList(taskDef: TaskDef): ImpactItem[] {
  const scene = (taskDef.scene || '').toLowerCase();
  const isVideo = /文生|图生|全能参考|首尾帧/.test(taskDef.scene || '');
  const list: ImpactItem[] = [];

  const tables: Array<{ table: string; action: string; desc: string }> = [];
  if (isVideo) {
    tables.push(
      { table: 'pq_videonew', action: '写入', desc: '新增视频任务记录（model_id/type/cueword/extra）' },
      { table: 'pq_aivideo_task_log', action: '写入', desc: '记录本次生成的任务日志（参数快照）' },
      { table: 'pq_aivideo_task_status', action: '写入', desc: '记录任务状态与进度（task_status/progress）' },
    );
  }
  if (/图生|全能参考|首尾帧/.test(taskDef.scene || '')) {
    tables.push({ table: '素材/资产表', action: '读取', desc: '读取参考图片/视频/音频素材地址' });
  }
  if (/账单|计费/.test(scene)) {
    tables.push({ table: '账单统计表', action: '写入', desc: '模型消耗统计（modelTrend/modelTop）' });
  }
  tables.push({ table: '积分流水表', action: '写入', desc: '积分扣费/回退流水（consumed/refund）' });

  const modules = [
    { module: taskDef.scene + ' 主流程', action: '影响', desc: '提交入口、任务列表展示' },
    { module: '个人账单', action: '影响', desc: 'summary/modelTrend/modelTop/records 数据更新' },
    { module: '模型配置', action: '读取', desc: '读取模型列表与参数配置' },
  ];

  for (const t of tables) list.push({ type: '表', name: t.table, action: t.action, desc: t.desc });
  for (const m of modules) list.push({ type: '模块', name: m.module, action: m.action, desc: m.desc });
  return list;
}
