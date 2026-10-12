import { newId, type CredentialMeta } from '@pulseflow/contracts';
import { credentialType, secretFieldNames } from '@pulseflow/connectors';
import { NodeError, type CredentialData } from '@pulseflow/engine';
import type { SecretBox } from '@pulseflow/security';
import type { CredentialRow, Store } from '@pulseflow/storage';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/** Encrypted credential vault. Plaintext never leaves this class except to node executors. */
export class CredentialService {
  constructor(
    private readonly store: Store,
    private readonly box: SecretBox,
    private readonly workspaceId: string,
  ) {}

  #meta(r: CredentialRow): CredentialMeta {
    return {
      id: r.id,
      name: r.name,
      type: r.type,
      fields: JSON.parse(r.fields) as string[],
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      lastCheckedAt: r.last_checked_at,
      lastCheckOk: r.last_check_ok === null ? null : r.last_check_ok === 1,
    };
  }

  list(): CredentialMeta[] {
    return this.store.credentials.list(this.workspaceId).map((r) => this.#meta(r));
  }

  get(id: string): CredentialMeta | undefined {
    const r = this.store.credentials.get(id);
    return r ? this.#meta(r) : undefined;
  }

  #validate(type: string, data: Record<string, string>, partial = false): void {
    const def = credentialType(type);
    if (!def) throw new HttpError(400, 'UNKNOWN_CREDENTIAL_TYPE', `Unknown credential type "${type}"`);
    for (const f of def.fields) {
      if (!partial && f.required && !data[f.name]) throw new HttpError(400, 'FIELD_REQUIRED', `${def.displayName}: "${f.label}" is required`);
    }
    for (const k of Object.keys(data)) {
      if (!def.fields.some((f) => f.name === k)) throw new HttpError(400, 'UNKNOWN_FIELD', `Unknown field "${k}" for ${def.displayName}`);
    }
  }

  create(input: { name: string; type: string; data: Record<string, string>; id?: string }): CredentialMeta {
    this.#validate(input.type, input.data);
    const id = input.id ?? newId('cred');
    this.store.credentials.create({
      id,
      workspace_id: this.workspaceId,
      name: input.name,
      type: input.type,
      encrypted: this.box.encrypt(JSON.stringify(input.data), id),
      fields: JSON.stringify(Object.keys(input.data)),
    });
    return this.get(id)!;
  }

  /** Fields omitted from `data` keep their current values (so the UI never needs plaintext). */
  update(id: string, input: { name?: string; data?: Record<string, string> }): CredentialMeta {
    const row = this.store.credentials.get(id);
    if (!row) throw new HttpError(404, 'NOT_FOUND', 'Credential not found');
    let encrypted: string | undefined;
    let fields: string | undefined;
    if (input.data) {
      this.#validate(row.type, input.data, true);
      const merged = { ...this.#decryptRow(row), ...Object.fromEntries(Object.entries(input.data).filter(([, v]) => v !== '')) };
      this.#validate(row.type, merged);
      encrypted = this.box.encrypt(JSON.stringify(merged), id);
      fields = JSON.stringify(Object.keys(merged));
    }
    this.store.credentials.update(id, { name: input.name, encrypted, fields });
    return this.get(id)!;
  }

  delete(id: string): boolean {
    return this.store.credentials.delete(id);
  }

  #decryptRow(row: CredentialRow): Record<string, string> {
    try {
      return JSON.parse(this.box.decrypt(row.encrypted, row.id)) as Record<string, string>;
    } catch {
      throw new NodeError('CREDENTIAL_DECRYPT_FAILED', `Credential "${row.name}" could not be decrypted (was the encryption key changed?)`);
    }
  }

  /** Decrypts for a node executor and reports secret values so they get redacted from logs. */
  resolve(id: string, onSecret: (value: string) => void): CredentialData {
    const row = this.store.credentials.get(id);
    if (!row) throw new NodeError('CREDENTIAL_NOT_FOUND', `Credential ${id} does not exist (it may have been deleted)`);
    const data = this.#decryptRow(row);
    for (const f of secretFieldNames(row.type)) if (data[f]) onSecret(data[f]);
    if (row.type === 'discordWebhook' && data.url) onSecret(data.url);
    return { id: row.id, type: row.type, data };
  }

  /** All secret values (used to scrub exports/logs). */
  allSecretValues(): string[] {
    const out: string[] = [];
    for (const r of this.store.credentials.all()) {
      try {
        const d = this.#decryptRow(r);
        for (const f of secretFieldNames(r.type)) if (d[f]) out.push(d[f]);
      } catch {
        // undecryptable rows have nothing to scrub
      }
    }
    return out;
  }
}
