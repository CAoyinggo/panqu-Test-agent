import { lstat, readFile, readdir, realpath, mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { missionAssert } from './panqu-mission-plan.js';
import type { PanquMissionMaterial } from './panqu-mission-types.js';

const exec = promisify(execFile);
const DEMUXERS = 'mov,matroska,avi,wav,mp3,png_pipe,jpeg_pipe,webp_pipe';
const EXTENSIONS = new Set(['.mp4', '.mov', '.webm', '.mkv', '.avi', '.wav', '.mp3', '.png', '.jpg', '.jpeg', '.webp']);
export interface PanquMediaTools { ffprobe: string; ffmpeg: string }
export interface PanquReferenceClipSpec { source: string; width: number; height: number; durationSeconds: number; codec: 'h264' | 'mpeg4'; maxBytes: number }

/** Make a bounded non-sensitive reference clip in a new directory; never modify a user original. */
export async function prepareMissionReferenceClip(parent: string, spec: PanquReferenceClipSpec, tools: PanquMediaTools): Promise<{ directory: string; material: PanquMissionMaterial }> {
  missionAssert(spec.source?.trim() && Number.isSafeInteger(spec.width) && Number.isSafeInteger(spec.height) && spec.width >= 16 && spec.height >= 16
    && spec.width % 2 === 0 && spec.height % 2 === 0 && spec.width * spec.height <= 1920 * 1080
    && Number.isFinite(spec.durationSeconds) && spec.durationSeconds >= 0.1 && spec.durationSeconds <= 10
    && ['h264', 'mpeg4'].includes(spec.codec) && Number.isSafeInteger(spec.maxBytes) && spec.maxBytes > 0 && spec.maxBytes <= 50 * 1024 * 1024,
  'MISSION_REFERENCE_CLIP_BOUNDS_INVALID');
  missionAssert(path.isAbsolute(tools.ffmpeg) && path.isAbsolute(tools.ffprobe), 'MISSION_MEDIA_TOOLS_REQUIRE_ABSOLUTE_PATHS');
  const base = await realpath(parent); const directory = await mkdtemp(path.join(base, 'panqu-reference-')); const file = path.join(directory, 'reference.mp4');
  try {
    await exec(tools.ffmpeg, ['-nostdin', '-v', 'error', '-threads', '1', '-f', 'lavfi', '-i', `testsrc2=size=${spec.width}x${spec.height}:rate=10:duration=${spec.durationSeconds}`,
      '-c:v', spec.codec === 'h264' ? 'libx264' : 'mpeg4', '-pix_fmt', 'yuv420p', '-an', file], { timeout: 15000, maxBuffer: 1024 * 1024 });
    const media = await inspectMissionMedia(file, tools, { maxBytes: spec.maxBytes, maxDurationSeconds: spec.durationSeconds + 0.1 });
    missionAssert(media.codec === spec.codec, 'MISSION_REFERENCE_CODEC_MISMATCH');
    return { directory, material: { file: 'reference.mp4', ...media } };
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}

/** User-approved roots only. Symlink traversal is rejected, including intermediate directories. */
export async function resolveMissionFile(root: string, relative: string): Promise<string> {
  missionAssert(relative && !path.isAbsolute(relative) && !relative.split(/[\\/]/).some(part => part === '..' || part === '.' || part.startsWith('.')), 'MISSION_MATERIAL_PATH_INVALID');
  const base = await realpath(root); let file = base;
  for (const part of relative.split(/[\\/]/)) { file = path.join(file, part); missionAssert(!(await lstat(file)).isSymbolicLink(), 'MISSION_MATERIAL_SYMLINK'); }
  missionAssert(file.startsWith(`${base}${path.sep}`), 'MISSION_MATERIAL_OUTSIDE_ROOT');
  return file;
}

/** Probe real container/codec data, then decode all bounded media; extensions alone are not evidence. */
export async function inspectMissionMedia(file: string, tools: PanquMediaTools, limits: { maxBytes?: number; maxDurationSeconds?: number } = {}): Promise<Omit<PanquMissionMaterial, 'file'>> {
  missionAssert(path.isAbsolute(tools.ffprobe) && path.isAbsolute(tools.ffmpeg), 'MISSION_MEDIA_TOOLS_REQUIRE_ABSOLUTE_PATHS');
  const info = await lstat(file); const maxBytes = limits.maxBytes ?? 50 * 1024 * 1024;
  missionAssert(info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= maxBytes, 'MISSION_MEDIA_SIZE_INVALID');
  const prefix = ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-format_whitelist', DEMUXERS];
  let parsed: { streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number; duration?: string }>; format?: { duration?: string; format_name?: string } };
  try {
    const probed = await exec(tools.ffprobe, [...prefix, '-show_streams', '-show_format', '-of', 'json', file], { timeout: 10000, maxBuffer: 1024 * 1024 });
    parsed = JSON.parse(probed.stdout);
  } catch { throw new Error('MISSION_MEDIA_UNDECODABLE'); }
  const visual = parsed.streams?.find(stream => stream.codec_type === 'video'); const audio = parsed.streams?.find(stream => stream.codec_type === 'audio');
  const still = /(?:png_pipe|jpeg_pipe|webp_pipe)/.test(parsed.format?.format_name ?? '');
  const kind = visual ? still ? 'image' : 'video' : audio ? 'audio' : undefined;
  missionAssert(kind, 'MISSION_MEDIA_TYPE_UNKNOWN');
  const duration = still ? undefined : Number(parsed.format?.duration ?? visual?.duration ?? audio?.duration);
  missionAssert(still || duration !== undefined && Number.isFinite(duration) && duration > 0 && duration <= (limits.maxDurationSeconds ?? 120), 'MISSION_MEDIA_DURATION_INVALID');
  if (visual) missionAssert(visual.width && visual.height && visual.width > 0 && visual.height > 0 && visual.width * visual.height <= 16_777_216, 'MISSION_MEDIA_DIMENSIONS_INVALID');
  try {
    await exec(tools.ffmpeg, ['-nostdin', '-v', 'error', '-xerror', '-max_alloc', '67108864', '-threads', '1', '-protocol_whitelist', 'file,pipe', '-format_whitelist', DEMUXERS,
      '-i', file, '-map', visual ? '0:v:0' : '0:a:0', '-f', 'null', '-'], { timeout: 15000, maxBuffer: 1024 * 1024 });
  } catch { throw new Error('MISSION_MEDIA_UNDECODABLE'); }
  const content = await readFile(file);
  missionAssert(content.length === info.size && content.length <= maxBytes, 'MISSION_MEDIA_CHANGED_DURING_INSPECTION');
  return { kind, sha256: createHash('sha256').update(content).digest('hex'), bytes: content.length, width: visual?.width, height: visual?.height,
    durationSeconds: duration, codec: visual?.codec_name ?? audio?.codec_name ?? 'unknown' };
}

/** Inventory is bounded and read-only. Rejected media is visible and is never silently uploaded. */
export async function inventoryMissionMedia(root: string, tools: PanquMediaTools): Promise<{ materials: PanquMissionMaterial[]; rejected: Array<{ file: string; code: string }> }> {
  const materials: PanquMissionMaterial[] = []; const rejected: Array<{ file: string; code: string }> = [];
  const base = await realpath(root); let entriesSeen = 0;
  async function walk(relative: string, depth: number): Promise<void> {
    for (const entry of (await readdir(path.join(base, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (++entriesSeen > 200 || materials.length + rejected.length >= 32) { rejected.push({ file: relative || '(root)', code: 'MISSION_MEDIA_SCAN_LIMIT' }); return; }
      if (entry.name.startsWith('.')) continue;
      const file = path.posix.join(relative, entry.name);
      if (entry.isSymbolicLink()) { rejected.push({ file, code: 'MISSION_MATERIAL_SYMLINK' }); continue; }
      if (entry.isDirectory()) { if (depth < 2) await walk(file, depth + 1); continue; }
      if (!entry.isFile() || !EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      try {
        const media = await inspectMissionMedia(await resolveMissionFile(base, file), tools);
        const extension = path.extname(file).toLowerCase();
        const expectedCodec = ({ '.png': 'png', '.jpg': 'mjpeg', '.jpeg': 'mjpeg', '.webp': 'webp', '.mp3': 'mp3' } as Record<string, string>)[extension];
        missionAssert(!expectedCodec || media.codec === expectedCodec, 'MISSION_MEDIA_EXTENSION_MISMATCH');
        missionAssert(!['.mp4', '.mov', '.webm', '.mkv', '.avi'].includes(extension) || media.kind === 'video', 'MISSION_MEDIA_EXTENSION_MISMATCH');
        materials.push({ file, ...media });
      }
      catch (error) { rejected.push({ file, code: error instanceof Error && /^MISSION_[A-Z_]+$/.test(error.message) ? error.message : 'MISSION_MEDIA_UNREADABLE' }); }
    }
  }
  await walk('', 0); return { materials, rejected };
}
