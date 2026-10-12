import { assertUrlAllowed, NetworkPolicyError, type NetworkPolicy } from '@pulseflow/security';
import { NodeError } from '../errors';

export interface HttpRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  timeoutMs?: number;
  maxResponseBytes?: number;
  followRedirects?: boolean;
  maxRedirects?: number;
  signal?: AbortSignal;
}

export interface HttpResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: Buffer;
  url: string;
  durationMs: number;
  text(): string;
  json(): unknown;
}

export interface HttpClient {
  request(req: HttpRequest): Promise<HttpResponse>;
}

export function parseRetryAfter(value: string | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, Math.min(secs * 1000, 3_600_000));
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, Math.min(date - now, 3_600_000));
  return undefined;
}

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/**
 * Outbound HTTP with SSRF policy checks on every hop, timeouts, and response size caps.
 * Responses with any status are returned; callers decide whether status is an error.
 */
export function createHttpClient(policy: NetworkPolicy, options: { userAgent?: string } = {}): HttpClient {
  return {
    async request(req) {
      const started = Date.now();
      const timeoutMs = req.timeoutMs ?? 30_000;
      const maxBytes = req.maxResponseBytes ?? 10 * 1024 * 1024;
      const maxRedirects = req.followRedirects === false ? 0 : (req.maxRedirects ?? 5);
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const signal = req.signal ? AbortSignal.any([req.signal, timeoutSignal]) : timeoutSignal;
      let url = req.url;
      let method = req.method.toUpperCase();
      let body = req.body;

      for (let hop = 0; ; hop++) {
        try {
          await assertUrlAllowed(url, policy);
        } catch (e) {
          if (e instanceof NetworkPolicyError) throw new NodeError('NETWORK_DENIED', e.message);
          throw new NodeError('DNS_FAILED', `Could not resolve ${url}: ${(e as Error).message}`, { retryable: true });
        }
        let res: Response;
        try {
          res = await fetch(url, {
            method,
            headers: { 'user-agent': options.userAgent ?? 'PulseFlow/0.1 (+local automation)', ...(req.headers ?? {}) },
            body: method === 'GET' || method === 'HEAD' ? undefined : (body as RequestInit['body']),
            redirect: 'manual',
            signal,
          });
        } catch (e) {
          if (timeoutSignal.aborted) {
            throw new NodeError('HTTP_TIMEOUT', `Request to ${new URL(url).host} timed out after ${timeoutMs} ms`, { retryable: true });
          }
          if (req.signal?.aborted) throw e;
          const cause = (e as { cause?: { code?: string; message?: string } }).cause;
          throw new NodeError('HTTP_NETWORK_ERROR', `Request to ${url} failed: ${cause?.code ?? cause?.message ?? (e as Error).message}`, {
            retryable: true,
          });
        }

        if (res.status >= 300 && res.status < 400 && res.headers.get('location') && maxRedirects > 0) {
          if (hop >= maxRedirects) throw new NodeError('TOO_MANY_REDIRECTS', `More than ${maxRedirects} redirects`);
          url = new URL(res.headers.get('location')!, url).toString();
          if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
            method = 'GET';
            body = undefined;
          }
          await res.body?.cancel();
          continue;
        }

        const chunks: Uint8Array[] = [];
        let total = 0;
        if (res.body && method !== 'HEAD') {
          const reader = res.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > maxBytes) {
              await reader.cancel();
              throw new NodeError('RESPONSE_TOO_LARGE', `Response exceeded ${maxBytes} bytes`);
            }
            chunks.push(value);
          }
        }
        const buf = Buffer.concat(chunks);
        const headers: Record<string, string> = {};
        res.headers.forEach((v, k) => {
          headers[k] = v;
        });
        return {
          status: res.status,
          statusText: res.statusText,
          headers,
          body: buf,
          url,
          durationMs: Date.now() - started,
          text: () => buf.toString('utf8'),
          json: () => JSON.parse(buf.toString('utf8')) as unknown,
        };
      }
    },
  };
}
