// 报告器统一接口：任何报告格式实现本接口即可被引擎使用
import type { ReportData } from '../core/types.js';

export interface Reporter {
  /** 报告器名称（--reporter 值） */
  name: string;
  /** 生成报告，返回文件路径（可返回多个） */
  write(outputDir: string, slugBase: string, data: ReportData): string[];
}
