import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { FlowError } from "@pulseflow/contracts";

const SECRET_KEY = /pass|secret|token|authorization|api[-_]?key|credential|cookie|set-cookie|webhook|private[-_]?key/i;

export function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function timingSafeStringEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 32).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [kind, salt, hash] = stored.split("$");
  if (kind !== "scrypt" || !salt || !hash) return false;
  const actual = scryptSync(password, salt, 32);
  const expected = Buffer.from(hash, "hex");
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

export interface EncryptedBlob {
  ciphertext: string;
  iv: string;
  tag: string;
}

export function encryptJson(value: unknown, key: Buffer): EncryptedBlob {
  if (key.length !== 32) throw new FlowError("Encryption key must be 32 bytes", "CRYPTO");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
  };
}

export function decryptJson(blob: EncryptedBlob, key: Buffer): unknown {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(blob.iv, "base64"));
  decipher.setAuthTag(Buffer.from(blob.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(blob.ciphertext, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8")) as unknown;
}

export function loadOrCreateKey(file: string): Buffer {
  if (existsSync(file)) {
    const raw = readFileSync(file);
    if (raw.length !== 32) throw new FlowError("Secret key file is corrupt", "CRYPTO");
    return raw;
  }
  mkdirSync(path.dirname(file), { recursive: true });
  const key = randomBytes(32);
  writeFileSync(file, key, { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows ACLs differ; the file mode is best-effort outside POSIX.
  }
  return key;
}

export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 20) return "[depth]";
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (SECRET_KEY.test(key)) out[key] = "[redacted]";
      else out[key] = redactValue(entry, depth + 1);
    }
    return out;
  }
  return "[unsupported]";
}

export function redactString(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/((?:api[_-]?key|token|password|secret)=)([^&\s]+)/gi, "$1[redacted]")
    .replace(/hooks\.discord\.com\/api\/webhooks\/\d+\/[\w-]+/gi, "hooks.discord.com/api/webhooks/[redacted]")
    .replace(/bot\d+:[A-Za-z0-9_-]{20,}/g, "bot[redacted]");
}

export function isInsideRoot(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function resolveInside(roots: string[], target: string): string {
  if (typeof target !== "string" || target.length === 0 || target.includes("\0")) {
    throw new FlowError("Path is empty or contains a null byte", "PATH_DENIED");
  }
  const resolved = path.resolve(target);
  if (!roots.some((root) => isInsideRoot(root, resolved))) {
    throw new FlowError(`Path is outside approved folders: ${resolved}`, "PATH_DENIED");
  }
  const real = realize(resolved);
  const ok = roots.some((root) => {
    const realRoot = existsSync(root) ? realpathSync(root) : path.resolve(root);
    return isInsideRoot(realRoot, real);
  });
  if (!ok) throw new FlowError(`Path escapes approved folders: ${resolved}`, "PATH_DENIED");
  return real;
}

function realize(target: string): string {
  if (existsSync(target)) {
    const stat = lstatSync(target);
    if (stat.isSymbolicLink()) return realpathSync(target);
    return realpathSync(target);
  }
  const parent = path.dirname(target);
  if (parent === target) return target;
  if (!existsSync(parent)) {
    const ancestor = nearestExisting(parent);
    const realizedAncestor = existsSync(ancestor.existing) ? realpathSync(ancestor.existing) : ancestor.existing;
    return path.join(realizedAncestor, ...ancestor.rest, path.basename(target));
  }
  return path.join(realpathSync(parent), path.basename(target));
}

function nearestExisting(start: string): { existing: string; rest: string[] } {
  const rest: string[] = [];
  let current = start;
  while (!existsSync(current)) {
    rest.unshift(path.basename(current));
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return { existing: current, rest };
}

export interface SsrfPolicy {
  allowLoopback: boolean;
  allowPrivate: boolean;
}

export function ipAllowed(address: string, policy: SsrfPolicy): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  const mapped = address.startsWith("::ffff:") ? address.slice(7) : address;
  if (isMetadata(mapped) || isMetadata(address)) return false;
  if (isLoopback(mapped) || address === "::1") return policy.allowLoopback;
  if (isPrivate(mapped) || isIpv6Private(address)) return policy.allowPrivate;
  if (isLinkLocal(mapped) || address.toLowerCase().startsWith("fe80:")) return false;
  return true;
}

function isMetadata(address: string): boolean {
  return address === "169.254.169.254" || address === "fd00:ec2::254";
}

function isLoopback(address: string): boolean {
  return address === "127.0.0.1" || address.startsWith("127.");
}

function isLinkLocal(address: string): boolean {
  const parts = address.split(".").map((part) => Number(part));
  return parts.length === 4 && parts[0] === 169 && parts[1] === 254;
}

function isPrivate(address: string): boolean {
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) return false;
  const [a, b] = parts;
  if (a === 10 || a === 0) return true;
  if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b !== undefined && b >= 64 && b <= 127) return true;
  return false;
}

function isIpv6Private(address: string): boolean {
  const lower = address.toLowerCase();
  return lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80:");
}

const BLOCKED_HOSTS = new Set([
  "metadata.google.internal",
  "metadata.google",
  "instance-data",
]);

export async function assertUrlAllowed(rawUrl: string, policy: SsrfPolicy): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new FlowError("URL is invalid", "SSRF");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new FlowError("Only http and https URLs are allowed", "SSRF");
  }
  if (url.username || url.password) throw new FlowError("URLs must not include credentials", "SSRF");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (BLOCKED_HOSTS.has(host) || host.endsWith(".localhost")) {
    throw new FlowError(`Host is blocked: ${host}`, "SSRF");
  }
  if (isIP(host)) {
    if (!ipAllowed(host, policy)) throw new FlowError(`Address is blocked: ${host}`, "SSRF");
    return url;
  }
  let records: Array<{ address: string }>;
  try {
    records = await lookup(host, { all: true });
  } catch {
    throw new FlowError(`Could not resolve host: ${host}`, "SSRF");
  }
  if (records.length === 0) throw new FlowError(`Could not resolve host: ${host}`, "SSRF");
  for (const record of records) {
    if (!ipAllowed(record.address, policy)) {
      throw new FlowError(`Host ${host} resolves to a blocked address`, "SSRF");
    }
  }
  return url;
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const host = address.replace(/^::ffff:/, "");
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

export function hmacSha256(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

export function verifyHmacSha256(secret: string, body: string, signature: string | undefined): boolean {
  if (!signature) return false;
  const expected = hmacSha256(secret, body);
  const presented = signature.replace(/^sha256=/, "");
  return timingSafeStringEqual(expected, presented);
}
