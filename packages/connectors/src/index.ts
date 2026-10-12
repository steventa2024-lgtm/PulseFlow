import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { lookup } from "node:dns/promises";
import { FlowError } from "@pulseflow/contracts";
import { assertUrlAllowed, redactValue, type SsrfPolicy } from "@pulseflow/security";
import { XMLParser } from "fast-xml-parser";
import nodemailer from "nodemailer";

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  truncated: boolean;
}

export async function safeFetch(options: {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  policy: SsrfPolicy;
  signal?: AbortSignal;
}): Promise<HttpResponse> {
  const method = (options.method ?? "GET").toUpperCase();
  const maxRedirects = options.maxRedirects ?? 5;
  let current = options.url;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const url = await assertUrlAllowed(current, options.policy);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
    const onAbort = () => controller.abort();
    options.signal?.addEventListener("abort", onAbort);
    try {
      const response = await fetch(url, {
        method,
        headers: options.headers,
        body: method === "GET" || method === "HEAD" ? undefined : options.body,
        redirect: "manual",
        signal: controller.signal,
      });
      const location = response.headers.get("location");
      if (location && response.status >= 300 && response.status < 400) {
        if (hop === maxRedirects) throw new FlowError("Too many redirects", "HTTP");
        current = new URL(location, url).toString();
        continue;
      }
      return await readBody(response, options.maxBytes ?? 1_000_000);
    } catch (error) {
      if (error instanceof FlowError) throw error;
      if (options.signal?.aborted) throw new FlowError("HTTP request cancelled", "CANCELLED");
      const message = error instanceof Error ? error.message : "HTTP request failed";
      const retryable = /abort|timeout|ECONNRESET|EAI_AGAIN|fetch failed/i.test(message);
      throw new FlowError(message, retryable ? "HTTP_RETRY" : "HTTP", retryable);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }
  throw new FlowError("HTTP request failed", "HTTP");
}

async function readBody(response: Response, maxBytes: number): Promise<HttpResponse> {
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (size + value.byteLength > maxBytes) {
        chunks.push(value.slice(0, maxBytes - size));
        truncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(value);
      size += value.byteLength;
    }
  }
  const body = new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return {
    status: response.status,
    headers: redactValue(headers) as Record<string, string>,
    body,
    truncated,
  };
}

export function retryAfterMs(headers: Record<string, string>): number | undefined {
  const raw = headers["retry-after"] ?? headers["Retry-After"];
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 60_000);
  const date = Date.parse(raw);
  if (!Number.isNaN(date)) return Math.max(0, Math.min(date - Date.now(), 60_000));
  return undefined;
}

export interface RssItem {
  title: string;
  link: string;
  guid: string;
  summary: string;
  published: string;
}

export function parseFeed(xml: string): RssItem[] {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
  const doc = parser.parse(xml) as {
    rss?: { channel?: { item?: unknown } };
    feed?: { entry?: unknown };
  };
  const rssItems = asArray(doc.rss?.channel?.item);
  if (rssItems.length > 0) {
    return rssItems.map((item) => {
      const record = asRecord(item);
      return {
        title: text(record.title),
        link: text(record.link),
        guid: text(record.guid) || text(record.link),
        summary: text(record.description),
        published: text(record.pubDate),
      };
    });
  }
  const entries = asArray(doc.feed?.entry);
  return entries.map((item) => {
    const record = asRecord(item);
    const link = typeof record.link === "object" ? text(asRecord(record.link)["@_href"]) : text(record.link);
    return {
      title: text(record.title),
      link,
      guid: text(record.id) || link,
      summary: text(record.summary) || text(record.content),
      published: text(record.updated) || text(record.published),
    };
  });
}

function asArray(value: unknown): unknown[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (value && typeof value === "object" && "#text" in value) return String((value as { "#text": unknown })["#text"] ?? "");
  return "";
}

