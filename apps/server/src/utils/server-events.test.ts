import type { ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MediaIndexEventHub } from './server-events.js';

describe('MediaIndexEventHub', () => {
  const hubs: MediaIndexEventHub[] = [];

  afterEach(() => {
    for (const hub of hubs) hub.close();
    hubs.length = 0;
    vi.useRealTimers();
  });

  it('coalesces an event storm to the latest state for each stage', async () => {
    vi.useFakeTimers();
    const hub = new MediaIndexEventHub(25);
    hubs.push(hub);
    const client = fakeClient();
    hub.add(client.response);

    for (let revision = 1; revision <= 100; revision += 1) {
      hub.publish({
        type: 'index-changed',
        stageId: 'E006',
        state: state('E006', String(revision)),
        at: `2026-08-07T00:00:${String(revision % 60).padStart(2, '0')}.000Z`
      });
    }
    hub.publish({ type: 'index-changed', stageId: 'E007', state: state('E007', 'other') });

    expect(client.chunks).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(25);
    expect(client.chunks).toHaveLength(3);
    expect(client.chunks.filter((chunk) => chunk.includes('"stageId":"E006"'))).toHaveLength(1);
    expect(client.chunks.join('')).toContain('"revision":"100"');
  });

  it('disconnects a slow client as soon as the response applies backpressure', async () => {
    vi.useFakeTimers();
    const hub = new MediaIndexEventHub(1);
    hubs.push(hub);
    const client = fakeClient(2);
    hub.add(client.response);
    hub.publish({ type: 'index-changed', stageId: 'E006', state: state('E006', '1') });
    await vi.advanceTimersByTimeAsync(1);

    expect(client.destroy).toHaveBeenCalledOnce();
    hub.publish({ type: 'index-changed', stageId: 'E006', state: state('E006', '2') });
    await vi.advanceTimersByTimeAsync(1);
    expect(client.chunks).toHaveLength(2);
  });
});

function state(stageId: string, revision: string) {
  return {
    stageId,
    revision,
    status: 'READY' as const,
    watcherStatus: 'ACTIVE' as const,
    queueCount: 0,
    pendingReconciliations: 0
  };
}

function fakeClient(backpressureAt = Number.POSITIVE_INFINITY): {
  response: ServerResponse;
  chunks: string[];
  destroy: ReturnType<typeof vi.fn>;
} {
  const chunks: string[] = [];
  const destroy = vi.fn();
  const response = {
    destroyed: false,
    writableEnded: false,
    writeHead: vi.fn(),
    flushHeaders: vi.fn(),
    end: vi.fn(),
    destroy,
    write: vi.fn((chunk: string) => {
      chunks.push(chunk);
      return chunks.length < backpressureAt;
    })
  } as unknown as ServerResponse;
  return { response, chunks, destroy };
}
