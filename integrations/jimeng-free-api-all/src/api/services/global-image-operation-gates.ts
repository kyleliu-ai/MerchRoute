import crypto from "node:crypto";

import { AdaptiveImageUploadGate } from "./adaptive-image-upload-gate.ts";

export const GLOBAL_IMAGE_UPLOAD_CONCURRENCY = 2;
export const GLOBAL_IMAGE_GENERATION_CONCURRENCY = 5;
export const GLOBAL_IMAGE_STATUS_CONCURRENCY = 4;

type QueueEntry<T = unknown> = {
  ownerKey: string;
  work: () => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (error: unknown) => void;
};

/**
 * Process-wide fair gate. Work is dequeued round-robin by owner so one batch
 * cannot monopolise every slot merely by enqueueing first.
 */
export class FairKeyedOperationGate {
  private readonly limit: number;
  private active = 0;
  private readonly queues = new Map<string, QueueEntry<any>[]>();
  private readonly rotation: string[] = [];

  constructor(limit: number) {
    this.limit = Math.max(1, Math.trunc(limit));
  }

  run<T>(ownerKey: string, work: () => Promise<T>): Promise<T> {
    const key = String(ownerKey || "").trim() || "<unscoped>";
    return new Promise<T>((resolve, reject) => {
      const queue = this.queues.get(key) || [];
      const wasEmpty = queue.length === 0;
      queue.push({ ownerKey: key, work, resolve, reject });
      this.queues.set(key, queue);
      if (wasEmpty) this.rotation.push(key);
      this.drain();
    });
  }

  snapshot(): { active: number; queued: number; limit: number } {
    return {
      active: this.active,
      queued: [...this.queues.values()].reduce((sum, queue) => sum + queue.length, 0),
      limit: this.limit,
    };
  }

  private drain(): void {
    while (this.active < this.limit && this.rotation.length > 0) {
      const ownerKey = this.rotation.shift()!;
      const queue = this.queues.get(ownerKey);
      const entry = queue?.shift();
      if (!entry) {
        this.queues.delete(ownerKey);
        continue;
      }
      if (queue!.length > 0) this.rotation.push(ownerKey);
      else this.queues.delete(ownerKey);
      this.active += 1;
      void entry.work().then(entry.resolve, entry.reject).finally(() => {
        this.active -= 1;
        this.drain();
      });
    }
  }
}

const uploadGate = new AdaptiveImageUploadGate({
  maxGlobal: GLOBAL_IMAGE_UPLOAD_CONCURRENCY,
  maxPerToken: GLOBAL_IMAGE_UPLOAD_CONCURRENCY,
});
const generationGate = new FairKeyedOperationGate(GLOBAL_IMAGE_GENERATION_CONCURRENCY);
const statusGate = new FairKeyedOperationGate(GLOBAL_IMAGE_STATUS_CONCURRENCY);

function tokenFingerprint(token: string): string {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function retryableUploadFailure(error: unknown): boolean {
  const value = error as Record<string, any>;
  const status = Number(value?.statusCode ?? value?.status ?? value?.response?.status ?? 0);
  if ([408, 429, 500, 502, 503, 504].includes(status)) return true;
  const code = String(value?.code || value?.cause?.code || "").toUpperCase();
  if ([
    "ECONNABORTED", "ECONNRESET", "ECONNREFUSED", "EHOSTUNREACH",
    "ENETUNREACH", "ETIMEDOUT", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_SOCKET",
  ].includes(code)) return true;
  return /\b(timeout|timed out|network|socket hang up)\b/i.test(String(value?.message || ""));
}

/** One actual upload attempt only. Retry backoff must happen outside this gate. */
export async function runGlobalImageUploadAttempt<T>(input: {
  token: string;
  signal?: AbortSignal;
  work: () => Promise<T>;
}): Promise<T> {
  const fingerprint = tokenFingerprint(input.token);
  return uploadGate.run(fingerprint, input.signal, async () => {
    try {
      const result = await input.work();
      uploadGate.noteSuccess(fingerprint);
      return result;
    } catch (error) {
      if (retryableUploadFailure(error)) uploadGate.noteRetryableFailure(fingerprint);
      throw error;
    }
  });
}

export function runGlobalImageGeneration<T>(ownerKey: string, work: () => Promise<T>): Promise<T> {
  return generationGate.run(ownerKey, work);
}

export function runGlobalImageStatus<T>(ownerKey: string, work: () => Promise<T>): Promise<T> {
  return statusGate.run(ownerKey, work);
}

export function globalImageOperationGateSnapshot() {
  return {
    upload: uploadGate.snapshot(),
    generation: generationGate.snapshot(),
    status: statusGate.snapshot(),
  };
}
