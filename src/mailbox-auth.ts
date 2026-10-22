import type { FastMCP } from 'fastmcp';
import type { IncomingMessage } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { ImapFlow } from 'imapflow';
import { z } from 'zod';
import type { Database } from './store.js';
import { FirestoreTokenStore, FirestoreLedger, rateLimit, type SendLedger } from './store.js';
import { accountSchema, type Account, type MailboxSecrets } from './config.js';
import { MailService, imapOptions } from './mail.js';
import { isAllowedCallback, CALLBACK_HINT, mcpResource, type Session } from './auth.js';
import { open, seal, subjectFor } from './sealed.js';

/**
 * Multi-user authorization server ("mailbox" mode).
 *
 * The server is its own OAuth 2.1 authorization server: no third-party identity provider. A
 * person proves who they are by signing in with the IMAP credentials of a mailbox on one of the
 * operator's allowed domains; the password is verified against the provider once, sealed with the
 * operator's encryption key and bound to that person. Every token is bound to that subject and
 * every tool call resolves to that subject's mailbox only.
 *
 * Flow (all endpoints under the configured BASE_URL):
 *   POST /oauth/register  Dynamic Client Registration (public clients, S256 PKCE)
 *   GET  /oauth/authorize validates the request, opens a transaction, renders the sign-in form
 *   POST /oauth/login     verifies the mailbox, stores the sealed credential, issues the code
 *   POST /oauth/token     authorization_code and refresh_token grants (refresh rotation)
 *   POST /oauth/revoke    revokes a refresh or access token
 */
export const MAILBOX_SCOPES = ['mail'];
const ACCESS_TTL = 3600,
  REFRESH_TTL = 30 * 24 * 3600,
  CODE_TTL = 120,
  TRANSACTION_TTL = 600,
  CLIENT_TTL = 400 * 24 * 3600;
const COOKIE = '__Host-classic_mail_login';
const email = z.email().max(254);

export class AuthError extends Error {
  constructor(
    public code: string,
    public description: string,
    public status = 400,
  ) {
    super(code);
  }
  json() {
    return { error: this.code, error_description: this.description };
  }
}

type Client = { redirectUris: string[]; createdAt: number };
type Transaction = {
  clientId: string;
  redirectUri: string;
  challenge: string;
  state: string | null;
  createdAt: number;
};
type UserRecord = { email: string; sealed: string; createdAt: number; lastLoginAt: number };
type Grant = { sub: string; clientId: string };

export type MailboxAuthOptions = {
  baseUrl: string;
  secrets: MailboxSecrets;
  db: Database;
  accessMode: 'read-only' | 'read-write';
  /** Verifies credentials against the provider; replaced in tests. Must throw on failure. */
  verifyMailbox?: (account: Account) => Promise<void>;
  now?: () => number;
};

const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

/** The account record a signed-in person operates on: their own mailbox, nothing else. */
export function accountFor(secrets: MailboxSecrets, address: string, password: string): Account {
  const local = address
    .split('@')[0]!
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-');
  return accountSchema.parse({
    id: local.replace(/^-+|-+$/g, '').slice(0, 40) || 'mailbox',
    email: address,
    name: address,
    username: address,
    password,
    ...secrets.provider,
  });
}

/** Default verifier: one TLS-verified IMAP login, then logout. No SMTP attempt (same credential). */
export async function imapLogin(account: Account) {
  const client = new ImapFlow({ ...imapOptions(account), connectionTimeout: 20000 });
  client.on('error', () => {});
  try {
    await client.connect();
  } finally {
    try {
      await client.logout();
    } catch {
      client.close();
    }
  }
}

export class MailboxAuth {
  private store: FirestoreTokenStore;
  private ledger: SendLedger;
  private services = new Map<string, { service: MailService; expires: number }>();
  private signingKey: Uint8Array;
  private cookieKey: Uint8Array;
  private verifyMailbox: (account: Account) => Promise<void>;
  private now: () => number;
  constructor(private options: MailboxAuthOptions) {
    this.store = new FirestoreTokenStore(options.db);
    this.ledger = new FirestoreLedger(options.db);
    this.signingKey = new TextEncoder().encode(options.secrets.jwtSigningKey);
    this.cookieKey = new TextEncoder().encode(options.secrets.consentSigningKey);
    this.verifyMailbox = options.verifyMailbox ?? imapLogin;
    this.now = options.now ?? (() => Date.now());
  }
  private get baseUrl() {
    return this.options.baseUrl;
  }

