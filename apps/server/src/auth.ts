import { newId, newToken } from '@pulseflow/contracts';
import { hashPassword, sha256Hex, timingSafeEqualStr, verifyPassword } from '@pulseflow/security';
import type { Store, UserRow } from '@pulseflow/storage';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { HttpError } from './credentials';
import type { HostMode } from './config';

export type Role = UserRow['role'];
const RANK: Record<Role, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 };

export interface Principal {
  userId: string;
  name: string;
  role: Role;
  via: 'local-token' | 'session' | 'api-token';
}

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
    rawBody?: string;
  }
}

const SESSION_TTL_MS = 7 * 86_400_000;

export class AuthService {
  constructor(
    private readonly store: Store,
    private readonly mode: HostMode,
    private readonly localToken: string,
  ) {}

  /** Resolves the caller from `Authorization: Bearer`, or `access_token` for EventSource/download URLs. */
  authenticate(req: FastifyRequest): Principal {
    const header = req.headers.authorization;
    const query = (req.query as Record<string, unknown> | undefined)?.access_token;
    const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : typeof query === 'string' ? query : '';
    if (!token) throw new HttpError(401, 'UNAUTHENTICATED', 'Missing access token');
    if (this.mode === 'local') {
      if (!timingSafeEqualStr(token, this.localToken)) throw new HttpError(401, 'UNAUTHENTICATED', 'Invalid access token');
      return { userId: 'local', name: 'Local user', role: 'owner', via: 'local-token' };
    }
    const row = this.store.users.tokenByHash(sha256Hex(token));
    if (!row) throw new HttpError(401, 'UNAUTHENTICATED', 'Invalid access token');
    if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) throw new HttpError(401, 'TOKEN_EXPIRED', 'Session expired; sign in again');
    const user = this.store.users.get(row.user_id);
    if (!user || user.disabled) throw new HttpError(401, 'UNAUTHENTICATED', 'Account disabled');
    this.store.users.touchToken(row.id);
    return { userId: user.id, name: user.name, role: user.role, via: row.kind === 'session' ? 'session' : 'api-token' };
  }

  needsSetup(): boolean {
    return this.mode === 'server' && this.store.users.count() === 0;
  }

  setup(input: { email: string; name: string; password: string }): { token: string; user: UserRow } {
    if (!this.needsSetup()) throw new HttpError(409, 'ALREADY_SET_UP', 'An owner account already exists');
    const user = this.store.users.create({ email: input.email.toLowerCase(), name: input.name, passwordHash: hashPassword(input.password), role: 'owner' });
    return { token: this.#session(user.id), user };
  }

  login(email: string, password: string): { token: string; user: UserRow } {
    const user = this.store.users.byEmail(email.toLowerCase());
    // Always run the KDF so response time does not reveal whether the account exists.
    const ok = verifyPassword(password, user?.password_hash ?? hashPassword('timing-equalizer'));
    if (!user || !ok || user.disabled) throw new HttpError(401, 'INVALID_LOGIN', 'Email or password is incorrect');
    return { token: this.#session(user.id), user };
  }

  createUser(input: { email: string; name: string; password: string; role: Role }): UserRow {
    if (this.store.users.byEmail(input.email.toLowerCase())) throw new HttpError(409, 'EMAIL_TAKEN', 'A user with that email exists');
    return this.store.users.create({ email: input.email.toLowerCase(), name: input.name, passwordHash: hashPassword(input.password), role: input.role });
  }

  createApiToken(userId: string, name: string): { id: string; token: string } {
    const token = `pf_${newToken(32)}`;
    const id = newId('tok');
    this.store.users.addToken({ id, user_id: userId, name, token_hash: sha256Hex(token), scopes: '*', kind: 'api', expires_at: null });
    return { id, token };
  }

  logout(req: FastifyRequest): void {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return;
    const row = this.store.users.tokenByHash(sha256Hex(header.slice(7).trim()));
    if (row?.kind === 'session') this.store.users.deleteToken(row.id, row.user_id);
  }

  #session(userId: string): string {
    const token = newToken(32);
    this.store.users.addToken({
      id: newId('ses'),
      user_id: userId,
      name: 'session',
      token_hash: sha256Hex(token),
      scopes: '*',
      kind: 'session',
      expires_at: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
    });
    return token;
  }
}

export function requireRole(req: FastifyRequest, min: Role): Principal {
  const p = req.principal;
  if (!p) throw new HttpError(401, 'UNAUTHENTICATED', 'Not signed in');
  if (RANK[p.role] < RANK[min]) throw new HttpError(403, 'FORBIDDEN', `Requires ${min} role`);
  return p;
}

export function roleForRequest(method: string): Role {
  return method === 'GET' || method === 'HEAD' ? 'viewer' : 'editor';
}

/**
 * Rejects requests whose Host header is not the loopback address we listen on. This blocks DNS
 * rebinding attacks where a web page resolves its own domain to 127.0.0.1.
 */
export function checkHost(req: FastifyRequest, reply: FastifyReply, allowed: () => string[]): boolean {
  const host = (req.headers.host ?? '').toLowerCase();
  if (allowed().includes(host)) return true;
  void reply.code(421).send({ error: { code: 'BAD_HOST', message: 'Unexpected Host header' } });
  return false;
}

export function checkOrigin(req: FastifyRequest, allowedOrigins: () => string[]): void {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
  const origin = req.headers.origin;
  if (!origin || origin === 'null') return;
  if (!allowedOrigins().includes(origin.toLowerCase())) throw new HttpError(403, 'BAD_ORIGIN', 'Cross-origin requests are not allowed');
}
