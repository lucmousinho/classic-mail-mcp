import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { FastMCP } from 'fastmcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { MailboxAuth, accountFor, MAILBOX_SCOPES } from '../src/mailbox-auth.js';
import { mailboxSecretSchema, type Account } from '../src/config.js';
import { SqliteStore } from '../src/sqlite.js';
import { registerTools } from '../src/tools.js';
import { CLAUDE_CALLBACK, type Session } from '../src/auth.js';
import { seal, open, subjectFor } from '../src/sealed.js';

const base = 'https://mail.example.com';
const secrets = mailboxSecretSchema.parse({
  allowedDomains: ['mamboo.co.ao', 'mamboo.co.tz', 'mambootech.com'],
  provider: { imapHost: 'imap.dreamhost.com', smtpHost: 'smtp.dreamhost.com', smtpPort: 587 },
  displayName: 'Mamboo Mail',
  jwtSigningKey: 'j'.repeat(50),
  encryptionKey: 'e'.repeat(50),
  consentSigningKey: 'c'.repeat(50),
});
/** Synthetic provider: accepts one password per mailbox, records every attempt. */
function provider(passwords: Record<string, string>) {
  const attempts: string[] = [];
  return {
    attempts,
    verify: async (a: Account) => {
      attempts.push(a.username);
      if (passwords[a.username] !== a.password) throw new Error('AUTHENTICATIONFAILED');
    },
  };
}
function harness(
  verify: (a: Account) => Promise<void>,
  accessMode: 'read-only' | 'read-write' = 'read-write',
) {
  const db = new SqliteStore(':memory:');
  const auth = new MailboxAuth({ baseUrl: base, secrets, db, accessMode, verifyMailbox: verify });
  const server = new FastMCP<Session>({
    name: 'test',
    version: '1.0.0',
    authenticate: auth.authenticate(),
    oauth: {
      enabled: true,
      authorizationServer: auth.metadata(),
      protectedResource: auth.protectedResource(),
    },
    logger: { debug() {}, info() {}, warn() {}, error() {}, log() {} },
  });
  auth.routes(server);
  registerTools(server, (s) => auth.mailFor(s), db, {
    readOnly: accessMode === 'read-only',
    scopes: MAILBOX_SCOPES,
  });
  return { db, auth, server, app: server.getApp() };
}
/** Drives the browser part of the flow: register, authorize, sign in, exchange code. */
async function signIn(
  app: ReturnType<FastMCP<Session>['getApp']>,
  address: string,
  password: string,
  redirect = CLAUDE_CALLBACK,
) {
  const reg = await app.request(base + '/oauth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [redirect], token_endpoint_auth_method: 'none' }),
  });
  assert.equal(reg.status, 201);
  const client = await reg.json();
  assert.equal(client.token_endpoint_auth_method, 'none');
  const verifier = randomBytes(32).toString('base64url'),
    challenge = createHash('sha256').update(verifier).digest('base64url');
  const authorize = await app.request(
    base +
      '/oauth/authorize?' +
      new URLSearchParams({
        client_id: client.client_id,
        redirect_uri: redirect,
        response_type: 'code',
        scope: 'mail',
        resource: base + '/mcp',
        state: 'client-state',
        code_challenge: challenge,
        code_challenge_method: 'S256',
      }),
  );
  assert.equal(authorize.status, 200);
  const page = await authorize.text();
  assert.match(
    page,
    /returned to <strong class="host">claude\.ai<\/strong>|returned to <strong class="host">/,
  );
  assert.match(page, /Mamboo Mail/);
  const transaction = page.match(/name="transaction_id" value="([^"]+)"/)![1];
  const cookie = authorize.headers.get('set-cookie')!.split(';')[0];
  const login = (body: Record<string, string>, extra: RequestInit = {}) =>
    app.request(base + '/oauth/login', {
      method: 'POST',
      headers: {
        Origin: base,
        Cookie: cookie,
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(extra.headers as any),
      },
      body: new URLSearchParams({ transaction_id: transaction, ...body }).toString(),
    });
  const token = (body: Record<string, string>) =>
    app.request(base + '/oauth/token', {
      method: 'POST',
      body: new URLSearchParams(body).toString(),
    });
  return { client, verifier, challenge, transaction, cookie, login, token, redirect };
}
async function exchange(flow: Awaited<ReturnType<typeof signIn>>, response: Response) {
  assert.equal(response.status, 302, await response.text());
  const back = new URL(response.headers.get('location')!);
  assert.equal(back.origin + back.pathname, flow.redirect);
  assert.equal(back.searchParams.get('state'), 'client-state');
  assert.equal(back.searchParams.get('iss'), base);
  const res = await flow.token({
    client_id: flow.client.client_id,
    grant_type: 'authorization_code',
    code: back.searchParams.get('code')!,
    redirect_uri: flow.redirect,
    code_verifier: flow.verifier,
    resource: base + '/mcp',
  });
  assert.equal(res.status, 200, await res.clone().text());
  return { tokens: await res.json(), code: back.searchParams.get('code')! };
}

