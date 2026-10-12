export const REDACTED = '[REDACTED]';

const SENSITIVE_KEY =
  /^(authorization|proxy-authorization|cookie|set-cookie|password|passwd|pass|secret|client_secret|clientsecret|token|access_token|accesstoken|refresh_token|refreshtoken|id_token|api[-_]?key|apikey|x-api-key|private[-_]?key|smtp_pass|bot_token|webhook_secret|signature)$/i;

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key) || /(secret|password|token|api[-_]?key)$/i.test(key);
}

export interface RedactOptions {
  /** Exact secret values to scrub wherever they appear (including inside strings). */
  secrets?: Iterable<string>;
  maxDepth?: number;
}

function scrubString(value: string, secrets: string[]): string {
  let out = value;
  for (const s of secrets) {
    if (s.length >= 4 && out.includes(s)) out = out.split(s).join(REDACTED);
  }
  // Bearer / Basic credentials embedded in free text.
  out = out.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, `$1 ${REDACTED}`);
  // Credentials embedded in URLs: scheme://user:pass@host
  out = out.replace(/([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/gi, `$1$2:${REDACTED}@`);
  return out;
}

/** Deep-copies a value replacing sensitive keys and known secret values. Never mutates input. */
export function redact<T>(value: T, options: RedactOptions = {}): T {
  const secrets = [...(options.secrets ?? [])].filter((s) => typeof s === 'string' && s.length >= 4);
  secrets.sort((a, b) => b.length - a.length);
  const maxDepth = options.maxDepth ?? 32;
  const seen = new WeakSet<object>();

  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === 'string') return scrubString(v, secrets);
    if (v === null || typeof v !== 'object') return v;
    if (depth > maxDepth) return '[MaxDepth]';
    if (seen.has(v)) return '[Circular]';
    seen.add(v);
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    if (v instanceof Date) return v.toISOString();
    const out: Record<string, unknown> = {};
    for (const [k, inner] of Object.entries(v as Record<string, unknown>)) {
      out[k] = isSensitiveKey(k) && inner !== null && inner !== undefined && inner !== '' ? REDACTED : walk(inner, depth + 1);
    }
    return out;
  };
  return walk(value, 0) as T;
}

export function redactText(text: string, secrets: Iterable<string> = []): string {
  return redact(text, { secrets });
}
