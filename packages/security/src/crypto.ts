import crypto from 'node:crypto';

const ALGO = 'aes-256-gcm';

/** AES-256-GCM envelope for secrets at rest. The 32-byte key is supplied by the host. */
export class SecretBox {
  readonly #key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== 32) throw new Error('SecretBox key must be 32 bytes');
    this.#key = Buffer.from(key);
  }

  static generateKey(): Buffer {
    return crypto.randomBytes(32);
  }

  encrypt(plaintext: string, aad = ''): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGO, this.#key, iv);
    if (aad) cipher.setAAD(Buffer.from(aad));
    const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1.${iv.toString('base64')}.${tag.toString('base64')}.${enc.toString('base64')}`;
  }

  decrypt(payload: string, aad = ''): string {
    const [version, ivB64, tagB64, dataB64] = payload.split('.');
    if (version !== 'v1' || !ivB64 || !tagB64 || dataB64 === undefined) throw new Error('Unsupported secret format');
    const decipher = crypto.createDecipheriv(ALGO, this.#key, Buffer.from(ivB64, 'base64'));
    if (aad) decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
  }
}

/** Passphrase-based encryption for user-managed exports (scrypt KDF + AES-256-GCM). */
export function encryptWithPassphrase(plaintext: string, passphrase: string): string {
  if (passphrase.length < 12) throw new Error('Passphrase must be at least 12 characters');
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(passphrase, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `p1.${salt.toString('base64')}.${new SecretBox(key).encrypt(plaintext)}`;
}

export function decryptWithPassphrase(payload: string, passphrase: string): string {
  const [version, saltB64, ...rest] = payload.split('.');
  if (version !== 'p1' || !saltB64) throw new Error('Unsupported encrypted export format');
  const key = crypto.scryptSync(passphrase, Buffer.from(saltB64, 'base64'), 32, {
    N: 2 ** 15,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  return new SecretBox(key).decrypt(rest.join('.'));
}

export function sha256Hex(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function hmacSha256Hex(secret: string, body: string | Buffer): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

/** Verifies `sha256=<hex>` or bare hex HMAC signatures in constant time. */
export function verifyHmacSignature(secret: string, body: string | Buffer, signature: string): boolean {
  const provided = signature.startsWith('sha256=') ? signature.slice(7) : signature;
  return timingSafeEqualStr(hmacSha256Hex(secret, body), provided.toLowerCase());
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: 2 ** 15,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  return crypto.timingSafeEqual(expected, actual);
}