export async function sendSmtp(options: {
  host: string;
  port: number;
  secure?: boolean;
  username?: string;
  password?: string;
  from: string;
  to: string;
  subject: string;
  text: string;
}): Promise<{ messageId: string }> {
  const transport = nodemailer.createTransport({
    host: options.host,
    port: options.port,
    secure: options.secure ?? false,
    auth: options.username ? { user: options.username, pass: options.password ?? "" } : undefined,
    tls: { rejectUnauthorized: options.host !== "127.0.0.1" },
    connectionTimeout: 10_000,
  });
  const info = await transport.sendMail({
    from: options.from,
    to: options.to,
    subject: options.subject,
    text: options.text,
  });
  return { messageId: info.messageId };
}

export interface DemoServices {
  baseUrl: string;
  smtp: { host: string; port: number; messages: string[] };
  close: () => Promise<void>;
  state: () => DemoState;
}

export interface DemoState {
  discord: unknown[];
  telegram: unknown[];
  sheets: string[][];
  githubIssues: Array<Record<string, unknown>>;
  releases: Array<Record<string, unknown>>;
  monitorStatus: number;
  flakyHits: number;
}

export async function startDemoServices(): Promise<DemoServices> {
  const state: DemoState = {
    discord: [],
    telegram: [],
    sheets: [
      ["name", "city"],
      ["Ada", "London"],
      ["Grace", "New York"],
    ],
    githubIssues: [
      { id: 101, number: 7, title: "Document local runs", state: "open", updated_at: "2026-10-01T00:00:00Z" },
      { id: 102, number: 8, title: "Add folder backup", state: "open", updated_at: "2026-10-02T00:00:00Z" },
    ],
    releases: [{ id: 1, tag_name: "v1.2.0", name: "Pulse demo", published_at: "2026-10-03T00:00:00Z" }],
    monitorStatus: 200,
    flakyHits: 0,
  };
  const http = createServer(async (req, res) => {
    try {
      await routeDemo(req, res, state);
    } catch {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "fixture failure" }));
    }
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address() as AddressInfo;
  const smtp = await startSmtpSink();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    smtp: { host: "127.0.0.1", port: smtp.port, messages: smtp.messages },
    state: () => state,
    close: async () => {
      await new Promise<void>((resolve, reject) => http.close((error) => (error ? reject(error) : resolve())));
      await smtp.close();
    },
  };
}

async function routeDemo(req: IncomingMessage, res: ServerResponse, state: DemoState): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const method = req.method ?? "GET";
  const body = await readRequest(req);
  const json = () => {
    res.writeHead(200, { "content-type": "application/json" });
  };
  if (url.pathname === "/monitor") {
    json();
    res.end(JSON.stringify({ status: state.monitorStatus }));
    return;
  }
  if (url.pathname === "/_control/monitor" && method === "POST") {
    state.monitorStatus = Number(JSON.parse(body || "{}").status ?? 200);
    json();
    res.end(JSON.stringify({ status: state.monitorStatus }));
    return;
  }
  if (url.pathname === "/health/ok") {
    json();
    res.end(JSON.stringify({ name: "ok", ok: true }));
    return;
  }
  if (url.pathname === "/health/bad") {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ name: "bad", ok: false }));
    return;
  }
  if (url.pathname === "/flaky") {
    state.flakyHits += 1;
    if (state.flakyHits < 3) {
      res.writeHead(500, { "retry-after": "0" });
      res.end("temporary");
      return;
    }
    json();
    res.end(JSON.stringify({ ok: true, hits: state.flakyHits }));
    return;
  }
  if (url.pathname === "/rss") {
    res.writeHead(200, { "content-type": "application/rss+xml" });
    res.end(`<?xml version="1.0"?><rss version="2.0"><channel><title>Pulse</title>
      <item><title>Local notes</title><link>http://fixture/notes</link><guid>notes-1</guid><description>Read locally</description><pubDate>Mon, 12 Oct 2026 00:00:00 GMT</pubDate></item>
      <item><title>Second</title><link>http://fixture/second</link><guid>notes-2</guid><description>More</description><pubDate>Tue, 13 Oct 2026 00:00:00 GMT</pubDate></item>
      </channel></rss>`);
    return;
  }
  if (url.pathname === "/github/repos/acme/demo/issues") {
    const page = Number(url.searchParams.get("page") ?? "1");
    json();
    res.end(JSON.stringify(page === 1 ? state.githubIssues : []));
    return;
  }
  if (url.pathname === "/github/repos/acme/demo/releases") {
    json();
    res.end(JSON.stringify(state.releases));
    return;
  }
  if (url.pathname === "/discord" && method === "POST") {
    state.discord.push(JSON.parse(body || "{}"));
    res.writeHead(204);
    res.end();
    return;
  }
  if (url.pathname === "/telegram/botdemo/sendMessage" && method === "POST") {
    const payload = JSON.parse(body || "{}");
    state.telegram.push(payload);
    json();
    res.end(JSON.stringify({ ok: true, result: { message_id: state.telegram.length } }));
    return;
  }
  if (url.pathname === "/api/generate" && method === "POST") {
    json();
    res.end(JSON.stringify({ response: "PulseFlow keeps the summary on this computer.", model: "fixture" }));
    return;
  }
  if (url.pathname === "/page") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><head><title>Demo Page</title></head><body><a href=\"/notes\">Notes</a><a href=\"/about\">About</a></body></html>");
    return;
  }
  if (url.pathname === "/sheets" && method === "GET") {
    json();
    res.end(JSON.stringify({ values: state.sheets }));
    return;
  }
  if (url.pathname === "/sheets" && method === "PUT") {
    const payload = JSON.parse(body || "{}") as { values?: string[][] };
    if (payload.values) state.sheets = payload.values;
    json();
    res.end(JSON.stringify({ updated: state.sheets.length }));
    return;
  }
  if (url.pathname === "/redirect-metadata") {
    res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data" });
    res.end();
    return;
  }
  if (url.pathname === "/_control/state") {
    json();
    res.end(JSON.stringify(state));
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found", path: url.pathname }));
}