test('sealed credentials: bound to one subject, unreadable with another key or subject', () => {
  const sub = subjectFor('e'.repeat(50), 'A@Mamboo.co.ao ');
  assert.equal(sub, subjectFor('e'.repeat(50), 'a@mamboo.co.ao'));
  assert.match(sub, /^[0-9a-f]{32}$/);
  const sealed = seal('e'.repeat(50), sub, 'hunter2');
  assert.equal(open('e'.repeat(50), sub, sealed), 'hunter2');
  assert.throws(() => open('e'.repeat(50), 'other-subject', sealed));
  assert.throws(() => open('x'.repeat(50), sub, sealed));
  assert.notEqual(seal('e'.repeat(50), sub, 'hunter2'), sealed, 'fresh IV per seal');
});

test('accountFor yields a single provider-shaped account named after the mailbox', () => {
  const a = accountFor(secrets, 'Joao.Silva@mamboo.co.ao', 'pw');
  assert.equal(a.id, 'joao-silva');
  assert.equal(a.username, 'Joao.Silva@mamboo.co.ao');
  assert.equal(a.imapHost, 'imap.dreamhost.com');
  assert.equal(a.smtpPort, 587);
  assert.equal(accountFor(secrets, '---@mamboo.co.ao', 'pw').id, 'mailbox');
});

test('metadata advertises a public-client, PKCE-only authorization server and the /mcp resource', () => {
  const { auth } = harness(async () => {});
  const m = auth.metadata();
  assert.equal(m.issuer, base);
  assert.deepEqual(m.tokenEndpointAuthMethodsSupported, ['none']);
  assert.deepEqual(m.codeChallengeMethodsSupported, ['S256']);
  assert.equal(m.registrationEndpoint, base + '/oauth/register');
  assert.equal(auth.protectedResource().resource, base + '/mcp');
});

