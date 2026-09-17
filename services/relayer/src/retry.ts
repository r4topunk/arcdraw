export type RetryOptions = {
  /** Total attempts including the first (default 5). */
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Return false to stop retrying (e.g. deterministic failures such as an invalid beacon). */
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
  signal?: AbortSignal;
  /** Injectable for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
};

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Exponential backoff with full jitter: delay = random(0.5..1) * min(max, base * 2^(attempt-1)). */
export function backoffDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  random = Math.random,
): number {
  const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(exp * (0.5 + random() / 2));
}

export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 5;
  const base = opts.baseDelayMs ?? 500;
  const max = opts.maxDelayMs ?? 30_000;
  const doSleep = opts.sleep ?? sleep;
  for (let attempt = 1; ; attempt++) {
    opts.signal?.throwIfAborted();
    try {
      return await fn(attempt);
    } catch (err) {
      if (
        attempt >= attempts ||
        opts.signal?.aborted ||
        (opts.shouldRetry && !opts.shouldRetry(err, attempt))
      ) {
        throw err;
      }
      const delay = backoffDelay(attempt, base, max, opts.random);
      opts.onRetry?.(err, attempt, delay);
      await doSleep(delay, opts.signal);
    }
  }
}
