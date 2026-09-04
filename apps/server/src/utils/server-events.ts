import type { ServerResponse } from 'node:http';
import type { MediaIndexState, StageSummary } from '@n8n-media-review/shared';

export type MediaIndexEvent = {
  type: 'connected' | 'index-changed' | 'review-state-changed';
  stageId?: string;
  state?: MediaIndexState;
  summary?: StageSummary;
  affectedTaskIds?: string[];
  reason?: string;
  at: string;
};

export class MediaIndexEventHub {
  private readonly clients = new Set<ServerResponse>();
  private readonly pending = new Map<string, MediaIndexEvent>();
  private sequence = 0;
  private readonly keepAlive: NodeJS.Timeout;
  private flushTimer?: NodeJS.Timeout;

  constructor(private readonly coalesceMs = 50) {
    this.keepAlive = setInterval(() => {
      for (const client of this.clients) this.write(client, ': keep-alive\n\n');
    }, 15_000);
    this.keepAlive.unref();
  }

  add(client: ServerResponse): () => void {
    client.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    client.flushHeaders();
    this.clients.add(client);
    this.send(client, { type: 'connected', at: new Date().toISOString() });
    return () => this.clients.delete(client);
  }

  publish(event: Omit<MediaIndexEvent, 'at'> & { at?: string }): void {
    const payload: MediaIndexEvent = { ...event, at: event.at || new Date().toISOString() };
    if (!payload.stageId) {
      for (const client of this.clients) this.send(client, payload);
      return;
    }
    this.pending.set(payload.stageId, payload);
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flush(), Math.max(0, this.coalesceMs));
    this.flushTimer.unref?.();
  }

  close(): void {
    clearInterval(this.keepAlive);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.pending.clear();
    for (const client of this.clients) {
      try { client.end(); } catch { this.disconnect(client); }
    }
    this.clients.clear();
  }

  private flush(): void {
    this.flushTimer = undefined;
    const events = [...this.pending.values()];
    this.pending.clear();
    for (const event of events) for (const client of this.clients) this.send(client, event);
  }

  private send(client: ServerResponse, event: MediaIndexEvent): void {
    this.sequence += 1;
    this.write(client, `id: ${this.sequence}\nevent: media-index\ndata: ${JSON.stringify(event)}\n\n`);
  }

  private write(client: ServerResponse, chunk: string): void {
    if (client.destroyed || client.writableEnded) {
      this.clients.delete(client);
      return;
    }
    try {
      if (!client.write(chunk)) {
        this.disconnect(client);
      }
    } catch {
      this.disconnect(client);
    }
  }

  private disconnect(client: ServerResponse): void {
    this.clients.delete(client);
    try { client.destroy(); } catch { /* already closed */ }
  }
}
