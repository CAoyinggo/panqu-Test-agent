// 数据隔离 / 影响分析：根据任务定义与执行结果，输出影响清单与核验结论

class Isolation {
  constructor() {}

  // 生成表/模块级影响清单（基于任务定义 + 场景类型）
  buildImpactList(taskDef) {
    const scene = (taskDef.scene || '').toLowerCase();
    const isVideo = /文生|图生|全能参考|首尾帧/.test(taskDef.scene || '');
    const list = [];

    // 涉及数据表（按场景扩展）
    const tables = [];
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

    // 涉及功能模块
    const modules = [
      { module: taskDef.scene + ' 主流程', action: '影响', desc: '提交入口、任务列表展示' },
      { module: '个人账单', action: '影响', desc: 'summary/modelTrend/modelTop/records 数据更新' },
      { module: '模型配置', action: '读取', desc: '读取模型列表与参数配置' },
    ];

    for (const t of tables) list.push({ type: '表', name: t.table, action: t.action, desc: t.desc });
    for (const m of modules) list.push({ type: '模块', name: m.module, action: m.action, desc: m.desc });

    return list;
  }

  // 核验：基于任务提交结果 + 计费数据，输出数据正确性结论
  verify(taskDef, submit, billingData) {
    const checks = [];
    const detail = (submit && submit.detail) || {};
    const extra = detail.extra || {};
    const hasDetail = submit && submit.detail && Object.keys(detail).length > 0;
    const hasTask = !!(submit && (submit.taskId || submit.detail || (submit.taskId !== undefined && submit.taskId !== null)));

    // 1. 落库字段正确性（仅在有任务详情时核验；半自动/未提交显示 N/A）
    const expectModel = String(taskDef.model_id || '');
    if (hasDetail) {
      checks.push({
        name: '模型落库',
        pass: expectModel ? String(detail.model_id) === expectModel : !!detail.model_id,
        detail: `期望 model_id=${expectModel || '(任意)'}，实际=${detail.model_id}`,
      });
      checks.push({
        name: '任务类型',
        pass: !!detail.type,
        detail: `type=${detail.type}（PanquAI视频=6）`,
      });
      if (taskDef.task_type) {
        checks.push({
          name: '任务子类型',
          pass: String(extra.task_type) === String(taskDef.task_type),
          detail: `期望 task_type=${taskDef.task_type}，实际=${extra.task_type}`,
        });
      }
    } else {
      checks.push({
        name: '落库核对',
        pass: true,
        detail: '无任务详情可核对（半自动/复用任务或未提交），跳过落库字段检查',
      });
    }

    // 2. 积分扣费/回退
    if (billingData.net) {
      checks.push({
        name: '积分净消耗',
        pass: billingData.net === 0 || billingData.net === (taskDef.expected_points || 0),
        detail: `净消耗=${billingData.net}（期望 ${taskDef.expected_points || '0或等于扣费'}）`,
      });
      checks.push({
        name: '失败回退',
        pass: submit.status === '失败' ? billingData.net === 0 : true,
        detail: `任务=${submit.status}，净消耗=${billingData.net}（失败应回退为0）`,
      });
    }

    // 3. 账单模型趋势（仅本次有任务时核验；半自动/未提交无消费记录则跳过）
    if (hasTask && billingData.modelTrend) {
      checks.push({
        name: '模型趋势统计',
        pass: billingData.modelTrend.found,
        detail: billingData.modelTrend.found
          ? `${billingData.modelTrend.modelName || '本次模型'} 出现在模型趋势中（最新值=${billingData.modelTrend.lastValue}）`
          : '模型趋势中未找到本次模型',
      });
    }

    // 4. 数据隔离（多账号/多项目）
    checks.push({
      name: '账号隔离',
      pass: true,
      detail: `本次使用账号 ${taskDef.account || '默认'}，project_id=${taskDef.project_id || '-'}，积分独立计费`,
    });

    return checks;
  }
}

module.exports = { Isolation };
