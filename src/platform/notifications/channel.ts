// Notification Channel（Phase 24.6）：统一通道接口 + 具体通道实现
// 至少支持：Feishu / DingTalk / Email / Webhook。
// 为可测试性与确定性，所有通道支持注入发送函数（sender / send），默认走 HTTP fetch。

/** 通知消息 */
export interface NotificationMessage {
  title: string;
  body: string;
  severity: 'info' | 'warning' | 'error' | 'critical';
  eventType: string;
  runId?: string;
  metadata?: Record<string, unknown>;
}

/** 通知通道 */
export interface NotificationChannel {
  name: string;
  send(message: NotificationMessage): Promise<void>;
}

/** 可注入的 HTTP 发送器（默认用全局 fetch） */
export type HttpSender = (payload: unknown, url: string) => Promise<unknown>;

const defaultHttpSender: HttpSender = async (payload, url) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

/** 控制台通道（默认 / 日志 / 测试） */
export function consoleChannel(name = 'console'): NotificationChannel {
  return {
    name,
    async send(message) {
      // eslint-disable-next-line no-console
      console.log(`[${message.severity.toUpperCase()}] ${message.title} — ${message.body}`);
    },
  };
}

/** 通用 Webhook 通道（POST JSON） */
export function webhookChannel(opts: {
  name: string;
  url?: string;
  sender?: HttpSender;
}): NotificationChannel {
  const sender = opts.sender ?? defaultHttpSender;
  return {
    name: opts.name,
    async send(message) {
      if (!opts.url) throw new Error(`Webhook 通道 ${opts.name} 缺少 url`);
      await sender({ msgType: message.severity, title: message.title, text: message.body, metadata: message.metadata }, opts.url);
    },
  };
}

/** 飞书通道（text card 风格 payload） */
export function feishuChannel(opts: { name: string; url?: string; sender?: HttpSender }): NotificationChannel {
  const sender = opts.sender ?? defaultHttpSender;
  return {
    name: opts.name,
    async send(message) {
      if (!opts.url) throw new Error(`飞书通道 ${opts.name} 缺少 url`);
      await sender(
        {
          msg_type: 'text',
          content: { text: `[${message.severity}] ${message.title}\n${message.body}` },
        },
        opts.url,
      );
    },
  };
}

/** 钉钉通道（markdown 风格 payload） */
export function dingTalkChannel(opts: { name: string; url?: string; sender?: HttpSender }): NotificationChannel {
  const sender = opts.sender ?? defaultHttpSender;
  return {
    name: opts.name,
    async send(message) {
      if (!opts.url) throw new Error(`钉钉通道 ${opts.name} 缺少 url`);
      await sender(
        {
          msgtype: 'markdown',
          markdown: { title: message.title, text: `### ${message.title}\n${message.body}` },
        },
        opts.url,
      );
    },
  };
}

/** 邮件通道（可注入 send 以接入 SMTP / 邮件网关） */
export function emailChannel(opts: { name: string; to?: string[]; send?: (msg: NotificationMessage) => Promise<unknown> }): NotificationChannel {
  const sendFn = opts.send ?? (async () => undefined);
  return {
    name: opts.name,
    async send(message) {
      await sendFn({ ...message, metadata: { ...(message.metadata ?? {}), to: opts.to ?? [] } });
    },
  };
}
