/* eslint-disable */
// 由 scripts/migrate-json-to-ts.ts 自动生成（幂等；源 JSON 见 tasks/ 对应文件）
// @ts-ignore // 若因未导入类型导致报错，可取消本行注释（按需启用）
import { defineCase } from '../define.js';

export default defineCase({
  name: 'Wan3.0文生视频-落日海岸',
  scene: '文生视频',
  scene_detail: 'Wan 3.0 全能参考（task_type=105）纯文本生成，验证提交链路/落库/失败回退/计费回退',
  type: 6,
  model_id: '84',
  model_name: 'Wan 3.0',
  task_type: '105',
  task_id: null,
  selmodelsId: 84,
  extra: {
    selmodels: '84-Wan 3.0',
    selmodelsId: '84',
    selmodelsName: 'Wan 3.0',
    task_type: '105',
    workflow_type: 'qntk',
    cueword: '落日余晖洒在金色海岸，海浪缓缓拍打沙滩，几只海鸥掠过天际，画面唯美宁静，电影感镜头',
    duration: '4',
    video_resolution: '720p',
    video_aspect_ratio: '9:16'
  },
  expected_points: 240,
  manual_cases: [
    {
      id: 'WAN3-WS-UI-01',
      steps: '浏览器打开视频制作页，选择 Wan 3.0 文生视频，输入提示词并生成，核对页面任务创建与播放展示'
    }
  ]
});
