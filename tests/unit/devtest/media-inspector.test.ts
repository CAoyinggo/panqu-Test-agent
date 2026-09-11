import { describe, expect, it } from 'vitest';
import {
  createSyntheticValidMp4,
  inspectBufferMedia,
  inspectImageBuffer,
  inspectMp4Buffer,
} from '../../../src/devtest/media-inspector.js';

describe('MediaInspector - 真实媒体物理校验器', () => {
  it('合法的完整 MP4 容器：成功解析 ftyp, moov, mvhd 时长与 tkhd 分辨率，校验通过', () => {
    const validMp4 = createSyntheticValidMp4({
      width: 1920,
      height: 1080,
      durationSeconds: 5,
      brand: 'mp42',
    });

    const result = inspectMp4Buffer(validMp4);

    expect(result.decodable).toBe(true);
    expect(result.qualityClassification).toBe('TASK_SUCCESS_AND_VALID');
    expect(result.format).toBe('mp4 (mp42)');
    expect(result.dimensions).toEqual({ width: 1920, height: 1080 });
    expect(result.durationSeconds).toBe(5);
    expect(result.hasVideoTrack).toBe(true);
    expect(result.hasMdat).toBe(true);
    expect(result.reasons).toHaveLength(0);
  });

  it('截断的 MP4（仅 12 字节 ftyp 魔数头，缺失 moov 与 mdat）：精确识别为 FILE_INVALID', () => {
    const truncatedMp4 = Buffer.from('00000018667479706d703432000000006d70343269736f6d', 'hex');

    const result = inspectMp4Buffer(truncatedMp4);

    expect(result.decodable).toBe(false);
    expect(result.qualityClassification).toBe('FILE_INVALID');
    expect(result.reasons.some((r) => r.includes('缺少 moov 元数据块'))).toBe(true);
  });

  it('缺失 mdat 实体数据块的 MP4：标记未检测到媒体实体数据并判 FAIL', () => {
    // 构造有 ftyp + moov 但无 mdat
    const full = createSyntheticValidMp4({ width: 640, height: 360, durationSeconds: 3 });
    // 查找 mdat 位置截断
    const mdatIndex = full.indexOf(Buffer.from('mdat', 'ascii')) - 4;
    const noMdat = full.slice(0, mdatIndex);

    const result = inspectMp4Buffer(noMdat);

    expect(result.decodable).toBe(false);
    expect(result.hasMdat).toBe(false);
    expect(result.reasons.some((r) => r.includes('mdat'))).toBe(true);
  });

  it('合法的标准 PNG 图像：从 IHDR 块正确提取 1024x1024 尺寸，校验通过', () => {
    const pngBuffer = Buffer.concat([
      Buffer.from('89504e470d0a1a0a0000000d4948445200000400000004000806000000', 'hex'),
      Buffer.alloc(32),
    ]);

    const result = inspectImageBuffer(pngBuffer);

    expect(result.decodable).toBe(true);
    expect(result.format).toBe('png');
    expect(result.dimensions).toEqual({ width: 1024, height: 1024 });
    expect(result.qualityClassification).toBe('TASK_SUCCESS_AND_VALID');
  });

  it('完全无法识别或损坏的非多媒体 Buffer：安全返回 FILE_INVALID，不抛未捕获异常', () => {
    const badBuffer = Buffer.from('hello_this_is_plain_text_not_media');

    const videoResult = inspectBufferMedia(badBuffer, 'video');
    expect(videoResult.decodable).toBe(false);
    expect(videoResult.qualityClassification).toBe('FILE_INVALID');

    const imageResult = inspectBufferMedia(badBuffer, 'image');
    expect(imageResult.decodable).toBe(false);
    expect(imageResult.qualityClassification).toBe('FILE_INVALID');
  });
});
