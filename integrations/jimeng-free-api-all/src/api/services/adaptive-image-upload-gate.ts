export const DEFAULT_GLOBAL_IMAGE_UPLOAD_CONCURRENCY = 2;
export const DEFAULT_TOKEN_IMAGE_UPLOAD_CONCURRENCY = 2;
export const DEGRADED_TOKEN_IMAGE_UPLOAD_CONCURRENCY = 1;
export const IMAGE_UPLOAD_DEGRADED_DURATION_MS = 120_000;
export const IMAGE_UPLOAD_RECOVERY_SUCCESS_COUNT = 3;

type TokenState = {
  active: number;
  degradedUntilMs: number;
  consecutiveSuccesses: number;
};

type QueueEntry<T> = {
  tokenFingerprint: string;
  signal?: AbortSignal;
  work: () => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
  abortListener?: () => void;
};

export class AdaptiveImageUploadGate {
  private readonly maxGlobal: number;
  private readonly maxPerToken: number;
  private readonly degradedDurationMs: number;
  private readonly recoverySuccessCount: number;
  private readonly now: () => number;
  private activeGlobal = 0;
  private readonly tokens = new Map<string, TokenState>();
  private readonly queue: QueueEntry<any>[] = [];

  constructor(options: {
    maxGlobal?: number;
    maxPerToken?: number;
    degradedDurationMs?: number;
    recoverySuccessCount?: number;
    now?: () => number;
  } = {}) {
    this.maxGlobal = Math.max(1, Math.floor(
      options.maxGlobal ?? DEFAULT_GLOBAL_IMAGE_UPLOAD_CONCURRENCY
    ));
    this.maxPerToken = Math.max(1, Math.min(this.maxGlobal, Math.floor(
      options.maxPerToken ?? DEFAULT_TOKEN_IMAGE_UPLOAD_CONCURRENCY
    )));
    this.degradedDurationMs = Math.max(1, Math.floor(
      options.degradedDurationMs ?? IMAGE_UPLOAD_DEGRADED_DURATION_MS
    ));
    this.recoverySuccessCount = Math.max(1, Math.floor(
      options.recoverySuccessCount ?? IMAGE_UPLOAD_RECOVERY_SUCCESS_COUNT
    ));
    this.now = options.now || Date.now;
  }

  private tokenState(tokenFingerprint: string): TokenState {
    const key = String(tokenFingerprint || "").trim();
    if (!key) throw new TypeError("tokenFingerprint is required");
    let state = this.tokens.get(key);
    if (!state) {
      state = { active: 0, degradedUntilMs: 0, consecutiveSuccesses: 0 };
      this.tokens.set(key, state);
    }
    return state;
  }

  private tokenLimit(tokenFingerprint: string): number {
    const state = this.tokenState(tokenFingerprint);
    if (state.degradedUntilMs > 0 && this.now() >= state.degradedUntilMs) {
      state.degradedUntilMs = 0;
      state.consecutiveSuccesses = 0;
    }
    return state.degradedUntilMs > 0
      ? DEGRADED_TOKEN_IMAGE_UPLOAD_CONCURRENCY
      : this.maxPerToken;
  }

  run<T>(
    tokenFingerprint: string,
    signal: AbortSignal | undefined,
    work: () => Promise<T>
  ): Promise<T> {
    if (signal?.aborted) return Promise.reject(signal.reason || new Error("upload gate aborted"));
    this.tokenState(tokenFingerprint);
    return new Promise<T>((resolve, reject) => {
      const entry: QueueEntry<T> = {
        tokenFingerprint,
        signal,
        work,
        resolve,
        reject,
      };
      if (signal) {
        entry.abortListener = () => {
          const index = this.queue.indexOf(entry);
          if (index >= 0) {
            this.queue.splice(index, 1);
            reject(signal.reason || new Error("upload gate aborted"));
            this.drain();
          }
        };
        signal.addEventListener("abort", entry.abortListener, { once: true });
      }
      this.queue.push(entry);
      this.drain();
    });
  }

  noteRetryableFailure(tokenFingerprint: string): void {
    const state = this.tokenState(tokenFingerprint);
    state.degradedUntilMs = this.now() + this.degradedDurationMs;
    state.consecutiveSuccesses = 0;
    this.drain();
  }

  noteSuccess(tokenFingerprint: string): void {
    const state = this.tokenState(tokenFingerprint);
    if (state.degradedUntilMs <= 0) return;
    state.consecutiveSuccesses += 1;
    if (state.consecutiveSuccesses >= this.recoverySuccessCount) {
      state.degradedUntilMs = 0;
      state.consecutiveSuccesses = 0;
      this.drain();
    }
  }

  snapshot(tokenFingerprint?: string): {
    activeGlobal: number;
    queued: number;
    token?: {
      active: number;
      limit: number;
      degradedUntilMs: number;
      consecutiveSuccesses: number;
    };
  } {
    const key = String(tokenFingerprint || "").trim();
    if (!key) return { activeGlobal: this.activeGlobal, queued: this.queue.length };
    const state = this.tokenState(key);
    return {
      activeGlobal: this.activeGlobal,
      queued: this.queue.length,
      token: {
        active: state.active,
        limit: this.tokenLimit(key),
        degradedUntilMs: state.degradedUntilMs,
        consecutiveSuccesses: state.consecutiveSuccesses,
      },
    };
  }

  private drain(): void {
    while (this.activeGlobal < this.maxGlobal) {
      const index = this.queue.findIndex((entry) => {
        if (entry.signal?.aborted) return true;
        const state = this.tokenState(entry.tokenFingerprint);
        return state.active < this.tokenLimit(entry.tokenFingerprint);
      });
      if (index < 0) return;
      const [entry] = this.queue.splice(index, 1);
      if (entry.signal?.aborted) {
        entry.signal?.removeEventListener("abort", entry.abortListener!);
        entry.reject(entry.signal.reason || new Error("upload gate aborted"));
        continue;
      }
      entry.signal?.removeEventListener("abort", entry.abortListener!);
      const state = this.tokenState(entry.tokenFingerprint);
      state.active += 1;
      this.activeGlobal += 1;
      void entry.work().then(entry.resolve, entry.reject).finally(() => {
        state.active -= 1;
        this.activeGlobal -= 1;
        this.drain();
      });
    }
  }
}
