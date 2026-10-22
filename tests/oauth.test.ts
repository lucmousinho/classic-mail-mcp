import { SignJWT } from 'jose';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { FastMCP } from 'fastmcp';
import {
  authRoutes,
  createProxy,
  authenticate,
  CHATGPT_CALLBACK,
  CLAUDE_CALLBACK,
  isAllowedCallback,
  mcpResource,
  validateOAuthRequest,
  type Session,
} from '../src/auth.js';
import { secretSchema } from '../src/config.js';
import { SqliteStore } from '../src/sqlite.js';
import { FirestoreTokenStore } from '../src/store.js';
import { registerTools } from '../src/tools.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/** Serialized transaction emulator: isolates application logic without real cloud writes. */
function memoryDb() {
  const rows = new Map<string, any>();
  let serial = Promise.resolve();
  const doc = (id: string) => ({
    id,
    async get() {
      const value = rows.get(id);
      return { exists: rows.has(id), data: () => value };
    },
    async set(v: any) {
      rows.set(id, v);
    },
    async delete() {
      rows.delete(id);
    },
  });
  const db = {
    collection: (c: string) => ({ doc: (id: string) => doc(c + '/' + id) }),
    runTransaction(fn: any) {
      const result = serial.then(() =>
        fn({
          get: (ref: any) => ref.get(),
          delete: (ref: any) => rows.delete(ref.id),
          set: (ref: any, v: any) => rows.set(ref.id, v),
        }),
      );
      serial = result.catch(() => {});
      return result;
    },
  };
  return { db: db as any, rows };
}
test('native callback allowlist rejects remote hosts, URL ambiguity and duplicate redirects', () => {
  for (const uri of [
    CLAUDE_CALLBACK,
    CHATGPT_CALLBACK,
    'http://127.0.0.1:32123/callback',
    'http://localhost:65535/callback/native_123',
    // Claude Code: RFC 8252 loopback on an ephemeral port
    'http://localhost:3118/callback',
  ])
    assert.equal(isAllowedCallback(uri), true, uri);
  for (const uri of [
    'https://evil.example/callback',
    'https://claude.ai/api/mcp/auth_callback/',
    'https://claude.ai.evil.example/api/mcp/auth_callback',
    'http://claude.ai/api/mcp/auth_callback',
    'https://claude.ai/api/mcp/auth_callback?next=https://evil.example',
    'http://127.0.0.1.evil.example:32123/callback',
    'http://localhost:32123@example.org/callback',
    'http://user@localhost:32123/callback',
    'http://127.0.0.1:0/callback',
    'http://127.0.0.1:65536/callback',
    'http://127.0.0.1/callback',
    'http://127.0.0.1:32123/callback?next=https://evil.example',
    'http://127.0.0.1:32123/callback#fragment',
    'http://127.0.0.1:32123/callback/../other',
    'http://127.0.0.1:32123/callback/%2fother',
    'http://127.0.0.1:32123/other',
    'http://2130706433:32123/callback',
    'http://[::1]:32123/callback',
  ])
    assert.equal(isAllowedCallback(uri), false, uri);
  const params = new URLSearchParams({
    redirect_uri: CHATGPT_CALLBACK,
    code_challenge: 'a'.repeat(43),
    code_challenge_method: 'S256',
  });
  params.append('redirect_uri', 'https://evil.example/callback');
  assert.throws(() => validateOAuthRequest(params, 'https://mail.example.com', true));
});
test('resource indicator accepts the origin and the advertised /mcp endpoint only', () => {
  const base = 'https://mail.example.com';
  const ok = (resource: string) =>
    validateOAuthRequest(
      new URLSearchParams({
        redirect_uri: CLAUDE_CALLBACK,
        code_challenge: 'a'.repeat(43),
        code_challenge_method: 'S256',
        resource,
      }),
      base,
      true,
    );
  assert.equal(mcpResource(base), base + '/mcp');
  assert.doesNotThrow(() => ok(base));
  assert.doesNotThrow(() => ok(base + '/mcp'));
  for (const bad of [
    base + '/mcp/',
    base + '/other',
    'https://evil.example/mcp',
    'http://mail.example.com/mcp',
  ])
    assert.throws(() => ok(bad), bad);
});
test('persistent OAuth store atomic take allows exactly one reader and enforces TTL', async () => {
  const { db } = memoryDb(),
    store = new FirestoreTokenStore(db);
  await store.save('code', { value: 'test' }, 30);
  const taken = await Promise.all(Array.from({ length: 10 }, () => store.take('code')));
  assert.equal(taken.filter(Boolean).length, 1);
  await store.save('expired', { secret: true }, -1);
  assert.equal(await store.get('expired'), null);
});
for (const backend of ['firestore', 'sqlite'])
  for (const redirect of [
    CLAUDE_CALLBACK,
    CHATGPT_CALLBACK,
    'http://127.0.0.1:32123/callback',
    'http://localhost:32124/callback/native-client',
  ])
    test(`full simulated OAuth flow (${backend}, ${redirect}): consent binding, encrypted storage, PKCE, one-use codes, token rotation`, async () => {
      const base = 'https://mail.example.com';
      const memory = memoryDb();
      const db = backend === 'sqlite' ? new SqliteStore(':memory:') : memory.db;
      const rows = {
        values: () =>
          db instanceof SqliteStore
            ? db.db.prepare('SELECT value FROM oauth').all()
            : memory.rows.values(),
      };
      const secrets = secretSchema.parse({
        googleClientId: 'test.apps.googleusercontent.com',
        googleClientSecret: 'test-only-secret',
        allowedEmails: ['owner@example.com'],
        jwtSigningKey: 'a'.repeat(50),
        encryptionKey: 'b'.repeat(50),
        consentSigningKey: 'c'.repeat(50),
        accounts: [
          {
            id: 'test',
            email: 'sender@example.com',
            username: 'sender@example.com',
            password: 'test-only',
            imapHost: 'imap.example.com',
            smtpHost: 'smtp.example.com',
            allowedFolders: ['INBOX'],
          },
        ],
      });
      const proxy = createProxy(base, secrets, db),
        server = new FastMCP<Session>({
          name: 'test',
          version: '1.0.0',
          authenticate: authenticate(proxy, secrets, db, base),
          logger: { debug() {}, info() {}, warn() {}, error() {}, log() {} },
        });
      registerTools(server, {
        listAccounts: () => [{ id: 'test', email: 'sender@example.com' }],
      } as any);
      authRoutes(server, proxy, base, db, secrets.consentSigningKey);
      const app = server.getApp();
      let googleChallenge: string | null = null;
      const realFetch = globalThis.fetch;
      // Claude presents the RFC 9728 resource (the /mcp endpoint); older clients present the origin.
      const resource = redirect === CLAUDE_CALLBACK ? mcpResource(base) : base;
      const grantedScope =
        redirect === CHATGPT_CALLBACK
          ? 'openid email'
          : 'openid https://www.googleapis.com/auth/userinfo.email';
      const fetchMock = mock.method(globalThis, 'fetch', async (input: any, init?: RequestInit) => {
        if (String(input) === 'https://openidconnect.googleapis.com/v1/userinfo')
          return new Response(
            JSON.stringify({ email: 'owner@example.com', email_verified: true, sub: 'owner' }),
            { headers: { 'Content-Type': 'application/json' } },
          );
        assert.equal(String(input), 'https://oauth2.googleapis.com/token');
        const posted = new URLSearchParams(String(init?.body));
        if (posted.get('grant_type') === 'authorization_code') {
          assert.ok(
            googleChallenge,
            'Google authorization must include a PKCE challenge before sending a verifier',
          );
          assert.equal(
            createHash('sha256')
              .update(posted.get('code_verifier') ?? '')
              .digest('base64url'),
            googleChallenge,
          );
          assert.equal(posted.get('client_id'), secrets.googleClientId);
          assert.equal(posted.get('client_secret'), secrets.googleClientSecret);
        }
        return new Response(
          JSON.stringify({
            access_token: 'synthetic-upstream-secret',
            refresh_token: 'synthetic-refresh-secret',
            token_type: 'Bearer',
            expires_in: 3600,
            scope: grantedScope,
          }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      });
      try {
        const reg = await app.request(base + '/oauth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ redirect_uris: [redirect], token_endpoint_auth_method: 'none' }),
        });
        assert.equal(reg.status, 201);
        const client = await reg.json();
        const bad = await app.request(base + '/oauth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ redirect_uris: ['https://evil.example/callback'] }),
        });
        assert.equal(bad.status, 400);
        const verifier = randomBytes(32).toString('base64url'),
          challenge = createHash('sha256').update(verifier).digest('base64url');
        const authParams = new URLSearchParams({
          client_id: client.client_id,
          redirect_uri: redirect,
          response_type: 'code',
          scope: 'openid email',
          resource,
          state: 'client-state',
          code_challenge: challenge,
          code_challenge_method: 'S256',
        });
        const consent = await app.request(base + '/oauth/authorize?' + authParams);
        assert.equal(consent.status, 200);
        const body = await consent.text();
        assert.match(body, /send replies/);
        assert.match(body, /delete messages/);
        assert.match(
          body,
          new RegExp('returned to <strong>' + new URL(redirect).host.replace('.', '\\.')),
        );
        if (
          new URL(redirect).hostname !== 'claude.ai' &&
          new URL(redirect).hostname !== 'chatgpt.com'
        )
          assert.match(body, /local program on this computer/);
        assert.equal(consent.headers.get('referrer-policy'), 'same-origin');
        const transaction = body.match(/name="transaction_id" value="([^"]+)"/)![1];
        const cookie = consent.headers.get('set-cookie')!.split(';')[0];
        const form = new URLSearchParams({
          transaction_id: transaction,
          action: 'approve',
        }).toString();
        const missingCookie = await app.request(base + '/oauth/consent', {
          method: 'POST',
          headers: { Origin: base, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: form,
        });
        assert.equal(missingCookie.status, 400);
        const approved = await app.request(base + '/oauth/consent', {
          method: 'POST',
          headers: {
            Origin: base,
            Cookie: cookie,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: form,
        });
        assert.equal(approved.status, 302);
        const google = new URL(approved.headers.get('location')!);
        assert.equal(google.searchParams.get('access_type'), 'offline');
        googleChallenge = google.searchParams.get('code_challenge');
        assert.equal(google.searchParams.get('code_challenge_method'), 'S256');
        assert.match(googleChallenge ?? '', /^[A-Za-z0-9_-]{43}$/);
        assert.notEqual(googleChallenge, challenge, 'Proxy uses independent PKCE for Google');
        const callback =
          base +
          '/oauth/callback?' +
          new URLSearchParams({
            code: 'synthetic-google-code',
            state: google.searchParams.get('state')!,
          });
        assert.equal((await app.request(callback)).status, 400);
        const response = await app.request(callback, { headers: { Cookie: cookie } });
        assert.equal(response.status, 302);
        const back = new URL(response.headers.get('location')!);
        assert.equal(back.origin + back.pathname, redirect);
        assert.equal(back.searchParams.get('state'), 'client-state');
        assert.equal(back.searchParams.get('iss'), base);
        const exchange = new URLSearchParams({
          client_id: client.client_id,
          grant_type: 'authorization_code',
          code: back.searchParams.get('code')!,
          redirect_uri: redirect,
          code_verifier: verifier,
          resource,
        });
        const wrongRedirect = new URLSearchParams(exchange);
        wrongRedirect.set('redirect_uri', 'http://127.0.0.1:32125/callback');
        assert.equal(
          (
            await app.request(base + '/oauth/token', {
              method: 'POST',
              body: wrongRedirect.toString(),
            })
          ).status,
          400,
        );
        const wrongVerifier = new URLSearchParams(exchange);
        wrongVerifier.set('code_verifier', randomBytes(32).toString('base64url'));
        assert.equal(
          (
            await app.request(base + '/oauth/token', {
              method: 'POST',
              body: wrongVerifier.toString(),
            })
          ).status,
          400,
        );
        const tokensResponse = await app.request(base + '/oauth/token', {
          method: 'POST',
          body: exchange.toString(),
        });
        assert.equal(tokensResponse.status, 200);
        const tokens = await tokensResponse.json();
        assert.ok(tokens.access_token);
        assert.ok(tokens.refresh_token);
        assert.notEqual(tokens.access_token, 'synthetic-upstream-secret');
        assert.deepEqual(
          await authenticate(
            proxy,
            secrets,
            db,
            base,
          )({ headers: { authorization: 'Bearer ' + tokens.access_token } } as any),
          { email: 'owner@example.com', sub: 'owner' },
          'Actual proxy-issued access token must authorize MCP discovery',
        );
        assert.equal(
          await authenticate(
            proxy,
            secrets,
            db,
            base,
          )({ headers: { authorization: 'Bearer ' + tokens.refresh_token } } as any),
          undefined,
          'Refresh token is never an MCP access token',
        );
        const clientSdk = new Client({ name: 'oauth-discovery-regression', version: '1.0.0' });
        try {
          await server.start({
            transportType: 'httpStream',
            httpStream: {
              host: '127.0.0.1',
              port: 18921,
              endpoint: '/mcp',
              stateless: true,
              enableJsonResponse: true,
              cors: false,
            },
          });
          await clientSdk.connect(
            new StreamableHTTPClientTransport(new URL('http://127.0.0.1:18921/mcp'), {
              fetch: realFetch,
              requestInit: { headers: { Authorization: 'Bearer ' + tokens.access_token } },
            }),
          );
          assert.equal((await clientSdk.listTools()).tools.length, 21);
          const accounts = await clientSdk.callTool({ name: 'list_accounts', arguments: {} });
          assert.notEqual(accounts.isError, true);
          assert.match(JSON.stringify(accounts), /sender@example.com/);
        } finally {
          await clientSdk.close();
          await server.stop();
        }
        assert.equal(
          (await proxy.loadUpstreamTokens(tokens.access_token))?.accessToken,
          'synthetic-upstream-secret',
        );
        assert.ok(!JSON.stringify([...rows.values()]).includes('synthetic-upstream-secret'));
        const replay = await app.request(base + '/oauth/token', {
          method: 'POST',
          body: exchange.toString(),
        });
        assert.equal(replay.status, 400);
        const refresh = new URLSearchParams({
          client_id: client.client_id,
          grant_type: 'refresh_token',
          refresh_token: tokens.refresh_token,
          resource: base,
        });
        const wrongClient = new URLSearchParams(refresh);
        wrongClient.set('client_id', 'wrong-client');
        assert.equal(
          (
            await app.request(base + '/oauth/token', {
              method: 'POST',
              body: wrongClient.toString(),
            })
          ).status,
          400,
        );
        const wrongKind = new URLSearchParams(refresh);
        wrongKind.set('refresh_token', tokens.access_token);
        assert.equal(
          (await app.request(base + '/oauth/token', { method: 'POST', body: wrongKind.toString() }))
            .status,
          400,
        );
        const rotated = await app.request(base + '/oauth/token', {
          method: 'POST',
          body: refresh.toString(),
        });
        assert.equal(rotated.status, 200);
        assert.notEqual((await rotated.json()).refresh_token, tokens.refresh_token);
        assert.equal(
          (await app.request(base + '/oauth/token', { method: 'POST', body: refresh.toString() }))
            .status,
          400,
        );
      } finally {
        fetchMock.mock.restore();
        proxy.destroy();
        if (db instanceof SqliteStore) await db.terminate();
      }
    });

test('MCP bearer verification enforces signature, issuer, audience, expiry and identity scopes before upstream access', async () => {
  const base = 'https://mail.example.com',
    { db } = memoryDb();
  const secrets = secretSchema.parse({
    googleClientId: 'test.apps.googleusercontent.com',
    googleClientSecret: 'synthetic-only-secret',
    allowedEmails: ['owner@example.com'],
    jwtSigningKey: 'a'.repeat(50),
    encryptionKey: 'b'.repeat(50),
    consentSigningKey: 'c'.repeat(50),
    accounts: [
      {
        id: 'test',
        email: 'sender@example.com',
        username: 'sender@example.com',
        password: 'synthetic-only',
        imapHost: 'imap.example.com',
        smtpHost: 'smtp.example.com',
        allowedFolders: ['INBOX'],
      },
    ],
  });
  let upstream = 0;
  const proxy = {
    async loadUpstreamTokens() {
      upstream++;
      return { accessToken: 'synthetic-upstream-only' };
    },
  };
  const auth = authenticate(proxy as any, secrets, db, base),
    now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: base,
    aud: base,
    iat: now,
    exp: now + 300,
    jti: 'synthetic-id',
    scope: 'openid email',
  };
  const sign = (changes: any = {}, key = secrets.jwtSigningKey) =>
    new SignJWT({ ...claims, ...changes })
      .setProtectedHeader({ alg: 'HS256' })
      .sign(new TextEncoder().encode(key));
  const fetchMock = mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        JSON.stringify({ email: 'owner@example.com', email_verified: true, sub: 'owner' }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
  );
  try {
    for (const changes of [
      { aud: 'https://evil.example' },
      { iss: 'https://evil.example' },
      { exp: now - 1 },
      { scope: 'openid' },
      { scope: ['openid'] },
      { scope: ['openid', 42, 'email'] },
      { scope: ['openid', 'https://evil.example/userinfo.email'] },
      { scope: { openid: true, email: true } },
      { jti: undefined },
    ]) {
      assert.equal(
        await auth({ headers: { authorization: 'Bearer ' + (await sign(changes)) } } as any),
        undefined,
      );
    }
    assert.equal(
      await auth({ headers: { authorization: 'Bearer ' + (await sign({}, 'wrong-key')) } } as any),
      undefined,
    );
    assert.equal(upstream, 0);
    await new FirestoreTokenStore(db).save(
      'issued-access:' + (await sign()),
      { clientId: 'synthetic' },
      300,
    );
    assert.deepEqual(
      await auth({ headers: { authorization: 'Bearer ' + (await sign()) } } as any),
      { email: 'owner@example.com', sub: 'owner' },
    );
    assert.equal(upstream, 1);
  } finally {
    fetchMock.mock.restore();
  }
});