function readRequest(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function startSmtpSink(): Promise<{ port: number; messages: string[]; close: () => Promise<void> }> {
  const messages: string[] = [];
  const server = createNetServer((socket) => {
    socket.write("220 pulseflow fixture\r\n");
    let buffer = "";
    let dataMode = false;
    let body = "";
    socket.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      if (dataMode) {
        body += text;
        if (body.includes("\r\n.\r\n")) {
          messages.push(body);
          dataMode = false;
          body = "";
          socket.write("250 ok\r\n");
        }
        return;
      }
      buffer += text;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const upper = line.toUpperCase();
        if (upper.startsWith("EHLO") || upper.startsWith("HELO")) socket.write("250-hello\r\n250 OK\r\n");
        else if (upper === "DATA") {
          dataMode = true;
          socket.write("354 go\r\n");
        } else if (upper === "QUIT") {
          socket.write("221 bye\r\n");
          socket.end();
        } else socket.write("250 ok\r\n");
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        port,
        messages,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

export async function assertPublicLookup(host: string, policy: SsrfPolicy): Promise<void> {
  const records = await lookup(host, { all: true });
  if (records.length === 0) throw new FlowError(`Could not resolve ${host}`, "SSRF");
  void policy;
}

export function buildAuthorizeUrl(options: {
  authorizeUrl: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
}): string {
  const url = new URL(options.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("scope", options.scope);
  url.searchParams.set("state", options.state);
  return url.toString();
}

export async function exchangeOAuthCode(options: {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  policy: SsrfPolicy;
}): Promise<Record<string, unknown>> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: options.code,
    redirect_uri: options.redirectUri,
    client_id: options.clientId,
    client_secret: options.clientSecret,
  });
  const response = await safeFetch({
    url: options.tokenUrl,
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: body.toString(),
    policy: options.policy,
  });
  if (response.status >= 400) throw new FlowError(`Token endpoint returned ${response.status}`, "OAUTH");
  return JSON.parse(response.body) as Record<string, unknown>;
}

export function extractHtml(html: string): { title: string; links: string[] } {
  const title = /<title>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? "";
  const links: string[] = [];
  const pattern = /<a\s+[^>]*href=["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html))) {
    if (match[1]) links.push(match[1]);
  }
  return { title, links };
}