test('full mailbox sign-in: domain allowlist, provider check, sealed storage, PKCE, one-use code, rotation', async () => {
  const p = provider({ 'ana@mamboo.co.ao': 'ana-pass' });
  const { app, auth, db } = harness(p.verify);
  const flow = await signIn(app, 'ana@mamboo.co.ao', 'ana-pass');

  // Wrong origin, missing cookie and foreign domain never reach the provider.
  assert.equal(
    (await app.request(base + '/oauth/login', { method: 'POST', body: '' })).status,
    400,
  );
  assert.equal(
    (
      await app.request(base + '/oauth/login', {
        method: 'POST',
        headers: { Origin: base, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          transaction_id: flow.transaction,
          email: 'ana@mamboo.co.ao',
          password: 'x',
        }).toString(),
      })
    ).status,
    400,
    'cookie binding required',
  );
  const foreign = await flow.login({ email: 'ana@example.org', password: 'ana-pass' });
  assert.equal(foreign.status, 400);
  assert.match(await foreign.text(), /domain is not allowed/);
  assert.deepEqual(p.attempts, [], 'provider untouched so far');

  const wrong = await flow.login({ email: 'ana@mamboo.co.ao', password: 'nope' });
  assert.equal(wrong.status, 400);
  assert.match(await wrong.text(), /rejected this email address or password/);
  assert.equal(p.attempts.length, 1);

  const { tokens, code } = await exchange(
    flow,
    await flow.login({ email: 'Ana@Mamboo.co.ao', password: 'ana-pass' }),
  );
  assert.equal(p.attempts.length, 2);
  assert.equal(tokens.token_type, 'Bearer');
  assert.equal(tokens.scope, 'mail');

  // The code is one-use; a replay fails even with the right verifier.
  const replay = await flow.token({
    client_id: flow.client.client_id,
    grant_type: 'authorization_code',
    code,
    redirect_uri: flow.redirect,
    code_verifier: flow.verifier,
  });
  assert.equal(replay.status, 400);
  assert.equal((await replay.json()).error, 'invalid_grant');

  // Stored record: sealed, decryptable only for that subject, password never in clear.
  const sub = subjectFor(secrets.encryptionKey, 'ana@mamboo.co.ao');
  const rows = db.db.prepare('SELECT value FROM oauth').all() as { value: string }[];
  assert.ok(
    rows.every((r) => !r.value.includes('ana-pass')),
    'no plaintext password at rest',
  );
  assert.deepEqual(await auth.listUsers(), [{ sub, email: 'ana@mamboo.co.ao' }]);

  // Access token authenticates; refresh token does not; session is the signed-in mailbox.
  const authenticate = auth.authenticate();
  assert.deepEqual(
    await authenticate({ headers: { authorization: 'Bearer ' + tokens.access_token } } as any),
    {
      email: 'ana@mamboo.co.ao',
      sub,
    },
  );
  assert.equal(
    await authenticate({ headers: { authorization: 'Bearer ' + tokens.refresh_token } } as any),
    undefined,
  );
  assert.equal(await authenticate({ headers: { authorization: 'Bearer nope' } } as any), undefined);

  // Refresh rotation: the old refresh token dies with the first use.
  const refreshed = await flow.token({
    client_id: flow.client.client_id,
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
  });
  assert.equal(refreshed.status, 200);
  const next = await refreshed.json();
  assert.notEqual(next.refresh_token, tokens.refresh_token);
  const reused = await flow.token({
    client_id: flow.client.client_id,
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
  });
  assert.equal(reused.status, 400);
  assert.equal((await reused.json()).error, 'invalid_grant');
  // Another client cannot use this refresh token.
  const other = await signIn(app, 'ana@mamboo.co.ao', 'ana-pass');
  const stolen = await other.token({
    client_id: other.client.client_id,
    grant_type: 'refresh_token',
    refresh_token: next.refresh_token,
  });
  assert.equal(stolen.status, 400);

  // Revocation and removal.
  await app.request(base + '/oauth/revoke', {
    method: 'POST',
    body: new URLSearchParams({ token: next.access_token }).toString(),
  });
  assert.equal(
    await authenticate({ headers: { authorization: 'Bearer ' + next.access_token } } as any),
    undefined,
  );
  const fresh = await signIn(app, 'ana@mamboo.co.ao', 'ana-pass');
  const again = (
    await exchange(fresh, await fresh.login({ email: 'ana@mamboo.co.ao', password: 'ana-pass' }))
  ).tokens;
  assert.ok(
    await authenticate({ headers: { authorization: 'Bearer ' + again.access_token } } as any),
  );
  await auth.removeUser('ana@mamboo.co.ao');
  assert.equal(
    await authenticate({ headers: { authorization: 'Bearer ' + again.access_token } } as any),
    undefined,
    'removal revokes immediately',
  );
  assert.deepEqual(await auth.listUsers(), []);
});

test('sign-in attempts are throttled per mailbox before the provider is contacted', async () => {
  const p = provider({ 'bob@mambootech.com': 'right' });
  const { app } = harness(p.verify);
  const flow = await signIn(app, 'bob@mambootech.com', 'right');
  for (let i = 0; i < 5; i++) await flow.login({ email: 'bob@mambootech.com', password: 'wrong' });
  assert.equal(p.attempts.length, 5);
  const locked = await flow.login({ email: 'bob@mambootech.com', password: 'right' });
  assert.equal(locked.status, 400);
  assert.match(await locked.text(), /Too many sign-in attempts/);
  assert.equal(p.attempts.length, 5, 'sixth attempt never reaches the provider');
  // Another mailbox from the same client IP still gets in.
  const other = await signIn(app, 'carla@mambootech.com', 'x');
  const okay = await other.login({ email: 'carla@mambootech.com', password: 'whatever' });
  assert.equal(p.attempts.length, 6);
  assert.equal(okay.status, 400, 'carla has no password configured in the synthetic provider');
});

