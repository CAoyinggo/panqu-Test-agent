// WAN3 真实测试用例目录（Phase 26.2 Real Project Onboarding）
// 50 个真实 TestCase：10 P0/P1 + 10 边界 + 10 异常 + 10 历史问题 + 10 AI 生成场景。
// 复用原则：source=reuse:wan3-cases/<file> 的条目与 src/cases/wan3/ 现有资产一致
// （禁止重新生成已有 Case）；导入按 id 幂等，重复执行不重复创建。
// 数据均基于 WAN3 文生视频平台真实业务（文生视频/图生视频/首尾帧/全能参考/视频编辑/计费）。

/** 资产分类 */
export type Wan3AssetCategory = 'p0' | 'p1' | 'boundary' | 'exception' | 'history' | 'ai-generated';

/** WAN3 真实 TestCase 条目 */
export interface Wan3TestCase {
  id: string;
  category: Wan3AssetCategory;
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  business: string;
  feature: string;
  title: string;
  preconditions: string;
  steps: string[];
  expected: string;
  source: string;
  /** 复用现有案例文件（src/cases/wan3/ 下） */
  reuseOf?: string;
  extra?: Record<string, unknown>;
}

export const WAN3_CATEGORY_LABEL: Record<Wan3AssetCategory, string> = {
  p0: 'P0/P1',
  p1: 'P0/P1',
  boundary: '边界',
  exception: '异常',
  history: '历史问题',
  'ai-generated': 'AI 生成场景',
};

const textToVideo = 'text-to-video';
const imageToVideo = 'image-to-video';
const firstLastFrame = 'first-last-frame';
const omniReference = 'omni-reference';
const videoEditing = 'video-editing';
const modelManagement = 'model-management';
const billing = 'billing';
const taskSubmission = 'task-submission';

