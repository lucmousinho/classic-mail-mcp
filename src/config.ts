import { readFileSync } from 'node:fs';
import { z } from 'zod';

export const folderSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((s) => !/[\r\n\0]/.test(s));
const username = z
  .string()
  .min(1)
  .max(254)
  .refine((s) => !/[\r\n\0]/.test(s));
// Only operators select hosts; tool calls cannot supply URLs or credentials.
const hostname = z
  .string()
  .max(253)
  .regex(
    /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/,
  );
export const accountSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9_-]{1,40}$/),
    email: z.email(),
    name: z.string().max(100).optional(),
    username,
    password: z.string().min(1).max(4096),
    imapHost: hostname,
    imapPort: z.union([z.literal(993), z.literal(143)]).default(993),
    allowedFolders: z.array(folderSchema).min(1).max(100).optional(),
    smtpHost: hostname,
    smtpPort: z.union([z.literal(465), z.literal(587)]).default(465),
    smtpUsername: username.optional(),
    smtpPassword: z.string().min(1).max(4096).optional(),
    sentFolder: folderSchema.optional(),
    draftsFolder: folderSchema.optional(),
    trashFolder: folderSchema.optional(),
    archiveFolder: folderSchema.optional(),
    appendSent: z.boolean().default(true),
  })
  .strict()
  .refine(
    (a) => Boolean(a.smtpUsername) === Boolean(a.smtpPassword),
    'Provide both SMTP credentials or neither',
  );
export type Account = z.infer<typeof accountSchema>;
const key = z.string().min(43).max(256);
const accounts = z
  .array(accountSchema)
  .min(1)
  .max(10)
  .refine((a) => new Set(a.map((x) => x.id)).size === a.length, 'Account IDs must be unique');
export const localSecretSchema = z
  .object({ accounts, encryptionKey: key, bearerToken: key.optional() })
  .strict();
export const secretSchema = z
  .object({
    googleClientId: z.string().endsWith('.apps.googleusercontent.com'),
    googleClientSecret: z.string().min(10),
    allowedEmails: z.array(z.email()).length(1),
    jwtSigningKey: key,
    encryptionKey: key,
    consentSigningKey: key,
    accounts,
  })
  .strict()
  .refine(
    (v) => new Set([v.jwtSigningKey, v.encryptionKey, v.consentSigningKey]).size === 3,
    'Use independent cryptographic keys',
  );
export type Secrets = z.infer<typeof secretSchema>;

/**
 * Multi-user "mailbox" mode: nobody's mailbox password lives in the configuration. Each person
 * signs in through the server's own OAuth authorization server with their IMAP credentials,
 * which are verified against the provider, sealed with encryptionKey and bound to that person.
 */
export const providerSchema = z
  .object({
    imapHost: hostname,
    imapPort: z.union([z.literal(993), z.literal(143)]).default(993),
    smtpHost: hostname,
    smtpPort: z.union([z.literal(465), z.literal(587)]).default(465),
    sentFolder: folderSchema.optional(),
    draftsFolder: folderSchema.optional(),
    trashFolder: folderSchema.optional(),
    archiveFolder: folderSchema.optional(),
    appendSent: z.boolean().default(true),
  })
  .strict();
export const mailboxSecretSchema = z
  .object({
    allowedDomains: z.array(hostname.toLowerCase()).min(1).max(50),
    provider: providerSchema,
    displayName: z.string().min(1).max(60).default('Classic Mail'),
    jwtSigningKey: key,
    encryptionKey: key,
    consentSigningKey: key,
  })
  .strict()
  .refine(
    (v) => new Set([v.jwtSigningKey, v.encryptionKey, v.consentSigningKey]).size === 3,
    'Use independent cryptographic keys',
  );
export type MailboxSecrets = z.infer<typeof mailboxSecretSchema>;

export function readConfig() {
  const transport = z.enum(['stdio', 'http']).parse(process.env.TRANSPORT ?? 'http');
  const authMode = z
    .enum(['oauth', 'bearer', 'stdio', 'mailbox'])
    .parse(process.env.AUTH_MODE ?? (transport === 'stdio' ? 'stdio' : 'bearer'));
  if ((transport === 'stdio') !== (authMode === 'stdio'))
    throw Error('stdio requires AUTH_MODE=stdio; HTTP requires authentication');
  const port = z.coerce
    .number()
    .int()
    .min(1024)
    .max(65534)
    .parse(process.env.PORT ?? 8080);
  const baseUrl = process.env.BASE_URL ?? `http://127.0.0.1:${port}`;
  try {
    const u = new URL(baseUrl);
    if (
      u.origin !== baseUrl ||
      (u.protocol !== 'https:' &&
        !(
          authMode !== 'oauth' &&
          authMode !== 'mailbox' &&
          u.protocol === 'http:' &&
          ['localhost', '127.0.0.1'].includes(u.hostname)
        ))
    )
      throw Error();
  } catch {
    throw Error(
      'BASE_URL must be an HTTPS origin (loopback HTTP is allowed only for local bearer mode)',
    );
  }
  const source = process.env.APP_CONFIG_JSON,
    file = process.env.APP_CONFIG_FILE;
  if (source && file) throw Error('Choose APP_CONFIG_FILE or APP_CONFIG_JSON, not both');
  let secrets: z.infer<typeof localSecretSchema> | Secrets | MailboxSecrets | undefined;
  if (source || file) {
    try {
      const raw = source ?? readFileSync(file!, 'utf8');
      if (Buffer.byteLength(raw) > 1024 * 1024) throw Error();
      secrets = (
        authMode === 'oauth'
          ? secretSchema
          : authMode === 'mailbox'
            ? mailboxSecretSchema
            : localSecretSchema
      ).parse(JSON.parse(raw));
      if (
        authMode === 'bearer' &&
        (!('bearerToken' in secrets) ||
          !secrets.bearerToken ||
          secrets.bearerToken === secrets.encryptionKey)
      )
        throw Error();
    } catch {
      throw Error(
        'Secret configuration is invalid; check schema and permissions. Values are never logged.',
      );
    }
  }
  if (transport === 'stdio' && !secrets)
    throw Error('APP_CONFIG_FILE or APP_CONFIG_JSON is required for stdio');
  const storage = z.enum(['sqlite', 'firestore']).parse(process.env.STORAGE ?? 'sqlite');
  if (process.env.K_SERVICE && storage !== 'firestore')
    throw Error('Cloud Run requires STORAGE=firestore; ephemeral SQLite would lose send history');
  return {
    baseUrl,
    secrets,
    port,
    transport,
    authMode,
    storage,
    accessMode: z.enum(['read-only', 'read-write']).parse(process.env.ACCESS_MODE ?? 'read-only'),
    host: z.enum(['127.0.0.1', '0.0.0.0']).parse(process.env.HOST ?? '127.0.0.1'),
    sqlitePath: process.env.SQLITE_PATH ?? 'data/classic-mail.sqlite',
    projectId: process.env.GOOGLE_CLOUD_PROJECT,
    databaseId: process.env.FIRESTORE_DATABASE ?? 'classic-mail-mcp',
  };
}
