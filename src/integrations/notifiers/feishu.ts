// 飞书通知器：执行结束推送摘要卡片，失败时 @ 责任人
import type { Notifier } from './base.js';
import type { ExecutionSummary } from '../../utils/exit-code.js';
import type { CheckResult } from '../../core/types.js';
import { logger } from '../../utils/logger.js';

export class FeishuNotifier implements Notifier {
  webhook: string;
  mentionMobiles: string[];

  constructor(webhook: string, mentionMobiles: string[] = []) {
    this.webhook = webhook;
    this.mentionMobiles = mentionMobiles;
  }

  async notify(summary: ExecutionSummary, reportUrls?: string[]): Promise<void> {
    if (!this.webhook) {
      logger.warn('飞书 webhook 未配置，跳过通知');
      return;
    }

    const failed = summary.failed > 0;
    const payload = this.buildCard(summary, failed, reportUrls);

    try {
      const res = await fetch(this.webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (json.code !== 0 && json.statusCode !== 0) {
        logger.warn(`飞书通知返回异常：${JSON.stringify(json)}`);
      } else {
        logger.info('飞书通知已发送');
      }
    } catch (e: any) {
      logger.warn(`飞书通知发送失败：${e.message}`);
    }
  }

  /** 构建飞书卡片消息 */
  private buildCard(summary: ExecutionSummary, failed: boolean, reportUrls?: string[]): any {
    const statusText = failed ? '❌ 有失败' : summary.pending > 0 ? '⚠ 待人工' : '✅ 全通过';
    
    // 报告链接：优先使用 OSS 上传后的可分享 URL，降级到本地路径
    let reportLinks: string;
    if (reportUrls && reportUrls.length > 0) {
      reportLinks = reportUrls
        .filter((u) => u.endsWith('.html'))
        .map((u) => `📄 [查看报告](${u})`)
        .join('\n');
    } else {
      reportLinks = summary.reports
        .filter((r) => r.endsWith('.html'))
        .map((r) => `报告：${r}`)
        .join('\n');
    }

    const elements: any[] = [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**状态**：${statusText}\n**通过**：${summary.passed} | **失败**：${summary.failed} | **待人工**：${summary.pending}${summary.timedOut ? ` | **超时**：${summary.timedOut}` : ''}\n**退出码**：${summary.exitCode}${reportLinks ? '\n' + reportLinks : ''}`,
        },
      },
    ];

    // 失败时 @ 责任人
    if (failed && this.mentionMobiles.length > 0) {
      elements.push({
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `<at user_id="">${this.mentionMobiles.map((m) => `<at email="${m}"></at>`).join('')}</at>`,
        },
      });
    }

    // 失败断言详情
    if (failed && summary.failedChecks && summary.failedChecks.length > 0) {
      const assertDetails = summary.failedChecks
        .filter((c) => c.assertionType || c.path)
        .slice(0, 10) // 最多展示 10 条，避免消息过长
        .map((c) => {
          const path = c.path || '-';
          const op = c.operator || '-';
          const expected = c.expected !== undefined ? JSON.stringify(c.expected) : '-';
          const actual = c.actual !== undefined ? JSON.stringify(c.actual) : '-';
          return `• ${c.name}\n  path: ${path} | operator: ${op} | expected: ${expected} | actual: ${actual}`;
        })
        .join('\n');
      if (assertDetails) {
        elements.push({
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: `**失败断言明细**：\n${assertDetails}`,
          },
        });
      }
    }

    return {
      msg_type: 'interactive',
      card: {
        header: {
          title: {
            tag: 'plain_text',
            content: `测试执行结果：${statusText}`,
          },
          template: failed ? 'red' : summary.pending > 0 ? 'yellow' : 'green',
        },
        elements,
      },
    };
  }
}
