import type { ExecutionError } from '@pulseflow/contracts';

export interface NodeErrorOptions {
  retryable?: boolean;
  retryAfterMs?: number;
  details?: unknown;
  cause?: unknown;
}

/** Error thrown by node executors. `retryable` drives the retry policy. */
export class NodeError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly details?: unknown;

  constructor(code: string, message: string, options: NodeErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'NodeError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs;
    this.details = options.details;
  }
}

/** Thrown by durable nodes (Wait) to suspend the execution until `resumeAt`. */
export class WaitRequest extends Error {
  constructor(readonly resumeAt: Date) {
    super(`Waiting until ${resumeAt.toISOString()}`);
    this.name = 'WaitRequest';
  }
}

export class GraphValidationError extends Error {
  readonly code = 'WORKFLOW_INVALID';
  constructor(
    message: string,
    readonly issues: { code: string; message: string; nodeId?: string }[],
  ) {
    super(message);
    this.name = 'GraphValidationError';
  }
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

const RETRYABLE_SYSTEM_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE', 'ENOTFOUND', 'EBUSY', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET']);

export function classifyError(err: unknown): { retryable: boolean; retryAfterMs?: number } {
  if (err instanceof NodeError) return { retryable: err.retryable, retryAfterMs: err.retryAfterMs };
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && RETRYABLE_SYSTEM_CODES.has(code)) return { retryable: true };
  const causeCode = ((err as { cause?: { code?: unknown } } | null)?.cause)?.code;
  if (typeof causeCode === 'string' && RETRYABLE_SYSTEM_CODES.has(causeCode)) return { retryable: true };
  return { retryable: false };
}

export function toExecutionError(err: unknown, nodeId?: string): ExecutionError {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return {
      code: typeof code === 'string' ? code : err.name === 'AbortError' ? 'CANCELLED' : 'NODE_FAILED',
      message: err.message,
      ...(nodeId ? { nodeId } : {}),
      ...(err.stack ? { stack: err.stack.split('\n').slice(0, 8).join('\n') } : {}),
    };
  }
  return { code: 'NODE_FAILED', message: String(err), ...(nodeId ? { nodeId } : {}) };
}
