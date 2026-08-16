// 飞书通知器：执行结束推送摘要卡片，失败时 @ 责任人
import type { Notifier } from './base.js';
import type { ExecutionSummary } from '../../utils/exit-code.js';
import { logger } from '../../utils/logger.js';

export class FeishuNotifier implements Notifier {
  webhook: string;
  mentionMobiles: string[];

  constructor(webhook: string, mentionMobiles: string[] = []) {
    this.webhook = webhook;
    this.mentionMobiles = mentionMobiles;
  }

  async notify(summary: ExecutionSummary): Promise<void> {
    if (!this.webhook) {
      logger.warn('飞书 webhook 未配置，跳过通知');
      return;
    }

    const failed = summary.failed > 0;
    const payload = this.buildCard(summary, failed);

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
  private buildCard(summary: ExecutionSummary, failed: boolean): any {
    const statusText = failed ? '❌ 有失败' : summary.pending > 0 ? '⚠ 待人工' : '✅ 全通过';
    const reportLinks = summary.reports
      .filter((r) => r.endsWith('.html'))
      .map((r) => `报告：${r}`)
      .join('\n');

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
