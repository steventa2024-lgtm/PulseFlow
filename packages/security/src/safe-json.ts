export class UnsafeInputError extends Error {
  readonly code = 'UNSAFE_INPUT';
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeInputError';
  }
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export interface SafeJsonLimits {
  maxBytes?: number;
  maxDepth?: number;
}

/** JSON.parse that rejects prototype-pollution keys and enforces size/depth limits. */
export function safeJsonParse(text: string, limits: SafeJsonLimits = {}): unknown {
  const maxBytes = limits.maxBytes ?? 20 * 1024 * 1024;
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new UnsafeInputError(`JSON exceeds ${maxBytes} bytes`);
  const parsed: unknown = JSON.parse(text, (key, value: unknown) => {
    if (FORBIDDEN_KEYS.has(key)) throw new UnsafeInputError(`Forbidden key "${key}" in JSON input`);
    return value;
  });
  assertSafeValue(parsed, limits.maxDepth ?? 64);
  return parsed;
}

export function assertSafeValue(value: unknown, maxDepth = 64): void {
  const walk = (v: unknown, depth: number) => {
    if (depth > maxDepth) throw new UnsafeInputError(`Input nesting exceeds depth ${maxDepth}`);
    if (v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    for (const k of Object.keys(v)) {
      if (FORBIDDEN_KEYS.has(k)) throw new UnsafeInputError(`Forbidden key "${k}" in input`);
      walk((v as Record<string, unknown>)[k], depth + 1);
    }
  };
  walk(value, 0);
}
