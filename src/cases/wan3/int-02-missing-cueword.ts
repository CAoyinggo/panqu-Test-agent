/* eslint-disable */
// WAN3-INT-02：缺失 cueword（提示词）— 验证提交接口参数校验
// 预期：API 拒绝提交（code != 1），不产生扣费
import { defineCase } from '../define.js';

export default defineCase({
  name: 'Wan3.0接口异常-缺失提示词',
  scene: '文生视频',
  scene_detail: 'WAN3-INT-02：提交时 cueword 为空，验证后端参数校验是否拦截',
  type: 6,
  model_id: '84',
  model_name: 'Wan 3.0',
  task_type: '101',
  task_id: null,
  selmodelsId: 84,
  extra: {
    selmodels: '84-Wan 3.0',
    selmodelsId: '84',
    selmodelsName: 'Wan 3.0',
    task_type: '101',
    workflow_type: 'qntk',
    cueword: '', // 缺失提示词
    duration: '4',
    video_resolution: '720p',
    video_aspect_ratio: '16:9',
  },
  expected_points: 0,
  tags: ['regression', 'exception', 'INT'],
  manual_cases: [
    {
      id: 'WAN3-INT-02',
      steps: '提交任务时 cueword 为空，验证：①API 返回错误码（非 1）②错误信息包含「提示词」或「必填」相关提示 ③不产生扣费',
    },
  ],
});
