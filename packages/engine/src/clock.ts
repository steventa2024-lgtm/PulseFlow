export interface Clock {
  now(): Date;
  /** Resolves after `ms`; rejects with an AbortError if the signal fires first. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export function abortError(signal?: AbortSignal): Error {
  const reason: unknown = signal?.reason;
  if (reason instanceof Error) return reason;
  const err = new Error(typeof reason === 'string' ? reason : 'Operation cancelled');
  err.name = 'AbortError';
  return err;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(abortError(signal));
      const onAbort = () => {
        clearTimeout(t);
        reject(abortError(signal));
      };
      const t = setTimeout(
        () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        },
        Math.max(0, ms),
      );
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  setTimeout(fn: () => void, ms: number): unknown {
    return setTimeout(fn, Math.max(0, ms));
  }

  clearTimeout(handle: unknown): void {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  }
}

interface FakeTimer {
  id: number;
  at: number;
  fn: () => void;
}

/** Deterministic clock for tests: time only moves when `advance` / `advanceTo` is called. */
export class FakeClock implements Clock {
  #now: number;
  #timers: FakeTimer[] = [];
  #nextId = 1;

  constructor(start: Date | string | number = '2026-01-01T00:00:00.000Z') {
    this.#now = new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.#now);
  }

  get pendingTimers(): number {
    return this.#timers.length;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const timer = { id: this.#nextId++, at: this.#now + Math.max(0, ms), fn };
    this.#timers.push(timer);
    return timer.id;
  }

  clearTimeout(handle: unknown): void {
    this.#timers = this.#timers.filter((t) => t.id !== handle);
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(abortError(signal));
      const id = this.setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        this.clearTimeout(id);
        reject(abortError(signal));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Advance time, firing due timers in order and letting promise continuations run between them. */
  async advance(ms: number): Promise<void> {
    await this.advanceTo(this.#now + ms);
  }

  async advanceTo(target: number | Date): Promise<void> {
    const end = new Date(target).getTime();
    for (;;) {
      await flushMicrotasks();
      this.#timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.#timers[0];
      if (!next || next.at > end) break;
      this.#timers.shift();
      this.#now = Math.max(this.#now, next.at);
      next.fn();
    }
    this.#now = Math.max(this.#now, end);
    await flushMicrotasks();
  }

  /** Advance until no timers remain (bounded to avoid infinite loops). */
  async runAll(maxSteps = 10_000): Promise<void> {
    for (let i = 0; i < maxSteps; i++) {
      await flushMicrotasks();
      if (this.#timers.length === 0) return;
      this.#timers.sort((a, b) => a.at - b.at || a.id - b.id);
      await this.advanceTo(this.#timers[0]!.at);
    }
    throw new Error('FakeClock.runAll exceeded max steps');
  }
}

export async function flushMicrotasks(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setImmediate(r));
}