  /** RFC 8414 metadata, in FastMCP's camelCase form. */
  metadata() {
    return {
      issuer: this.baseUrl,
      authorizationEndpoint: `${this.baseUrl}/oauth/authorize`,
      tokenEndpoint: `${this.baseUrl}/oauth/token`,
      registrationEndpoint: `${this.baseUrl}/oauth/register`,
      revocationEndpoint: `${this.baseUrl}/oauth/revoke`,
      responseTypesSupported: ['code'],
      responseModesSupported: ['query'],
      grantTypesSupported: ['authorization_code', 'refresh_token'],
      codeChallengeMethodsSupported: ['S256'],
      tokenEndpointAuthMethodsSupported: ['none'],
      scopesSupported: MAILBOX_SCOPES,
      authorizationResponseIssParameterSupported: true,
    };
  }
  protectedResource() {
    return {
      resource: mcpResource(this.baseUrl),
      authorizationServers: [this.baseUrl],
      scopesSupported: MAILBOX_SCOPES,
      bearerMethodsSupported: ['header'],
    };
  }

  /** Bearer verification for every MCP request. Returns undefined (401) on any doubt. */
  authenticate() {
    return async (req: IncomingMessage): Promise<Session | undefined> => {
      const header = req.headers.authorization;
      if (!header?.startsWith('Bearer ') || header.length > 4096) return undefined;
      let stage = 'token_verification';
      const denied = () => {
        console.info(JSON.stringify({ event: 'mcp_auth_rejected', stage }));
        return undefined;
      };
      try {
        const { payload } = await jwtVerify(header.slice(7), this.signingKey, {
          algorithms: ['HS256'],
          issuer: this.baseUrl,
          audience: this.baseUrl,
          requiredClaims: ['exp', 'iat', 'jti', 'sub', 'scope'],
        });
        stage = 'token_kind';
        const grant = (await this.store.get('mb-access:' + payload.jti)) as Grant | null;
        if (!grant || grant.sub !== payload.sub) return denied();
        stage = 'user_record';
        const user = (await this.store.get('mb-user:' + payload.sub)) as UserRecord | null;
        if (!user) return denied();
        stage = 'rate_limit';
        await rateLimit(this.options.db, payload.sub!, 'mcp', 120, 60);
        return { email: user.email, sub: payload.sub! };
      } catch {
        return denied();
      }
    };
  }

  /** The signed-in person's MailService: one account, ledger keys prefixed with their subject. */
  async mailFor(session: Session): Promise<MailService> {
    const cached = this.services.get(session.sub);
    if (cached && cached.expires > this.now()) return cached.service;
    const user = (await this.store.get('mb-user:' + session.sub)) as UserRecord | null;
    if (!user) throw new Error('Unknown user');
    const password = open(this.options.secrets.encryptionKey, session.sub, user.sealed);
    const account = accountFor(this.options.secrets, user.email, password);
    const prefix = session.sub + ':';
    const ledger: SendLedger = {
      claim: (key, hash) => this.ledger.claim(prefix + key, hash),
      finish: (key, state, result) => this.ledger.finish(prefix + key, state, result),
    };
    const service = new MailService(
      [account],
      undefined,
      ledger,
      this.options.secrets.encryptionKey,
    );
    if (this.services.size > 500) this.services.clear();
    this.services.set(session.sub, { service, expires: this.now() + 15 * 60 * 1000 });
    return service;
  }

  /** Administration: list known users, or remove one (revokes every token immediately). */
  async listUsers() {
    return ((await this.store.get('mb-users')) as { sub: string; email: string }[] | null) ?? [];
  }
  async removeUser(address: string) {
    const sub = subjectFor(this.options.secrets.encryptionKey, address);
    await this.store.delete('mb-user:' + sub);
    this.services.delete(sub);
    const users = (await this.listUsers()).filter((u) => u.sub !== sub);
    await this.store.save('mb-users', users);
    return sub;
  }

