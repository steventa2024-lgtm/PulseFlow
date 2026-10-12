import nodemailer from 'nodemailer';
import { NodeError, type CredentialData, type EmailMessage } from '@pulseflow/engine';

/** Sends mail through the user's own SMTP server. Connection uses STARTTLS when offered. */
export async function sendSmtpMail(cred: CredentialData, msg: EmailMessage): Promise<{ messageId: string; accepted: string[] }> {
  if (cred.type !== 'smtp') throw new NodeError('INVALID_CREDENTIAL', 'Credential is not an SMTP account');
  const port = Number(cred.data.port ?? 587);
  const transport = nodemailer.createTransport({
    host: cred.data.host,
    port,
    secure: cred.data.secure === 'true' || port === 465,
    auth: cred.data.user ? { user: cred.data.user, pass: cred.data.pass ?? '' } : undefined,
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 60_000,
  });
  try {
    const info = await transport.sendMail({ from: msg.from, to: msg.to, subject: msg.subject, text: msg.text, ...(msg.html ? { html: msg.html } : {}) });
    return { messageId: String(info.messageId), accepted: (info.accepted as (string | { address: string })[]).map((a) => (typeof a === 'string' ? a : a.address)) };
  } catch (e) {
    const code = (e as { code?: string; responseCode?: number }).code;
    const responseCode = (e as { responseCode?: number }).responseCode;
    throw new NodeError('SMTP_ERROR', `SMTP send failed: ${(e as Error).message}`, {
      retryable: code === 'ECONNECTION' || code === 'ETIMEDOUT' || (responseCode !== undefined && responseCode >= 400 && responseCode < 500),
    });
  } finally {
    transport.close();
  }
}
