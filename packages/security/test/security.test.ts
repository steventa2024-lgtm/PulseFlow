import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  PathPermissionError,
  REDACTED,
  SecretBox,
  assertPathAllowed,
  assertUrlAllowed,
  decryptWithPassphrase,
  encryptWithPassphrase,
  hashPassword,
  hmacSha256Hex,
  isPrivateAddress,
  redact,
  safeJsonParse,
  sanitizeFileName,
  verifyHmacSignature,
  verifyPassword,
} from '../src';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pf-sec-')));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('redaction', () => {
  it('redacts sensitive keys, known secrets, bearer tokens and URL credentials', () => {
    const out = redact(
      {
        password: 'hunter2',
        nested: { apiKey: 'k', ok: 'visible' },
        text: 'token is s3cr3t-value',
        auth: 'Bearer abc.def.ghi-123',
        url: 'https://user:pw@example.com/x',
      },
      { secrets: ['s3cr3t-value'] },
    );
    expect(out.password).toBe(REDACTED);
    expect(out.nested.apiKey).toBe(REDACTED);
    expect(out.nested.ok).toBe('visible');
    expect(out.text).not.toContain('s3cr3t-value');
    expect(JSON.stringify(out)).not.toContain('abc.def.ghi');
    expect(out.url).not.toContain('pw@');
  });
});

describe('filesystem policy', () => {
  const granted = path.join(tmp, 'granted');
  const other = path.join(tmp, 'other');
  fs.mkdirSync(granted, { recursive: true });
  fs.mkdirSync(other, { recursive: true });
  const policy = { grants: [{ path: granted, access: 'readwrite' as const }], appOwned: [] };

  it('allows paths inside a grant and blocks everything else', () => {
    expect(assertPathAllowed(path.join(granted, 'a.txt'), 'write', policy)).toBe(path.join(granted, 'a.txt'));
    expect(() => assertPathAllowed(path.join(other, 'a.txt'), 'read', policy)).toThrow(PathPermissionError);
    expect(() => assertPathAllowed(`${granted}/../other/a.txt`, 'read', policy)).toThrow(PathPermissionError);
    expect(() => assertPathAllowed('relative/path.txt', 'read', policy)).toThrow(/absolute/);
  });

  it('enforces read-only grants', () => {
    const ro = { grants: [{ path: granted, access: 'read' as const }], appOwned: [] };
    expect(() => assertPathAllowed(path.join(granted, 'x'), 'read', ro)).not.toThrow();
    expect(() => assertPathAllowed(path.join(granted, 'x'), 'write', ro)).toThrow(PathPermissionError);
  });

  it('blocks symlink escapes', () => {
    fs.writeFileSync(path.join(other, 'secret.txt'), 'nope');
    const link = path.join(granted, 'escape');
    try {
      fs.symlinkSync(other, link, 'dir');
    } catch {
      return; // symlinks unavailable (e.g. Windows without developer mode)
    }
    expect(() => assertPathAllowed(path.join(link, 'secret.txt'), 'read', policy)).toThrow(PathPermissionError);
  });

  it('does not treat a sibling with a common prefix as inside the grant', () => {
    fs.mkdirSync(`${granted}-evil`, { recursive: true });
    expect(() => assertPathAllowed(path.join(`${granted}-evil`, 'a'), 'read', policy)).toThrow(PathPermissionError);
  });

  it('sanitizes file names for every OS', () => {
    expect(sanitizeFileName('a<b>c:d"e/f\\g|h?i*j')).not.toMatch(/[<>:"/\\|?*]/);
    expect(sanitizeFileName('CON')).not.toBe('CON');
    expect(sanitizeFileName('name. ')).not.toMatch(/[. ]$/);
  });
});

describe('network policy', () => {
  it('classifies private addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.10', '172.16.5.4', '169.254.169.254', '::1', 'fd00::1', '0.0.0.0'])
      expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700::1111']) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it('blocks loopback and metadata endpoints unless allowed', async () => {
    await expect(assertUrlAllowed('http://127.0.0.1:8080/x', { allowPrivateNetwork: false })).rejects.toThrow(/private/);
    await expect(assertUrlAllowed('http://169.254.169.254/latest/meta-data', { allowPrivateNetwork: false })).rejects.toThrow(/private/);
    await expect(assertUrlAllowed('http://[::1]/', { allowPrivateNetwork: false })).rejects.toThrow();
    await expect(assertUrlAllowed('file:///etc/passwd', { allowPrivateNetwork: true })).rejects.toThrow(/http/);
    await expect(assertUrlAllowed('http://127.0.0.1:8080/x', { allowPrivateNetwork: false, allowHosts: ['127.0.0.1:8080'] })).resolves.toBeInstanceOf(URL);
    await expect(assertUrlAllowed('http://127.0.0.1:9999/x', { allowPrivateNetwork: false, allowHosts: ['127.0.0.1:8080'] })).rejects.toThrow();
  });
});

describe('crypto', () => {
  it('round-trips secrets and detects tampering or wrong AAD', () => {
    const box = new SecretBox(SecretBox.generateKey());
    const enc = box.encrypt('top secret', 'cred_1');
    expect(enc).not.toContain('top secret');
    expect(box.decrypt(enc, 'cred_1')).toBe('top secret');
    expect(() => box.decrypt(enc, 'cred_2')).toThrow();
    const parts = enc.split('.');
    parts[3] = Buffer.from('tampered').toString('base64');
    expect(() => box.decrypt(parts.join('.'), 'cred_1')).toThrow();
    expect(() => new SecretBox(SecretBox.generateKey()).decrypt(enc, 'cred_1')).toThrow();
  });

  it('encrypts exports with a passphrase', () => {
    const enc = encryptWithPassphrase('payload', 'correct horse');
    expect(decryptWithPassphrase(enc, 'correct horse')).toBe('payload');
    expect(() => decryptWithPassphrase(enc, 'wrong')).toThrow();
  });

  it('verifies HMAC signatures (with and without sha256= prefix)', () => {
    const sig = hmacSha256Hex('secret', '{"a":1}');
    expect(verifyHmacSignature('secret', '{"a":1}', sig)).toBe(true);
    expect(verifyHmacSignature('secret', '{"a":1}', `sha256=${sig}`)).toBe(true);
    expect(verifyHmacSignature('secret', '{"a":2}', sig)).toBe(false);
    expect(verifyHmacSignature('secret', '{"a":1}', '')).toBe(false);
  });

  it('hashes passwords with a salt', () => {
    const h = hashPassword('pa55word!');
    expect(h).not.toContain('pa55word');
    expect(hashPassword('pa55word!')).not.toBe(h);
    expect(verifyPassword('pa55word!', h)).toBe(true);
    expect(verifyPassword('wrong', h)).toBe(false);
  });
});

describe('safe JSON', () => {
  it('rejects prototype pollution keys and oversized/deep input', () => {
    expect(() => safeJsonParse('{"__proto__":{"polluted":true}}')).toThrow();
    expect(() => safeJsonParse('{"a":{"constructor":{"prototype":{}}}}')).toThrow();
    expect(() => safeJsonParse('['.repeat(200) + ']'.repeat(200))).toThrow();
    expect(() => safeJsonParse('"x"', { maxBytes: 1 })).toThrow();
    expect(safeJsonParse('{"ok":[1,2]}')).toEqual({ ok: [1, 2] });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
