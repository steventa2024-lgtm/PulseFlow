import { EventEmitter } from 'node:events';
import type { EngineEvent } from '@pulseflow/contracts';

/** In-process fan-out of engine events (SSE streams, desktop notifications, tests). */
export class EventBus {
  readonly #emitter = new EventEmitter();

  constructor() {
    this.#emitter.setMaxListeners(1000);
  }

  emit(event: EngineEvent): void {
    this.#emitter.emit('event', event);
  }

  subscribe(fn: (e: EngineEvent) => void): () => void {
    this.#emitter.on('event', fn);
    return () => this.#emitter.off('event', fn);
  }

  /** Resolves with the first event matching `predicate` (test helper / waiters). */
  waitFor(predicate: (e: EngineEvent) => boolean, timeoutMs = 30_000): Promise<EngineEvent> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error('Timed out waiting for event'));
      }, timeoutMs);
      const off = this.subscribe((e) => {
        if (predicate(e)) {
          clearTimeout(timer);
          off();
          resolve(e);
        }
      });
    });
  }
}
