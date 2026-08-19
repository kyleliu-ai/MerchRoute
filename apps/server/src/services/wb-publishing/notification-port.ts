export type TaskNotificationSeverity = 'INFO' | 'SUCCESS' | 'WARNING' | 'ERROR';

export type TaskNotificationUpsert = {
  dedupeKey: string;
  category: string;
  eventType: string;
  severity: TaskNotificationSeverity;
  title: string;
  message: string;
  sourceType: string;
  sourceId: string;
  sku?: string;
  productName?: string;
  workflowCode?: string;
  details?: Record<string, unknown>;
};

export type TaskNotificationResolve = {
  dedupeKey?: string;
  sourceType?: string;
  sourceId?: string;
  eventType?: string;
  details?: Record<string, unknown>;
};

/**
 * Narrow notification port used by WB services. The PostgreSQL repository is
 * the current adapter, while tests can inject a small in-memory spy.
 */
export interface WbTaskNotificationPort {
  upsertNotification(input: TaskNotificationUpsert): Promise<unknown>;
  resolveNotifications(input: TaskNotificationResolve): Promise<unknown>;
}
