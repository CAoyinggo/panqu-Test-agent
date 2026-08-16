/* eslint-disable */
// WAN3-INT-03：非法 task_type — 验证提交接口参数校验
// 预期：API 拒绝提交（code != 1），不产生扣费
import { defineCase } from '../define.js';

export default defineCase({
  name: 'Wan3.0接口异常-非法任务类型',
  scene: '文生视频',
  scene_detail: 'WAN3-INT-03：提交时 task_type=999（非法值），验证后端参数校验是否拦截',
  type: 6,
  model_id: '84',
  model_name: 'Wan 3.0',
  task_type: '999', // 非法任务类型
  task_id: null,
  selmodelsId: 84,
  extra: {
    selmodels: '84-Wan 3.0',
    selmodelsId: '84',
    selmodelsName: 'Wan 3.0',
    task_type: '999',
    workflow_type: 'qntk',
    cueword: '一只猫在草地上奔跑，阳光透过树叶洒下斑驳光影',
    duration: '4',
    video_resolution: '720p',
    video_aspect_ratio: '16:9',
  },
  expected_points: 0,
  tags: ['regression', 'exception', 'INT'],
  manual_cases: [
    {
      id: 'WAN3-INT-03',
      steps: '提交任务时 task_type=999（非法值），验证：①API 返回错误码（非 1）②错误信息包含「类型」或「非法」相关提示 ③不产生扣费',
    },
  ],
});
