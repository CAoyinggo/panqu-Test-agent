// Notification（Phase 24.6）

export {
  consoleChannel,
  webhookChannel,
  feishuChannel,
  dingTalkChannel,
  emailChannel,
} from './channel.js';
export type { NotificationChannel, NotificationMessage, HttpSender } from './channel.js';

export {
  NotificationDispatcher,
  buildNotificationMessage,
  EVENT_NOTIFICATION_TEMPLATES,
} from './dispatcher.js';
export type { NotificationSummary } from './dispatcher.js';
