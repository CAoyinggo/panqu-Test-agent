/* eslint-disable */
// WAN3-INT-05：超长 cueword — 验证提交接口参数校验
// 预期：API 拒绝提交（code != 1）或截断处理，不产生异常扣费
import { defineCase } from '../define.js';

// 生成超长提示词（10000 字符）
const longCueword = '一只猫在草地上奔跑，阳光透过树叶洒下斑驳光影。'.repeat(250);

export default defineCase({
  name: 'Wan3.0接口异常-超长提示词',
  scene: '文生视频',
  scene_detail: `WAN3-INT-05：提交时 cueword 长度=${longCueword.length}字符（超长），验证后端是否有长度限制`,
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
    cueword: longCueword, // 超长提示词
    duration: '4',
    video_resolution: '720p',
    video_aspect_ratio: '16:9',
  },
  expected_points: 0,
  tags: ['regression', 'exception', 'INT'],
  manual_cases: [
    {
      id: 'WAN3-INT-05',
      steps: `提交任务时 cueword 长度=${longCueword.length}字符（超长），验证：①API 返回错误码（非 1）或正常截断 ②不产生异常扣费 ③不导致服务端异常`,
    },
  ],
});