test('a double-clicked sign-in is one provider attempt and every duplicate gets the same redirect', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const attempts: string[] = [];
  const { app, auth } = harness(async (a) => {
    attempts.push(a.username);
    await gate; // hold the provider so the duplicates really overlap
  });
  const flow = await signIn(app, 'dora@mamboo.co.ao', 'pw');
  const clicks = Promise.all(
    Array.from({ length: 4 }, () => flow.login({ email: 'dora@mamboo.co.ao', password: 'pw' })),
  );
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(attempts.length, 1, 'provider contacted once while four POSTs are in flight');
  release();
  const responses = await clicks;
  const locations = responses.map((r) => r.headers.get('location'));
  assert.ok(
    responses.every((r) => r.status === 302),
    'all duplicates redirect',
  );
  assert.equal(new Set(locations).size, 1, 'all carry the same authorization code');
  assert.equal(attempts.length, 1);
  const { tokens } = await exchange(flow, responses[0]!);
  assert.ok(tokens.access_token);
  // The duplicates consumed one rate-limit tick: four more sign-ins pass, the sixth is throttled.
  for (let i = 0; i < 4; i++) {
    const again = await signIn(app, 'dora@mamboo.co.ao', 'pw');
    assert.equal((await again.login({ email: 'dora@mamboo.co.ao', password: 'pw' })).status, 302);
  }
  const sixth = await signIn(app, 'dora@mamboo.co.ao', 'pw');
  const throttled = await sixth.login({ email: 'dora@mamboo.co.ao', password: 'pw' });
  assert.equal(throttled.status, 400);
  assert.match(await throttled.text(), /Too many sign-in attempts/);
  assert.equal(attempts.length, 5);
  assert.deepEqual(await auth.listUsers(), [
    { sub: subjectFor(secrets.encryptionKey, 'dora@mamboo.co.ao'), email: 'dora@mamboo.co.ao' },
  ]);
});

test('authorize rejects unknown clients, unregistered redirects, weak PKCE and foreign resources', async () => {
  const { app } = harness(async () => {});
  const reg = await app.request(base + '/oauth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [CLAUDE_CALLBACK] }),
  });
  const client = await reg.json();
  const good = {
    client_id: client.client_id,
    redirect_uri: CLAUDE_CALLBACK,
    response_type: 'code',
    code_challenge: 'a'.repeat(43),
    code_challenge_method: 'S256',
  };
  const status = async (overrides: Record<string, string>) =>
    (await app.request(base + '/oauth/authorize?' + new URLSearchParams({ ...good, ...overrides })))
      .status;
  assert.equal(await status({}), 200);
  assert.equal(await status({ client_id: 'mb_unknown' }), 401);
  assert.equal(
    await status({ redirect_uri: 'http://127.0.0.1:4444/callback' }),
    400,
    'allowed shape but not registered for this client',
  );
  assert.equal(await status({ code_challenge_method: 'plain' }), 400);
  assert.equal(await status({ resource: 'https://evil.example/mcp' }), 400);
  assert.equal(await status({ scope: 'openid' }), 400);
  const confidential = await app.request(base + '/oauth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      redirect_uris: [CLAUDE_CALLBACK],
      token_endpoint_auth_method: 'client_secret_post',
    }),
  });
  assert.equal(confidential.status, 400);
  const evil = await app.request(base + '/oauth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect_uris: ['https://evil.example/callback'] }),
  });
  assert.equal(evil.status, 400);
});

