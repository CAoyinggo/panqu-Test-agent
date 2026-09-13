/**
 * 盼趣业务能力与参数映射知识库（Business Capability Knowledge Base）
 *
 * 确定性定义：
 * 1. 核心业务模型实体（Wan 3.0, Wan 3.0 Prime, Seedance 2.0, RunningHub nano banana 2, Pan Banana Pro 等）
 * 2. 刊例价与积分计费模型
 * 3. 渠道分流规则与 NewAPI/火山映射字段
 * 4. 上游供应商成本与定价标准
 * 5. 全链路必须证据项（Evidence Requirements）
 * 6. 业务参数组合合法性校验（拦截非法参数、分流冲突与参数倒置）
 *
 * 坚决排除画布（Canvas）模块。
 */

export type MediaType = 'video' | 'image';

export type DiversionChannel = 'NEWAPI' | 'VOLCENGINE' | 'MAIN_SITE' | 'TD_UPSTREAM';

export interface ModelPricingRule {
  unit: 'SECOND' | 'IMAGE';
  defaultPoints: number;
  resolutionMultiplier?: Record<string, number>;
}

export interface ModelUpstreamSpec {
  defaultChannel: DiversionChannel;
  fallbackChannel?: DiversionChannel;
  newapiModel?: string;
  upstreamModelId?: string;
  diversionField: 'extra.diversion' | 'extra.newapi_image' | 'direct';
  expectedDiversionValue: number | string;
  costCnyPerSec?: number;
  costCnyPerImage?: number;
}

export interface BusinessCapabilitySpec {
  id: string;
  name: string;
  mediaType: MediaType;
  modelId: number;
  aliases?: number[];
  validTaskTypes: number[];
  validResolutions?: string[];
  validDurationsSec?: number[];
  validServiceLines?: string[];
  pricing: ModelPricingRule;
  upstream: ModelUpstreamSpec;
  mediaContainer: 'mp4' | 'png' | 'jpg';
  videoCodec?: 'h264' | 'hevc';
  requiredEvidences: string[];
  description: string;
}

/**
 * 盼趣核心业务模型定义知识库
 */