/** 50 个真实 TestCase（顺序：P0×5 → P1×5 → 边界×10 → 异常×10 → 历史×10 → AI×10） */
export const WAN3_CATALOG: Wan3TestCase[] = [
  // ══════════ P0（5 个；前 4 个复用现有 src/cases/wan3/ 资产） ══════════
  {
    id: 'WAN3-CORE-001', category: 'p0', priority: 'P0', business: textToVideo, feature: 'wan3/text-to-video',
    title: 'Wan3.0 文生视频-落日海岸（task_type=105 纯文本生成）',
    preconditions: '已登录；Wan 3.0 模型可用（selmodelsId=84）；积分充足',
    steps: [
      '打开视频制作页，选择 Wan 3.0 文生视频',
      '输入提示词"落日余晖洒在金色海岸…"并生成',
      '核对任务创建、落库、播放展示',
    ],
    expected: '任务创建成功；提交接口 code=1；结果可正常播放；扣费与模型价格一致',
    source: 'reuse:wan3-cases/wensheng.ts',
    reuseOf: 'src/cases/wan3/wensheng.ts',
    extra: { task_type: '105', workflow_type: 'qntk', model_id: '84', duration: '4', resolution: '720p', ratio: '9:16' },
  },
  {
    id: 'WAN3-CORE-002', category: 'p0', priority: 'P0', business: imageToVideo, feature: 'wan3/image-to-video',
    title: 'Wan3.0 图生视频-海岸参考图（ref_images 上传落库）',
    preconditions: '已登录；Wan 3.0 可用；一张 1080p 参考图',
    steps: [
      '进入 Wan 3.0 图生视频 Tab',
      '上传参考图并生成',
      '核对图片预览与生成结果一致性',
    ],
    expected: '参考图上传成功并落库；生成结果与参考图内容一致；扣费正确',
    source: 'reuse:wan3-cases/tusheng.ts',
    reuseOf: 'src/cases/wan3/tusheng.ts',
    extra: { task_type: '105', workflow_type: 'qntk', ref_images: 1 },
  },
  {
    id: 'WAN3-CORE-003', category: 'p0', priority: 'P0', business: omniReference, feature: 'wan3/omni-reference',
    title: 'Wan3.0 全能参考-视频音频（ref_videos + ref_audios 多素材）',
    preconditions: '已登录；Wan 3.0 可用；一段参考视频 + 一段参考音频',
    steps: [
      '进入 Wan 3.0 全能参考 Tab',
      '上传参考视频与音频并生成',
      '核对视频/音频预览与生成结果',
    ],
    expected: '多素材上传全部落库；生成结果保留参考视频动作与音频节奏；扣费正确',
    source: 'reuse:wan3-cases/quanneng.ts',
    reuseOf: 'src/cases/wan3/quanneng.ts',
    extra: { task_type: '105', workflow_type: 'qntk', ref_videos: 1, ref_audios: 1 },
  },
  {
    id: 'WAN3-CORE-004', category: 'p0', priority: 'P0', business: firstLastFrame, feature: 'wan3/first-last-frame',
    title: 'Wan3.0 首尾帧-日出日落（first_frame/last_frame 过渡）',
    preconditions: '已登录；Wan 3.0 可用；首帧与尾帧图片各一张',
    steps: [
      '进入 Wan 3.0 首尾帧 Tab',
      '上传首帧与尾帧图片并生成',
      '核对两帧展示与过渡效果',
    ],
    expected: '首尾帧链路提交成功（task_type=106/swzsp）；过渡自然；扣费正确',
    source: 'reuse:wan3-cases/shouwei.ts',
    reuseOf: 'src/cases/wan3/shouwei.ts',
    extra: { task_type: '106', workflow_type: 'swzsp', first_frame: 1, last_frame: 1 },
  },
  {
    id: 'WAN3-CORE-005', category: 'p0', priority: 'P0', business: textToVideo, feature: 'wan3/text-to-video',
    title: '文生视频 12s 长视频-竖屏 9:16 高清',
    preconditions: '已登录；Wan 3.0 可用；积分充足',
    steps: ['选择 12s 时长与 9:16 竖屏', '输入复杂场景提示词并生成', '核对长视频完整性与画质'],
    expected: '12s 长视频正常生成；9:16 竖屏不被拉伸为横屏；清晰度达到选择档位',
    source: 'onboarding:wan3',
    extra: { duration: '12', ratio: '9:16', resolution: '1080p' },
  },

  // ══════════ P1（5 个；前 1 个复用现有资产） ══════════
  {
    id: 'WAN3-BILL-003', category: 'p1', priority: 'P1', business: billing, feature: 'wan3/billing',
    title: '幂等性验证-复用 task_id 不重复扣费',
    preconditions: '已有一个已完成任务及其 task_id；积分快照可用',
    steps: [
      '先执行任一 WAN3 用例获取 task_id',
      '复用该 task_id 提交本用例',
      '核对提交是否被跳过、快照差值 actualConsumed',
    ],
    expected: '复用已有任务不触发提交；actualConsumed=0；billing-check 全部通过',
    source: 'reuse:wan3-cases/idempotent.ts',
    reuseOf: 'src/cases/wan3/idempotent.ts',
    extra: { task_type: '101', workflow_type: 'qntk', expected_points: 0 },
  },
  {
    id: 'WAN3-CORE-006', category: 'p1', priority: 'P1', business: videoEditing, feature: 'wan3/video-editing',
    title: '视频编辑-续写扩展（对已生成视频继续生成下一段）',
    preconditions: '已登录；有一段已生成视频',
    steps: ['对已生成视频执行续写扩展', '补充提示词并生成', '核对两段视频衔接'],
    expected: '续写任务创建成功；与前段画面/风格衔接；扣费正确',
    source: 'onboarding:wan3',
  },
  {
    id: 'WAN3-CORE-007', category: 'p1', priority: 'P1', business: modelManagement, feature: 'wan3/model-management',
    title: '模型切换-历史任务兼容（Wan 2.x 任务查看不报错）',
    preconditions: '存在 Wan 2.x 生成的历史任务',
    steps: ['切换到 Wan 3.0', '打开历史任务列表与详情', '核对模型信息展示与播放'],
    expected: '历史任务正常展示与播放；模型字段显示原模型；不报错',
    source: 'onboarding:wan3',
  },
  {
    id: 'WAN3-CORE-008', category: 'p1', priority: 'P1', business: taskSubmission, feature: 'wan3/task-submission',
    title: '生成任务列表-状态流转实时展示',
    preconditions: '已提交多个生成任务',
    steps: ['打开任务列表页', '观察任务状态实时刷新', '核对 QUEUED→RUNNING→SUCCESS 流转'],
    expected: '状态实时刷新且流转正确；失败任务展示失败原因；无状态卡死',
    source: 'onboarding:wan3',
  },
  {
    id: 'WAN3-CORE-009', category: 'p1', priority: 'P1', business: taskSubmission, feature: 'wan3/task-submission',
    title: '素材上传-大文件 mp4 校验',
    preconditions: '已登录；准备一个接近上传上限的 mp4 文件',
    steps: ['上传大体积 mp4', '观察上传进度与耗时', '提交生成'],
    expected: '大文件上传成功且有进度提示；提交不超时；文件可被正确引用',
    source: 'onboarding:wan3',
  },

  // ══════════ 边界（10 个；前 2 个复用现有资产） ══════════
  {
    id: 'WAN3-BND-001', category: 'boundary', priority: 'P1', business: taskSubmission, feature: 'wan3/task-submission',
    title: '接口边界-缺失提示词 cueword 为空',
    preconditions: '已登录',
    steps: ['提交任务时 cueword 为空', '核对 API 返回', '核对是否扣费'],
    expected: 'API 拒绝提交（code≠1）；错误信息含"提示词/必填"；不扣费',
    source: 'reuse:wan3-cases/int-02-missing-cueword.ts',
    reuseOf: 'src/cases/wan3/int-02-missing-cueword.ts',
    extra: { task_type: '101', workflow_type: 'qntk', expected_points: 0 },
  },
  {
    id: 'WAN3-BND-002', category: 'boundary', priority: 'P1', business: taskSubmission, feature: 'wan3/task-submission',
    title: '接口边界-超长提示词 10000 字符',
    preconditions: '已登录',
    steps: ['提交 cueword 长度=10000 字符', '核对 API 返回', '核对是否异常扣费'],
    expected: 'API 拒绝（code≠1）或按上限截断；不产生异常扣费；服务端不异常',
    source: 'reuse:wan3-cases/int-05-extra-long-cueword.ts',
    reuseOf: 'src/cases/wan3/int-05-extra-long-cueword.ts',
    extra: { task_type: '101', workflow_type: 'qntk', cueword_len: 10000, expected_points: 0 },
  },
  {
    id: 'WAN3-BND-003', category: 'boundary', priority: 'P2', business: textToVideo, feature: 'wan3/text-to-video',
    title: '提示词最小长度-单字符',
    preconditions: '已登录',
    steps: ['提交 cueword 为单字符', '核对 API 返回'],
    expected: '按规则接受或给出明确最小长度提示；不产生脏数据',
    source: 'onboarding:wan3',
  },
  {
    id: 'WAN3-BND-004', category: 'boundary', priority: 'P2', business: textToVideo, feature: 'wan3/text-to-video',
    title: '提示词长度上界-恰好等于最大允许值',
    preconditions: '已登录；已知提示词最大长度 N',
    steps: ['构造恰好 N 字符的提示词提交', '核对 API 返回'],
    expected: '恰好等于上限时正常提交；超过 1 字符被拒；边界无 500',
    source: 'onboarding:wan3',
  },
  {
    id: 'WAN3-BND-005', category: 'boundary', priority: 'P1', business: textToVideo, feature: 'wan3/text-to-video',
    title: '时长边界-1s 与最大时长',
    preconditions: '已登录',
    steps: ['分别提交 duration=1s 与最大值', '核对生成结果'],
    expected: '1s 正常生成；最大值正常生成；超出最大值被拒',
    source: 'onboarding:wan3',
  },
  {
    id: 'WAN3-BND-006', category: 'boundary', priority: 'P1', business: textToVideo, feature: 'wan3/text-to-video',
    title: '分辨率边界-480p/720p/1080p',
    preconditions: '已登录',
    steps: ['分别选择 480p/720p/1080p 生成', '核对输出分辨率'],
    expected: '各档位输出分辨率与选择一致；720p 默认值正确；无错位',
    source: 'onboarding:wan3',
  },
  {
    id: 'WAN3-BND-007', category: 'boundary', priority: 'P1', business: textToVideo, feature: 'wan3/text-to-video',
    title: '宽高比边界-9:16/16:9/1:1',
    preconditions: '已登录',
    steps: ['分别选择三种宽高比生成', '核对输出比例'],
    expected: '输出比例与选择一致；9:16 不被裁切；16:9 不被拉伸',
    source: 'onboarding:wan3',
  },
  {
    id: 'WAN3-BND-008', category: 'boundary', priority: 'P2', business: imageToVideo, feature: 'wan3/image-to-video',
    title: '参考图数量边界-1 张与上限',
    preconditions: '已登录；多张参考图',
    steps: ['分别上传 1 张与上限数量的参考图', '提交生成'],
    expected: '1 张正常；达到上限正常；超出上限被拒并提示',
    source: 'onboarding:wan3',
  },
  {
    id: 'WAN3-BND-009', category: 'boundary', priority: 'P2', business: omniReference, feature: 'wan3/omni-reference',
    title: '参考视频时长边界-最小时长与最大时长',
    preconditions: '已登录；长短两段参考视频',
    steps: ['分别上传最短与最长参考视频', '提交生成'],
    expected: '边界时长视频正常处理；超出范围被拒；不导致服务端超时',
    source: 'onboarding:wan3',
  },
  {
    id: 'WAN3-BND-010', category: 'boundary', priority: 'P2', business: firstLastFrame, feature: 'wan3/first-last-frame',
    title: '首尾帧边界-首帧与尾帧相同图片',
    preconditions: '已登录；同一张图作为首尾帧',
    steps: ['上传相同图片作为 first_frame 与 last_frame', '提交生成'],
    expected: '提交被接受或给出明确提示；不产生静态/异常结果；不崩溃',
    source: 'onboarding:wan3',
  },

  // ══════════ 异常（10 个；前 2 个复用现有资产） ══════════
  {
    id: 'WAN3-EXC-001', category: 'exception', priority: 'P0', business: taskSubmission, feature: 'wan3/task-submission',
    title: '接口异常-非法 task_type=999',
    preconditions: '已登录',
    steps: ['提交 task_type=999', '核对 API 返回', '核对是否扣费'],
    expected: 'API 拒绝（code≠1）；错误信息含"类型/非法"；不扣费',
    source: 'reuse:wan3-cases/int-03-invalid-task-type.ts',
    reuseOf: 'src/cases/wan3/int-03-invalid-task-type.ts',
    extra: { task_type: '999', workflow_type: 'qntk', expected_points: 0 },
  },
  {
    id: 'WAN3-EXC-002', category: 'exception', priority: 'P0', business: taskSubmission, feature: 'wan3/task-submission',
    title: '接口异常-空 model_id',
    preconditions: '已登录',
    steps: ['提交 model_id 为空', '核对 API 返回', '核对是否扣费'],
    expected: 'API 拒绝（code≠1）；错误信息含"模型/必填"；不扣费',
    source: 'reuse:wan3-cases/int-04-empty-model-id.ts',
    reuseOf: 'src/cases/wan3/int-04-empty-model-id.ts',
    extra: { task_type: '101', workflow_type: 'qntk', expected_points: 0 },
  },
  {
    id: 'WAN3-EXC-003', category: 'exception', priority: 'P1', business: modelManagement, feature: 'wan3/model-management',
    title: '接口异常-不存在的模型 ID',
    preconditions: '已登录',
    steps: ['提交一个不存在的 selmodelsId', '核对 API 返回'],
    expected: 'API 拒绝（code≠1）；提示模型不存在；不产生扣费与脏任务',
    source: 'onboarding:wan3',
  },
  {
    id: 'WAN3-EXC-004', category: 'exception', priority: 'P1', business: imageToVideo, feature: 'wan3/image-to-video',
    title: '接口异常-参考图格式/体积不支持',
    preconditions: '已登录；一张超限或异常格式图片',
    steps: ['上传不支持格式或超大图片', '提交生成'],
    expected: '上传被拒或生成前校验拦截；提示格式/体积问题；不扣费',
    source: 'onboarding:wan3',
  },
  {
    id: 'WAN3-EXC-005', category: 'exception', priority: 'P1', business: omniReference, feature: 'wan3/omni-reference',
    title: '接口异常-参考视频损坏/编码不支持',
    preconditions: '已登录；一段损坏或特殊编码视频',
    steps: ['上传损坏/特殊编码视频', '提交生成'],
    expected: '明确报错提示素材不可用；不扣费；服务端不崩溃',
    source: 'onboarding:wan3',
  },
  {
    id: 'WAN3-EXC-006', category: 'exception', priority: 'P2', business: omniReference, feature: 'wan3/omni-reference',
    title: '接口异常-音频格式不支持',
    preconditions: '已登录；一段不支持格式的音频',
    steps: ['上传不支持格式音频', '提交生成'],
    expected: '明确报错提示音频格式不支持；不扣费',
    source: 'onboarding:wan3',
  },
  {
    id: 'WAN3-EXC-007', category: 'exception', priority: 'P0', business: billing, feature: 'wan3/billing',
    title: '计费异常-积分余额不足',
    preconditions: '已登录；积分低于生成所需',
    steps: ['提交生成任务', '核对余额校验与提示'],
    expected: '余额不足时拒绝生成；提示充值；不产生负积分任务',
    source: 'onboarding:wan3',
  },
  {
    id: 'WAN3-EXC-008', category: 'exception', priority: 'P1', business: billing, feature: 'wan3/billing',
    title: '计费异常-积分快照差值异常（actualConsumed 非法）',
    preconditions: '已登录；可构造快照差值异常',
    steps: ['触发快照差值校验', '核对 billing-check'],
    expected: '快照差值非法时告警并拦截；不重复扣费；记账可审计',
    source: 'onboarding:wan3',
  },
  {
    id: 'WAN3-EXC-009', category: 'exception', priority: 'P1', business: taskSubmission, feature: 'wan3/task-submission',
    title: '接口异常-提交超时（网关超时重试）',
    preconditions: '已登录；可模拟提交超时',
    steps: ['触发提交超时', '核对重试逻辑与结果'],
    expected: '超时后重试不重复创建任务；最终结果可查询；不产生重复扣费',
    source: 'onboarding:wan3',
  },
  {
    id: 'WAN3-EXC-010', category: 'exception', priority: 'P1', business: taskSubmission, feature: 'wan3/task-submission',
    title: '生成异常-服务端 5xx 中途失败',
    preconditions: '已登录；服务端可模拟 5xx',
    steps: ['提交后服务端中途返回 5xx', '核对任务状态与重试'],
    expected: '任务标记失败并展示失败原因；重试可恢复；扣费与失败状态一致',
    source: 'onboarding:wan3',
  },

  // ══════════ 历史问题（10 个；真实历史缺陷回归） ══════════
  {
    id: 'WAN3-HIS-001', category: 'history', priority: 'P0', business: textToVideo, feature: 'wan3/text-to-video',
    title: '回归-竖屏视频生成后被横屏播放（宽高比丢失）',
    preconditions: '已登录；9:16 生成任务',
    steps: ['生成 9:16 视频', '在播放器播放', '核对宽高比'],
    expected: '播放器按 9:16 展示；不拉伸为横屏；无历史缺陷复现',
    source: 'onboarding:wan3',
  },
  {
    id: 'WAN3-HIS-002', category: 'history', priority: 'P1', business: omniReference, feature: 'wan3/omni-reference',
    title: '回归-参考视频被裁切（ref_videos 未按原始比例）',
    preconditions: '已登录；已知比例参考视频',
    steps: ['上传参考视频生成', '核对输出是否保留原始比例'],
    expected: '输出保留参考视频原始比例；不被裁切变形',
    source: 'onboarding:wan3',
  },
  {
    id: 'WAN3-HIS-003', category: 'history', priority: 'P1', business: firstLastFrame, feature: 'wan3/first-last-frame',
    title: '回归-首尾帧过渡生硬（无插帧）',
    preconditions: '已登录；首尾帧场景',
    steps: ['生成首尾帧视频', '人工评估过渡自然度'],
    expected: '首尾帧过渡平滑；无明显跳帧/生硬切换',
    source: 'onboarding:wan3',
  },
  {
    id: 'WAN3-HIS-004', category: 'history', priority: 'P0', business: billing, feature: 'wan3/billing',
    title: '回归-积分重复扣费（幂等缺失）',
    preconditions: '已登录；可快速重复提交',
    steps: ['快速连续两次提交同一任务', '核对积分扣减'],
    expected: '仅扣一次积分；快照差值正确；无历史重复扣费缺陷',
    source: 'onboarding:wan3',
  },
  {
    id: 'WAN3-HIS-005', category: 'history', priority: 'P1', business: modelManagement, feature: 'wan3/model-management',
    title: '回归-模型切换后任务类型错乱',
    preconditions: '已登录；多模型可用',
    steps: ['切换模型后提交任务', '核对任务类型与模型一致'],
    expected: '任务类型与所选模型匹配；不串类型',
    source: 'onboarding:wan3',
  },
  {
    id: 'WAN3-HIS-006', category: 'history', priority: 'P1', business: taskSubmission, feature: 'wan3/task-submission',
    title: '回归-任务状态卡死 RUNNING 不更新',
    preconditions: '已登录；存在长时间 RUNNING 任务',
    steps: ['观察 RUNNING 任务超时后状态', '核对超时回收'],
    expected: '超时任务被标记失败或重试；不永久卡死 RUNNING',
    source: 'onboarding:wan3',
  },
  {
    id: 'WAN3-HIS-007', category: 'history', priority: 'P1', business: taskSubmission, feature: 'wan3/task-submission',
    title: '回归-素材上传成功但提交报"素材不存在"',
    preconditions: '已登录',
    steps: ['上传素材成功', '立即提交生成', '核对素材引用'],
    expected: '提交不报"素材不存在"；上传与提交数据一致',
    source: 'onboarding:wan3',
  },
  {
    id: 'WAN3-HIS-008', category: 'history', priority: 'P2', business: taskSubmission, feature: 'wan3/task-submission',
    title: '回归-生成结果 URL 过期 404',
    preconditions: '已登录；生成完成视频',
    steps: ['等待结果 URL 过期时间', '访问结果链接'],
    expected: '结果在有效期内可访问；过期有明确提示并可重新生成',
    source: 'onboarding:wan3',
  },
  {
    id: 'WAN3-HIS-009', category: 'history', priority: 'P1', business: omniReference, feature: 'wan3/omni-reference',
    title: '回归-视频与音频不同步',
    preconditions: '已登录；带参考音频任务',
    steps: ['生成带音频视频', '核对音画同步'],
    expected: '音频与画面同步；无人声与口型错位',
    source: 'onboarding:wan3',
  },
  {
    id: 'WAN3-HIS-010', category: 'history', priority: 'P1', business: taskSubmission, feature: 'wan3/task-submission',
    title: '回归-弱网双击提交导致重复任务',
    preconditions: '已登录；模拟弱网',
    steps: ['弱网下快速点击两次提交', '核对任务数量与扣费'],
    expected: '仅创建一次任务并扣一次费；有防重复机制',
    source: 'onboarding:wan3',
  },

  // ══════════ AI 生成场景（10 个） ══════════
  {
    id: 'WAN3-AI-001', category: 'ai-generated', priority: 'P1', business: textToVideo, feature: 'wan3/text-to-video',
    title: 'AI 场景-多人同屏动作一致性',
    preconditions: '已登录；多人场景提示词',
    steps: ['生成多人场景视频', '评估多人动作一致性'],
    expected: '多人动作/交互合理一致；无肢体穿模',
    source: 'onboarding:wan3',
  },
  {
    id: 'WAN3-AI-002', category: 'ai-generated', priority: 'P2', business: textToVideo, feature: 'wan3/text-to-video',
    title: 'AI 场景-风格迁移（油画/水墨/赛博朋克）',
    preconditions: '已登录',
    steps: ['以指定画风提示词生成', '评估风格还原度'],
    expected: '风格特征明显还原；色彩/笔触符合目标画风',
    source: 'onboarding:wan3',
  },
  {
    id: 'WAN3-AI-003', category: 'ai-generated', priority: 'P1', business: textToVideo, feature: 'wan3/text-to-video',
    title: 'AI 场景-文字/Logo 生成准确率',
    preconditions: '已登录',
    steps: ['生成含指定文字/Logo 的视频', '核对文字正确性'],
    expected: '关键文字正确无乱码；Logo 形似且不翻转',
    source: 'onboarding:wan3',
  },
  {
    id: 'WAN3-AI-004', category: 'ai-generated', priority: 'P2', business: textToVideo, feature: 'wan3/text-to-video',
    title: 'AI 场景-镜头运动指令（推/拉/摇/移）',
    preconditions: '已登录',
    steps: ['以镜头运动指令生成', '评估运镜是否符合'],
    expected: '镜头运动方向/幅度符合指令；无突兀跳变',
    source: 'onboarding:wan3',
  },
  {
    id: 'WAN3-AI-005', category: 'ai-generated', priority: 'P1', business: imageToVideo, feature: 'wan3/image-to-video',
    title: 'AI 场景-多参考图角色一致性',
    preconditions: '已登录；多张同一角色参考图',
    steps: ['上传多张同一角色图生成', '核对角色一致性'],
    expected: '生成角色与参考图一致；五官/服饰不漂移',
    source: 'onboarding:wan3',
  },
  {
    id: 'WAN3-AI-006', category: 'ai-generated', priority: 'P1', business: omniReference, feature: 'wan3/omni-reference',
    title: 'AI 场景-音频驱动口型/节奏对齐',
    preconditions: '已登录；带语音参考音频',
    steps: ['以语音音频驱动生成', '核对口型与节奏'],
    expected: '口型与语音对齐；节奏卡点准确',
    source: 'onboarding:wan3',
  },
  {
    id: 'WAN3-AI-007', category: 'ai-generated', priority: 'P2', business: textToVideo, feature: 'wan3/text-to-video',
    title: 'AI 场景-长镜头连贯性（镜头不跳变）',
    preconditions: '已登录',
    steps: ['生成长镜头视频', '评估镜头连续性'],
    expected: '长镜头内场景/主体连续；无莫名切换',
    source: 'onboarding:wan3',
  },
  {
    id: 'WAN3-AI-008', category: 'ai-generated', priority: 'P2', business: textToVideo, feature: 'wan3/text-to-video',
    title: 'AI 场景-极端光照/夜景画面质量',
    preconditions: '已登录',
    steps: ['生成夜景/逆光场景', '评估画面质量'],
    expected: '夜景细节保留；无大面积过曝/死黑噪点',
    source: 'onboarding:wan3',
  },
  {
    id: 'WAN3-AI-009', category: 'ai-generated', priority: 'P2', business: textToVideo, feature: 'wan3/text-to-video',
    title: 'AI 场景-中文提示词语义理解（多义/成语）',
    preconditions: '已登录',
    steps: ['以多义/成语提示词生成', '评估语义还原'],
    expected: '语义理解准确；无歧义误读导致画面错乱',
    source: 'onboarding:wan3',
  },
  {
    id: 'WAN3-AI-010', category: 'ai-generated', priority: 'P0', business: textToVideo, feature: 'wan3/text-to-video',
    title: 'AI 场景-负面提示词/违规内容拦截',
    preconditions: '已登录',
    steps: ['以违规/负面内容提示词生成', '核对内容安全拦截'],
    expected: '违规内容被拦截并提示；不生成违规画面；有审计记录',
    source: 'onboarding:wan3',
  },
];

/** 分类统计（供导入/报告/验收） */
export function wan3CatalogStats(catalog: Wan3TestCase[] = WAN3_CATALOG): Record<string, number> {
  const out: Record<string, number> = { p0: 0, p1: 0, boundary: 0, exception: 0, history: 0, 'ai-generated': 0, total: 0 };
  for (const c of catalog) {
    out[c.category] += 1;
    out.total += 1;
  }
  return out;
}