test('two people on one server see only their own mailbox; message IDs and send ledgers never cross', async () => {
  const p = provider({ 'ana@mamboo.co.ao': 'ana-pass', 'tomas@mamboo.co.tz': 'tomas-pass' });
  const { app, auth, server, db } = harness(p.verify);
  const anaFlow = await signIn(app, 'ana@mamboo.co.ao', 'ana-pass');
  const ana = (
    await exchange(
      anaFlow,
      await anaFlow.login({ email: 'ana@mamboo.co.ao', password: 'ana-pass' }),
    )
  ).tokens;
  const tomasFlow = await signIn(app, 'tomas@mamboo.co.tz', 'tomas-pass');
  const tomas = (
    await exchange(
      tomasFlow,
      await tomasFlow.login({ email: 'tomas@mamboo.co.tz', password: 'tomas-pass' }),
    )
  ).tokens;
  assert.notEqual(ana.access_token, tomas.access_token);

  // Service resolution is per subject and the two accounts carry each person's own credential.
  const anaSession = {
    email: 'ana@mamboo.co.ao',
    sub: subjectFor(secrets.encryptionKey, 'ana@mamboo.co.ao'),
  };
  const tomasSession = {
    email: 'tomas@mamboo.co.tz',
    sub: subjectFor(secrets.encryptionKey, 'tomas@mamboo.co.tz'),
  };
  const anaMail = await auth.mailFor(anaSession),
    tomasMail = await auth.mailFor(tomasSession);
  assert.notEqual(anaMail, tomasMail);
  assert.deepEqual(
    anaMail.listAccounts().map((a) => a.email),
    ['ana@mamboo.co.ao'],
  );
  assert.deepEqual(
    tomasMail.listAccounts().map((a) => a.email),
    ['tomas@mamboo.co.tz'],
  );
  assert.equal(await auth.mailFor(anaSession), anaMail, 'cached per subject');

  // Over MCP: each bearer token lists exactly one account, its own.
  await server.start({
    transportType: 'httpStream',
    httpStream: {
      host: '127.0.0.1',
      port: 18931,
      endpoint: '/mcp',
      stateless: true,
      enableJsonResponse: true,
      cors: false,
    },
  });
  try {
    for (const [token, email, id] of [
      [ana.access_token, 'ana@mamboo.co.ao', 'ana'],
      [tomas.access_token, 'tomas@mamboo.co.tz', 'tomas'],
    ] as const) {
      const sdk = new Client({ name: 'isolation', version: '1.0.0' });
      await sdk.connect(
        new StreamableHTTPClientTransport(new URL('http://127.0.0.1:18931/mcp'), {
          requestInit: { headers: { Authorization: 'Bearer ' + token } },
        }),
      );
      assert.equal((await sdk.listTools()).tools.length, 21);
      const accounts = await sdk.callTool({ name: 'list_accounts', arguments: {} });
      const text = (accounts.content as { text: string }[])[0]!.text;
      assert.deepEqual(
        JSON.parse(text).map((a: { email: string; id: string }) => [a.id, a.email]),
        [[id, email]],
      );
      // A call naming the other person's account ID fails inside this person's own service.
      const foreign = await sdk.callTool({
        name: 'list_folders',
        arguments: { account: id === 'ana' ? 'tomas' : 'ana' },
      });
      assert.equal(foreign.isError, true);
      assert.match((foreign.content as { text: string }[])[0]!.text, /Unknown account/);
      await sdk.close();
    }
    const anon = await fetch('http://127.0.0.1:18931/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: '{}',
    });
    assert.equal(anon.status, 401);
    assert.match(anon.headers.get('www-authenticate') ?? '', /oauth-protected-resource\/mcp/);
  } finally {
    await server.stop();
  }

  // Send ledger keys are prefixed with the subject: the same idempotency key is independent per person.
  const ledgerRows = () =>
    (db.db.prepare('SELECT key FROM sends').all() as { key: string }[]).length;
  const anaLedger = (anaMail as any).ledger,
    tomasLedger = (tomasMail as any).ledger;
  assert.equal((await anaLedger.claim('ana:same-key', 'h1')).fresh, true);
  assert.equal((await tomasLedger.claim('tomas:same-key', 'h1')).fresh, true);
  assert.equal((await anaLedger.claim('ana:same-key', 'h1')).fresh, false, 'own replay detected');
  assert.equal(ledgerRows(), 2);
});

test('read-only mode exposes six tools and still shows the limited permissions on the sign-in page', async () => {
  const p = provider({ 'ana@mamboo.co.ao': 'ana-pass' });
  const { app, server } = harness(p.verify, 'read-only');
  const flow = await signIn(app, 'ana@mamboo.co.ao', 'ana-pass');
  const authorizePage = await (
    await app.request(
      base +
        '/oauth/authorize?' +
        new URLSearchParams({
          client_id: flow.client.client_id,
          redirect_uri: CLAUDE_CALLBACK,
          response_type: 'code',
          code_challenge: flow.challenge,
          code_challenge_method: 'S256',
        }),
    )
  ).text();
  assert.match(authorizePage, /sending and deleting are disabled/);
  const { tokens } = await exchange(
    flow,
    await flow.login({ email: 'ana@mamboo.co.ao', password: 'ana-pass' }),
  );
  await server.start({
    transportType: 'httpStream',
    httpStream: {
      host: '127.0.0.1',
      port: 18932,
      endpoint: '/mcp',
      stateless: true,
      enableJsonResponse: true,
      cors: false,
    },
  });
  try {
    const sdk = new Client({ name: 'ro', version: '1.0.0' });
    await sdk.connect(
      new StreamableHTTPClientTransport(new URL('http://127.0.0.1:18932/mcp'), {
        requestInit: { headers: { Authorization: 'Bearer ' + tokens.access_token } },
      }),
    );
    assert.equal((await sdk.listTools()).tools.length, 6);
    await sdk.close();
  } finally {
    await server.stop();
  }
});