export const BUSINESS_CAPABILITY_REGISTRY: Record<string, BusinessCapabilitySpec> = {
  WAN_3_0: {
    id: 'WAN_3_0',
    name: 'Wan 3.0 (文生视频/图生视频)',
    mediaType: 'video',
    modelId: 84,
    validTaskTypes: [28, 105], // 28: NewAPI分流链路, 105: 直连兜底链路
    validResolutions: ['480p', '720p', '1080p'],
    validDurationsSec: [4, 5, 10],
    pricing: {
      unit: 'SECOND',
      defaultPoints: 7, // 7 pt/s (如 4s -> 28 pt, 5s -> 35 pt)
    },
    upstream: {
      defaultChannel: 'NEWAPI',
      newapiModel: 'wan3.0-video',
      diversionField: 'extra.diversion',
      expectedDiversionValue: 10,
      costCnyPerSec: 0.18, // 万相 Line 10 采购成本 ¥0.18/s
    },
    mediaContainer: 'mp4',
    videoCodec: 'h264',
    requiredEvidences: [
      'TASK_ID',
      'ROUTING_SNAPSHOT', // extra.diversion = 10
      'STATUS_POLLING',    // status 1 -> 2
      'BILLING_FLOW',      // type 2 扣除 28 pt (失败则退款 28 pt)
      'MEDIA_ARTIFACT',    // mp4 容器与 H.264
    ],
    description: '万相 Wan 3.0 旗舰视频生成，走 NewAPI 万相 Line 10 分流，标准计费 7 pt/s。',
  },

  WAN_3_0_PRIME: {
    id: 'WAN_3_0_PRIME',
    name: 'Wan 3.0 Prime (高清增强版)',
    mediaType: 'video',
    modelId: 88,
    validTaskTypes: [28],
    validResolutions: ['480p', '720p'],
    validDurationsSec: [4, 5],
    pricing: {
      unit: 'SECOND',
      defaultPoints: 11, // 480p: 11 pt/s (4s=44pt), 720p: 22 pt/s (4s=88pt)
      resolutionMultiplier: {
        '480p': 11,
        '720p': 22,
      },
    },
    upstream: {
      defaultChannel: 'NEWAPI',
      newapiModel: 'wan3.0-video-prime',
      diversionField: 'extra.diversion',
      expectedDiversionValue: 10,
      costCnyPerSec: 0.28,
    },
    mediaContainer: 'mp4',
    videoCodec: 'h264',
    requiredEvidences: ['TASK_ID', 'ROUTING_SNAPSHOT', 'STATUS_POLLING', 'BILLING_FLOW', 'MEDIA_ARTIFACT'],
    description: '万相 Wan 3.0 Prime，区分 480P 与 720P 阶梯计费。',
  },

  SEEDANCE_2_0: {
    id: 'SEEDANCE_2_0',
    name: 'Seedance 2.0 (多渠道视频生成)',
    mediaType: 'video',
    modelId: 15,
    aliases: [41],
    validTaskTypes: [28],
    validResolutions: ['480p', '720p'],
    validDurationsSec: [4, 5],
    pricing: {
      unit: 'SECOND',
      defaultPoints: 15, // 480p: 15 pt/s (4s=60pt), 720p: 30 pt/s (4s=120pt)
      resolutionMultiplier: {
        '480p': 15,
        '720p': 30,
      },
    },
    upstream: {
      defaultChannel: 'NEWAPI',
      fallbackChannel: 'VOLCENGINE',
      newapiModel: 'seedance-2.0',
      upstreamModelId: 'ep-m-20260304221217-txclm',
      diversionField: 'extra.diversion',
      expectedDiversionValue: 10,
      costCnyPerSec: 0.3696, // TD 上游成本 ¥0.3696/s, 若降级火山成本为 ¥0.7952/s
    },
    mediaContainer: 'mp4',
    videoCodec: 'h264',
    requiredEvidences: ['TASK_ID', 'ROUTING_SNAPSHOT', 'STATUS_POLLING', 'BILLING_FLOW', 'MEDIA_ARTIFACT'],
    description: 'Seedance 2.0，支持 NewAPI TD 渠道与火山引擎自动兜底降级。',
  },

  RUNNINGHUB_NANO_BANANA_2: {
    id: 'RUNNINGHUB_NANO_BANANA_2',
    name: 'RunningHub nano banana 2 (场景生图)',
    mediaType: 'image',
    modelId: 201,
    validTaskTypes: [1],
    validServiceLines: ['r', 'runninghub'],
    pricing: {
      unit: 'IMAGE',
      defaultPoints: 5, // 固定单张 5 pt
    },
    upstream: {
      defaultChannel: 'NEWAPI',
      newapiModel: 'runninghub-nano-banana-2',
      diversionField: 'extra.newapi_image',
      expectedDiversionValue: 1,
      costCnyPerImage: 0.05,
    },
    mediaContainer: 'png',
    requiredEvidences: [
      'TASK_ID',
      'ROUTING_SNAPSHOT', // extra.newapi_image = 1
      'STATUS_POLLING',
      'BILLING_FLOW',      // 5 pt
      'MEDIA_ARTIFACT',    // png/jpg 格式
    ],
    description: 'RunningHub 场景生图，走 NewAPI 生图分流 (extra.newapi_image=1)，单张 5 pt。',
  },

  PAN_BANANA_PRO: {
    id: 'PAN_BANANA_PRO',
    name: 'Pan Banana Pro (NewAPI 生图)',
    mediaType: 'image',
    modelId: 12,
    validTaskTypes: [1],
    validServiceLines: ['r'],
    pricing: {
      unit: 'IMAGE',
      defaultPoints: 10,
    },
    upstream: {
      defaultChannel: 'NEWAPI',
      newapiModel: 'pan-banana-pro',
      diversionField: 'extra.newapi_image',
      expectedDiversionValue: 1,
      costCnyPerImage: 0.08,
    },
    mediaContainer: 'png',
    requiredEvidences: ['TASK_ID', 'ROUTING_SNAPSHOT', 'STATUS_POLLING', 'BILLING_FLOW', 'MEDIA_ARTIFACT'],
    description: 'Pan Banana Pro 生图模型，按 extra.newapi_image=1 验证 NewAPI 生图分流，单张 10 pt。',
  },
};

