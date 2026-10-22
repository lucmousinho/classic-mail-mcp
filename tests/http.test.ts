import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
const base = 'https://mail.example.com';
async function start(port: number, configured: boolean) {
  const env = {
    ...process.env,
    PORT: String(port),
    BASE_URL: base,
    AUTH_MODE: 'oauth',
    SQLITE_PATH: ':memory:',
  };
  const config = {
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
  };
  const child = spawn(process.execPath, ['dist/server.js'], {
    env: { ...env, APP_CONFIG_JSON: configured ? JSON.stringify(config) : '' },
    stdio: 'ignore',
  });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(url + '/status')).ok) return { child, url };
    } catch {}
    await delay(100);
  }
  child.kill();
  throw Error('Server failed to start');
}
test('unconfigured deployment locks mail access', async () => {
  const { child, url } = await start(18880, false);
  try {
    assert.equal((await (await fetch(url + '/status')).json()).mailAccess, 'locked');
    assert.equal((await fetch(url + '/mcp', { method: 'POST', body: '{}' })).status, 503);
  } finally {
    child.kill();
  }
});
test('OAuth discovery, unauthenticated rejection, PKCE, origin and body size checks', async () => {
  const { child, url } = await start(18890, true);
  try {
    // RFC 9728: the resource is the MCP endpoint URL users enter in Claude; the document is
    // served both at the root well-known path and at the path-suffixed one Claude probes first.
    for (const path of [
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/mcp',
    ]) {
      const resource = await (await fetch(url + path)).json();
      assert.equal(resource.resource, base + '/mcp', path);
      assert.deepEqual(resource.authorization_servers, [base]);
    }
    const auth = await (await fetch(url + '/.well-known/oauth-authorization-server')).json();
    assert.deepEqual(auth.code_challenge_methods_supported, ['S256']);
    assert.equal(auth.authorization_response_iss_parameter_supported, true);
    assert.equal(auth.registration_endpoint, base + '/oauth/register');
    assert.ok(auth.token_endpoint_auth_methods_supported.includes('none'));
    const res = await fetch(url + '/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'test', version: '1' },
        },
      }),
    });
    assert.equal(res.status, 401);
    assert.match(
      res.headers.get('www-authenticate') ?? '',
      /resource_metadata="https:\/\/mail\.example\.com\/\.well-known\/oauth-protected-resource\/mcp"/,
    );
    // Claude's origin passes the gateway Origin check; unknown origins do not.
    assert.notEqual(
      (await fetch(url + '/status', { headers: { Origin: 'https://claude.ai' } })).status,
      403,
    );
    const invalid = await fetch(url + '/mcp', {
      method: 'POST',
      headers: { Authorization: 'Bearer invalid' },
      body: '{}',
    });
    assert.equal(invalid.status, 401);
    assert.equal((await fetch(url + '/oauth/authorize?code_challenge_method=plain')).status, 400);
    assert.equal(
      (await fetch(url + '/oauth/token', { method: 'POST', body: 'resource=https://evil.example' }))
        .status,
      400,
    );
    assert.equal(
      (
        await fetch(url + '/oauth/token', {
          method: 'POST',
          headers: { Origin: 'https://evil.example' },
          body: '',
        })
      ).status,
      403,
    );
    assert.equal(
      (await fetch(url + '/oauth/token', { method: 'POST', body: 'x'.repeat(17000) })).status,
      413,
    );
  } finally {
    child.kill();
  }
});
test('mailbox mode: discovery, locked tools, sign-in page reachable through the public gateway', async () => {
  const config = {
    allowedDomains: ['mamboo.co.ao', 'mambootech.com'],
    provider: { imapHost: 'imap.dreamhost.com', smtpHost: 'smtp.dreamhost.com', smtpPort: 587 },
    displayName: 'Mamboo Mail',
    jwtSigningKey: 'j'.repeat(50),
    encryptionKey: 'e'.repeat(50),
    consentSigningKey: 'c'.repeat(50),
  };
  const child = spawn(process.execPath, ['dist/server.js'], {
    env: {
      ...process.env,
      PORT: '18900',
      BASE_URL: base,
      AUTH_MODE: 'mailbox',
      ACCESS_MODE: 'read-write',
      SQLITE_PATH: ':memory:',
      APP_CONFIG_JSON: JSON.stringify(config),
    },
    stdio: 'ignore',
  });
  const url = 'http://127.0.0.1:18900';
  try {
    let up = false;
    for (let i = 0; i < 80 && !up; i++) {
      try {
        up = (await fetch(url + '/status')).ok;
      } catch {}
      if (!up) await delay(100);
    }
    assert.ok(up, 'server started');
    const status = await (await fetch(url + '/status')).json();
    assert.equal(status.mailAccess, 'requires_oauth');
    assert.equal(status.accessMode, 'read-write');
    const auth = await (await fetch(url + '/.well-known/oauth-authorization-server')).json();
    assert.equal(auth.issuer, base);
    assert.equal(auth.registration_endpoint, base + '/oauth/register');
    assert.deepEqual(auth.token_endpoint_auth_methods_supported, ['none']);
    assert.deepEqual(auth.scopes_supported, ['mail']);
    const resource = await (await fetch(url + '/.well-known/oauth-protected-resource/mcp')).json();
    assert.equal(resource.resource, base + '/mcp');
    const res = await fetch(url + '/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: '{}',
    });
    assert.equal(res.status, 401);
    assert.match(res.headers.get('www-authenticate') ?? '', /oauth-protected-resource\/mcp/);
    const reg = await fetch(url + '/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] }),
    });
    assert.equal(reg.status, 201);
    const client = await reg.json();
    const page = await fetch(
      url +
        '/oauth/authorize?' +
        new URLSearchParams({
          client_id: client.client_id,
          redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
          response_type: 'code',
          code_challenge: 'a'.repeat(43),
          code_challenge_method: 'S256',
          resource: base + '/mcp',
        }),
    );
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Mamboo Mail/);
    assert.match(html, /claude\.ai/);
    // The only script is the button guard, allowed by hash; the gateway CSP is overridden for this page.
    const csp = page.headers.get('content-security-policy') ?? '';
    assert.match(csp, /default-src 'none'/);
    const hash = csp.match(/script-src 'sha256-([^']+)'/)?.[1];
    assert.ok(hash, 'page CSP carries a script hash');
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';
    assert.equal(createHash('sha256').update(script).digest('base64'), hash);
    assert.equal((html.match(/<script/g) ?? []).length, 1);
  } finally {
    child.kill();
  }
});
