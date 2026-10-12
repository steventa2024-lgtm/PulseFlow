import type { CredentialTypeDef } from '@pulseflow/contracts';

export const CREDENTIAL_TYPES: CredentialTypeDef[] = [
  {
    type: 'httpBasic',
    displayName: 'HTTP Basic Auth',
    fields: [
      { name: 'username', label: 'Username', secret: false, required: true },
      { name: 'password', label: 'Password', secret: true, required: true },
    ],
  },
  { type: 'httpBearer', displayName: 'Bearer Token', fields: [{ name: 'token', label: 'Token', secret: true, required: true }] },
  {
    type: 'httpHeader',
    displayName: 'Custom Header',
    fields: [
      { name: 'name', label: 'Header name', secret: false, required: true, placeholder: 'x-api-key' },
      { name: 'value', label: 'Header value', secret: true, required: true },
    ],
  },
  {
    type: 'githubToken',
    displayName: 'GitHub Personal Access Token',
    fields: [{ name: 'token', label: 'Fine-grained or classic token', secret: true, required: true }],
    docsUrl: 'https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens',
  },
  {
    type: 'discordWebhook',
    displayName: 'Discord Webhook',
    fields: [{ name: 'url', label: 'Webhook URL', secret: true, required: true, placeholder: 'https://discord.com/api/webhooks/…' }],
    docsUrl: 'https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks',
  },
  {
    type: 'telegramBot',
    displayName: 'Telegram Bot',
    fields: [{ name: 'token', label: 'Bot token (from @BotFather)', secret: true, required: true }],
    docsUrl: 'https://core.telegram.org/bots/api',
  },
  {
    type: 'smtp',
    displayName: 'SMTP Server',
    fields: [
      { name: 'host', label: 'Host', secret: false, required: true, placeholder: 'smtp.example.com' },
      { name: 'port', label: 'Port', secret: false, required: true, placeholder: '587' },
      { name: 'secure', label: 'Implicit TLS (true for port 465)', secret: false, required: false, placeholder: 'false' },
      { name: 'user', label: 'Username', secret: false, required: false },
      { name: 'pass', label: 'Password', secret: true, required: false },
    ],
  },
  { type: 'webhookSecret', displayName: 'Webhook Shared Secret', fields: [{ name: 'secret', label: 'Secret', secret: true, required: true }] },
];

export function credentialType(type: string): CredentialTypeDef | undefined {
  return CREDENTIAL_TYPES.find((t) => t.type === type);
}

export function secretFieldNames(type: string): string[] {
  return (
    credentialType(type)
      ?.fields.filter((f) => f.secret)
      .map((f) => f.name) ?? []
  );
}