/**
 * 根据 modelId 匹配业务能力规范
 */
export function getCapabilityByModel(modelId: number, mediaType?: MediaType): BusinessCapabilitySpec | undefined {
  const all = Object.values(BUSINESS_CAPABILITY_REGISTRY);
  const found = all.find((spec) => {
    const matchId = spec.modelId === modelId || (spec.aliases && spec.aliases.includes(modelId));
    if (!matchId) return false;
    if (mediaType && spec.mediaType !== mediaType) return false;
    return true;
  });
  return found;
}

/**
 * 业务参数组合合法性校验（用于识别“非法业务组合”与反向测试）
 */
export interface BusinessCombinationInput {
  mediaType: MediaType;
  modelId: number;
  taskType?: number;
  serviceline?: string;
  duration?: number;
  resolution?: string;
  aspectRatio?: string;
}

export interface BusinessCombinationValidationResult {
  valid: boolean;
  spec?: BusinessCapabilitySpec;
  violations: string[];
  suggestedAction: 'EXECUTE' | 'REJECT_WITH_400' | 'FALLBACK_ROUTING';
}

export function validateBusinessCombination(input: BusinessCombinationInput): BusinessCombinationValidationResult {
  const violations: string[] = [];
  const spec = getCapabilityByModel(input.modelId);

  if (!spec) {
    violations.push(`未知的业务模型 ID: ${input.modelId}`);
    return {
      valid: false,
      violations,
      suggestedAction: 'REJECT_WITH_400',
    };
  }

  // 1. 媒体类型与模型类型冲突
  if (spec.mediaType !== input.mediaType) {
    violations.push(`媒体类型冲突: 模型 ${spec.name} 属于 ${spec.mediaType}，但请求声明为 ${input.mediaType}`);
  }

  // 2. 视频特有参数校验
  if (spec.mediaType === 'video') {
    if (input.duration !== undefined) {
      if (input.duration <= 0) {
        violations.push(`无效视频时长: duration=${input.duration} 必须大于 0`);
      } else if (spec.validDurationsSec && !spec.validDurationsSec.includes(input.duration)) {
        violations.push(`不支持的视频时长: ${input.duration}s，该模型仅支持: ${spec.validDurationsSec.join(', ')}s`);
      }
    }
    if (input.taskType !== undefined && !spec.validTaskTypes.includes(input.taskType)) {
      violations.push(`不兼容的 task_type=${input.taskType}，模型仅支持: ${spec.validTaskTypes.join(', ')}`);
    }
    if (input.serviceline) {
      violations.push(`视频请求中包含了生图专用的 serviceline='${input.serviceline}' 参数`);
    }
  }

  // 3. 图片特有参数校验
  if (spec.mediaType === 'image') {
    if (input.duration !== undefined) {
      violations.push(`生图请求中包含了视频专用的 duration=${input.duration} 参数`);
    }
    if (input.serviceline && spec.validServiceLines && !spec.validServiceLines.includes(input.serviceline)) {
      violations.push(`不支持的生图 serviceline='${input.serviceline}'，仅支持: ${spec.validServiceLines.join(', ')}`);
    }
  }

  const valid = violations.length === 0;
  return {
    valid,
    spec,
    violations,
    suggestedAction: valid ? 'EXECUTE' : 'REJECT_WITH_400',
  };
}
