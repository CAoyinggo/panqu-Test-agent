/* eslint-disable */
// WAN3-INT-04：空 model_id — 验证提交接口参数校验
// 预期：API 拒绝提交（code != 1），不产生扣费
import { defineCase } from '../define.js';

export default defineCase({
  name: 'Wan3.0接口异常-空模型ID',
  scene: '文生视频',
  scene_detail: 'WAN3-INT-04：提交时 model_id 为空，验证后端参数校验是否拦截',
  type: 6,
  model_id: '', // 空模型 ID
  model_name: 'Wan 3.0',
  task_type: '101',
  task_id: null,
  selmodelsId: 0,
  extra: {
    selmodels: '0-',
    selmodelsId: '',
    selmodelsName: 'Wan 3.0',
    task_type: '101',
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
      id: 'WAN3-INT-04',
      steps: '提交任务时 model_id 为空，验证：①API 返回错误码（非 1）②错误信息包含「模型」或「必填」相关提示 ③不产生扣费',
    },
  ],
});
