/* eslint-disable */
// WAN3-BILL-03：幂等性验证用例（手动指定 task_id 复用，验证不重复扣费）
// 使用方式：先执行任意 WAN3 用例获取 taskId，填入下方 task_id 后执行本用例
// 预期：复用已有任务不触发提交，快照差值 actualConsumed 应为 0
import { defineCase } from '../define.js';

export default defineCase({
  name: 'Wan3.0幂等性验证-复用task_id不重复扣费',
  scene: '文生视频',
  scene_detail: 'WAN3-BILL-03：复用已有 task_id，验证提交被跳过且积分未被重复扣减',
  type: 6,
  model_id: '84',
  model_name: 'Wan 3.0',
  task_type: '101',
  task_id: null, // 执行前填入已存在的 taskId
  selmodelsId: 84,
  extra: {
    selmodels: '84-Wan 3.0',
    selmodelsId: '84',
    selmodelsName: 'Wan 3.0',
    task_type: '101',
    workflow_type: 'qntk',
    cueword: '一只猫在草地上奔跑，阳光透过树叶洒下斑驳光影',
    duration: '4',
    video_resolution: '720p',
    video_aspect_ratio: '16:9',
  },
  expected_points: 0, // 复用任务不应产生新的扣费
  manual_cases: [
    {
      id: 'WAN3-BILL-03',
      steps: '①先执行任一 WAN3 用例获取 taskId → ②将 taskId 填入本用例 task_id 字段 → ③执行本用例，验证：提交被跳过、快照差值 actualConsumed=0、billing-check 全部通过',
    },
  ],
});