  private async client(id: string | null) {
    if (!id || id.length > 200) return null;
    return (await this.store.get('mb-client:' + id)) as Client | null;
  }
  private async issueTokens(sub: string, clientId: string) {
    const jti = randomBytes(16).toString('base64url');
    const now = Math.floor(this.now() / 1000);
    const access = await new SignJWT({ scope: MAILBOX_SCOPES.join(' ') })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(this.baseUrl)
      .setAudience(this.baseUrl)
      .setSubject(sub)
      .setJti(jti)
      .setIssuedAt(now)
      .setExpirationTime(now + ACCESS_TTL)
      .sign(this.signingKey);
    const refresh = randomBytes(32).toString('base64url');
    await this.store.save('mb-access:' + jti, { sub, clientId } satisfies Grant, ACCESS_TTL);
    await this.store.save('mb-refresh:' + refresh, { sub, clientId } satisfies Grant, REFRESH_TTL);
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: ACCESS_TTL,
      refresh_token: refresh,
      scope: MAILBOX_SCOPES.join(' '),
    };
  }
  private async cookieBinding(cookieHeader: string | undefined, transaction: string | null) {
    const value = cookieHeader
      ?.split(';')
      .map((x) => x.trim())
      .find((x) => x.startsWith(COOKIE + '='))
      ?.slice(COOKIE.length + 1);
    if (!value || !transaction)
      throw new AuthError('invalid_request', 'Restart sign-in in this browser');
    try {
      const { payload } = await jwtVerify(value, this.cookieKey, {
        algorithms: ['HS256'],
        issuer: this.baseUrl,
        audience: 'oauth-browser',
      });
      if (payload.transaction !== transaction) throw new Error('Mismatch');
    } catch {
      throw new AuthError('invalid_request', 'Browser binding mismatch; restart sign-in');
    }
  }

  private page(transaction: string, redirectHost: string, error?: string) {
    const s = this.options.secrets;
    const permissions =
      this.options.accessMode === 'read-write'
        ? 'read your mail and attachments, send replies and new messages, manage drafts and folders, and delete messages when you explicitly ask it to'
        : 'read your mail and attachments and check the connection; sending and deleting are disabled on this server';
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(s.displayName)} · Sign in</title>
<style>:root{color-scheme:dark;font-family:system-ui,sans-serif;background:#0d1720;color:#eaf3f5}*{box-sizing:border-box}body{margin:0;display:grid;place-items:center;min-height:100vh;padding:24px}main{width:100%;max-width:440px;border:1px solid #36505a;border-radius:20px;padding:30px;background:#14242e}h1{font-size:22px;margin:0 0 6px}p{color:#b9c9d1;line-height:1.55;font-size:15px}label{display:block;font-size:13px;color:#9fe7ce;margin:18px 0 6px;text-transform:uppercase;letter-spacing:.08em}input{width:100%;padding:12px;border-radius:10px;border:1px solid #36505a;background:#0d1720;color:#fff;font-size:16px}button{margin-top:22px;width:100%;padding:13px;border:0;border-radius:10px;background:#9fe7ce;color:#0d1720;font-weight:700;font-size:16px}.err{border:1px solid #c96;border-radius:10px;padding:10px 12px;color:#ffd9b3;font-size:14px}.host{color:#fff}small{display:block;margin-top:16px;color:#8fa4af;line-height:1.6}</style></head><body><main>
<h1>${escape(s.displayName)}</h1>
<p>Sign in with your <strong>email mailbox</strong> to connect it to the assistant. The assistant will be able to ${permissions}. Only your own mailbox is ever accessible.</p>
<p>After sign-in you will be returned to <strong class="host">${escape(redirectHost)}</strong>.</p>
${error ? `<div class="err">${escape(error)}</div>` : ''}
<form method="post" action="/oauth/login" autocomplete="on">
<input type="hidden" name="transaction_id" value="${escape(transaction)}">
<label for="email">Email address</label><input id="email" name="email" type="email" required maxlength="254" autocomplete="username" placeholder="you@${escape(s.allowedDomains[0]!)}">
<label for="password">Mailbox password</label><input id="password" name="password" type="password" required maxlength="4096" autocomplete="current-password">
<button type="submit">Sign in and connect</button>
</form>
<small>Allowed domains: ${s.allowedDomains.map(escape).join(', ')}. Your password is checked against ${escape(s.provider.imapHost)} and stored encrypted on this server only. Too many failed attempts lock sign-in for a while.</small>
</main></body></html>`;
  }

  routes(server: FastMCP<Session>) {
    const app = server.getApp();
    const json = (c: { json: (b: unknown, s: number) => Response }, e: unknown) =>
      e instanceof AuthError ? c.json(e.json(), e.status) : c.json({ error: 'server_error' }, 400);
    app.onError((e, c) => json(c as never, e));
    app.use('/oauth/*', async (c, next) => {
      c.header('Cache-Control', 'no-store');
      c.header('Pragma', 'no-cache');
      c.header('Referrer-Policy', 'same-origin');
      c.header('X-Content-Type-Options', 'nosniff');
      try {
        await next();
      } catch (e) {
        return json(c as never, e);
      }
    });

    app.post('/oauth/register', async (c) => {
      await rateLimit(this.options.db, 'public', 'dcr', 30, 3600);
      let body: {
        redirect_uris?: unknown;
        token_endpoint_auth_method?: unknown;
        client_name?: unknown;
      };
      try {
        body = await c.req.json();
      } catch {
        throw new AuthError('invalid_client_metadata', 'Body must be JSON');
      }
      if (
        !Array.isArray(body.redirect_uris) ||
        body.redirect_uris.length < 1 ||
        body.redirect_uris.length > 5 ||
        !body.redirect_uris.every(isAllowedCallback)
      )
        throw new AuthError('invalid_redirect_uri', CALLBACK_HINT);
      if (body.token_endpoint_auth_method && body.token_endpoint_auth_method !== 'none')
        throw new AuthError('invalid_client_metadata', 'Only public clients with PKCE are issued');
      const clientId = 'mb_' + randomBytes(18).toString('base64url');
      await this.store.save(
        'mb-client:' + clientId,
        { redirectUris: body.redirect_uris, createdAt: this.now() } satisfies Client,
        CLIENT_TTL,
      );
      return c.json(
        {
          client_id: clientId,
          client_id_issued_at: Math.floor(this.now() / 1000),
          client_name: 'Classic Mail MCP',
          redirect_uris: body.redirect_uris,
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
          scope: MAILBOX_SCOPES.join(' '),
        },
        201,
      );
    });

    app.get('/oauth/authorize', async (c) => {
      await rateLimit(this.options.db, 'public', 'authorize', 200, 3600);
      const p = new URL(c.req.url).searchParams;
      const one = (k: string) => (p.getAll(k).length === 1 ? p.get(k) : null);
      const client = await this.client(one('client_id'));
      if (!client) throw new AuthError('invalid_client', 'Unknown client; register first', 401);
      const redirectUri = one('redirect_uri');
      if (
        !redirectUri ||
        !client.redirectUris.includes(redirectUri) ||
        !isAllowedCallback(redirectUri)
      )
        throw new AuthError('invalid_redirect_uri', CALLBACK_HINT);
      if (one('response_type') !== 'code')
        throw new AuthError('unsupported_response_type', 'Only response_type=code');
      const challenge = one('code_challenge') ?? '';
      if (one('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(challenge))
        throw new AuthError('invalid_request', 'S256 PKCE is required');
      const resources = p.getAll('resource');
      if (
        resources.length > 1 ||
        resources.some((r) => r !== this.baseUrl && r !== mcpResource(this.baseUrl))
      )
        throw new AuthError('invalid_target', 'Resource does not match this server');
      const scope = one('scope');
      if (scope && scope.split(' ').some((x) => !MAILBOX_SCOPES.includes(x)))
        throw new AuthError('invalid_scope', 'Unsupported scope');
      const state = one('state');
      if (state && state.length > 1024) throw new AuthError('invalid_request', 'State too long');
      const transaction = randomBytes(24).toString('base64url');
      await this.store.save(
        'mb-txn:' + transaction,
        {
          clientId: one('client_id')!,
          redirectUri,
          challenge,
          state,
          createdAt: this.now(),
        } satisfies Transaction,
        TRANSACTION_TTL,
      );
      const cookie = await new SignJWT({ transaction })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuer(this.baseUrl)
        .setAudience('oauth-browser')
        .setIssuedAt()
        .setExpirationTime('10m')
        .sign(this.cookieKey);
      c.header(
        'Set-Cookie',
        `${COOKIE}=${cookie}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
      );
      return c.html(this.page(transaction, new URL(redirectUri).host));
    });

    app.post('/oauth/login', async (c) => {
      if (c.req.header('origin') !== this.baseUrl)
        throw new AuthError('invalid_request', 'Invalid form origin');
      const form = new URLSearchParams(await c.req.text());
      const transactionId = form.get('transaction_id');
      await this.cookieBinding(c.req.header('cookie'), transactionId);
      const txn = (await this.store.get('mb-txn:' + transactionId)) as Transaction | null;
      if (!txn) throw new AuthError('invalid_request', 'Sign-in expired; restart from your client');
      const redirectHost = new URL(txn.redirectUri).host;
      const retry = (message: string) =>
        c.html(this.page(transactionId!, redirectHost, message), 400);
      const parsed = email.safeParse(form.get('email')?.trim().toLowerCase());
      const password = form.get('password') ?? '';
      if (!parsed.success || !password || password.length > 4096)
        return retry('Enter the full email address and the mailbox password.');
      const address = parsed.data,
        domain = address.slice(address.lastIndexOf('@') + 1);
      if (!this.options.secrets.allowedDomains.includes(domain))
        return retry('This email domain is not allowed on this server.');
      // Attempts are counted before the provider is contacted: a shared egress IP must never be
      // locked out by one person's typos. Order: per mailbox, per client IP, then global.
      const sub = subjectFor(this.options.secrets.encryptionKey, address);
      const ip = (c.req.header('x-forwarded-for')?.split(',')[0] ?? 'unknown').trim().slice(0, 64);
      try {
        await rateLimit(this.options.db, sub, 'login', 5, 900);
        await rateLimit(this.options.db, 'ip:' + ip, 'login', 20, 3600);
        await rateLimit(this.options.db, 'public', 'login', 120, 3600);
      } catch {
        return retry('Too many sign-in attempts. Wait 15 minutes and try again.');
      }
      try {
        await this.verifyMailbox(accountFor(this.options.secrets, address, password));
      } catch {
        return retry('The mail server rejected this email address or password.');
      }
      const taken = (await this.store.take('mb-txn:' + transactionId)) as Transaction | null;
      if (!taken) throw new AuthError('invalid_request', 'Sign-in already completed');
      const existing = (await this.store.get('mb-user:' + sub)) as UserRecord | null;
      await this.store.save('mb-user:' + sub, {
        email: address,
        sealed: seal(this.options.secrets.encryptionKey, sub, password),
        createdAt: existing?.createdAt ?? this.now(),
        lastLoginAt: this.now(),
      } satisfies UserRecord);
      this.services.delete(sub);
      if (!existing) {
        const users = await this.listUsers();
        if (!users.some((u) => u.sub === sub))
          await this.store.save('mb-users', [...users, { sub, email: address }]);
      }
      const code = randomBytes(32).toString('base64url');
      await this.store.save(
        'mb-code:' + code,
        {
          sub,
          clientId: taken.clientId,
          redirectUri: taken.redirectUri,
          challenge: taken.challenge,
        },
        CODE_TTL,
      );
      const location = new URL(taken.redirectUri);
      location.searchParams.set('code', code);
      location.searchParams.set('iss', this.baseUrl);
      if (taken.state) location.searchParams.set('state', taken.state);
      c.header('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
      return c.redirect(location.toString(), 302);
    });

    app.post('/oauth/token', async (c) => {
      const params = new URLSearchParams(await c.req.text());
      const one = (k: string) => (params.getAll(k).length === 1 ? params.get(k) : null);
      const resources = params.getAll('resource');
      if (
        resources.length > 1 ||
        resources.some((r) => r !== this.baseUrl && r !== mcpResource(this.baseUrl))
      )
        throw new AuthError('invalid_target', 'Resource does not match this server');
      const clientId = one('client_id');
      if (!clientId || !(await this.client(clientId)))
        throw new AuthError('invalid_client', 'Unknown client', 401);
      const grant = one('grant_type');
      if (grant === 'authorization_code') {
        const code = one('code') ?? '',
          verifier = one('code_verifier') ?? '';
        const bound = (await this.store.take('mb-code:' + code)) as
          | (Grant & { redirectUri: string; challenge: string })
          | null;
        if (
          !bound ||
          bound.clientId !== clientId ||
          bound.redirectUri !== one('redirect_uri') ||
          !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) ||
          createHash('sha256').update(verifier).digest('base64url') !== bound.challenge
        )
          throw new AuthError('invalid_grant', 'Authorization code binding or PKCE mismatch');
        return c.json(await this.issueTokens(bound.sub, clientId));
      }
      if (grant === 'refresh_token') {
        const token = one('refresh_token') ?? '';
        if (token.length > 256) throw new AuthError('invalid_grant', 'Invalid refresh token');
        // Atomic take: a replayed refresh token loses the race and is rejected.
        const record = (await this.store.take('mb-refresh:' + token)) as Grant | null;
        if (!record || record.clientId !== clientId)
          throw new AuthError('invalid_grant', 'Refresh token is invalid, expired or rotated');
        if (!(await this.store.get('mb-user:' + record.sub)))
          throw new AuthError('invalid_grant', 'User no longer exists');
        return c.json(await this.issueTokens(record.sub, clientId));
      }
      throw new AuthError('unsupported_grant_type', 'Use authorization_code or refresh_token');
    });

    app.post('/oauth/revoke', async (c) => {
      const params = new URLSearchParams(await c.req.text());
      const token = params.get('token') ?? '';
      if (token.length <= 4096) {
        await this.store.delete('mb-refresh:' + token);
        try {
          const { payload } = await jwtVerify(token, this.signingKey, { algorithms: ['HS256'] });
          if (payload.jti) await this.store.delete('mb-access:' + payload.jti);
        } catch {}
      }
      return c.json({}, 200);
    });
  }
}
