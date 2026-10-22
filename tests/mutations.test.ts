import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { simpleParser } from 'mailparser';
import { accountSchema, secretSchema } from '../src/config.js';
import {
  MailService,
  composeSchema,
  decodeRef,
  encodeRef,
  imapOptions,
  smtpOptions,
} from '../src/mail.js';
import { allowIdentity, validateOAuthRequest } from '../src/auth.js';
import type { SendLedger } from '../src/store.js';

const account = accountSchema.parse({
  id: 'test',
  email: 'sender@example.com',
  username: 'sender@example.com',
  password: 'test-only',
  imapHost: 'imap.example.com',
  smtpHost: 'smtp.example.com',
});
const input = composeSchema.parse({
  to: ['to@example.com'],
  bcc: ['hidden@example.com'],
  subject: 'Test',
  text: 'Synthetic mail only',
});
class Ledger implements SendLedger {
  entries = new Map<string, { hash: string; state: string; result?: unknown }>();
  async claim(key: string, hash: string) {
    const entry = this.entries.get(key);
    if (entry) {
      if (entry.hash !== hash) throw Error('Idempotency key already used for a different message');
      return { fresh: false, ...entry };
    }
    this.entries.set(key, { hash, state: 'in_progress' });
    return { fresh: true, state: 'in_progress' };
  }
  async finish(key: string, state: string, result: unknown) {
    Object.assign(this.entries.get(key)!, { state, result });
  }
}
const makeMail = (smtp?: any, imap?: any, ledger = new Ledger()) =>
  new MailService([account], imap, ledger, 'test-only-hmac', smtp);
test('IMAP and SMTP never downgrade or skip certificate verification', () => {
  assert.equal(imapOptions(account).secure, true);
  assert.equal(smtpOptions(account).secure, true);
  assert.equal(smtpOptions(account).requireTLS, true);
  assert.equal(smtpOptions(account).tls.rejectUnauthorized, true);
  assert.equal(imapOptions({ ...account, imapPort: 143 }).doSTARTTLS, true);
  assert.equal(imapOptions({ ...account, imapPort: 143 }).secure, false);
  assert.equal(smtpOptions({ ...account, smtpPort: 587 }).requireTLS, true);
  assert.equal(smtpOptions({ ...account, smtpPort: 587 }).secure, false);
});
test('reject plaintext SMTP port', () =>
  assert.throws(() => accountSchema.parse({ ...account, smtpPort: 25 })));
test('message reference round-trips with UIDVALIDITY and rejects cross-account access', () => {
  const ref = { account: 'test', folder: 'INBOX/Öffentlich', validity: '12345', uid: 44 };
  assert.deepEqual(decodeRef(encodeRef(ref), 'test'), ref);
  assert.throws(() => decodeRef(encodeRef(ref), 'other'), /another account/);
});
test('reject malformed message IDs', () => assert.throws(() => decodeRef('invalid', 'test')));
test('reject header injection', () =>
  assert.throws(() =>
    composeSchema.parse({ ...input, subject: 'Test\r\nBcc: attacker@example.com' }),
  ));
test('reject attachment header injection', () =>
  assert.throws(() =>
    composeSchema.parse({
      ...input,
      attachments: [{ filename: 'x\nfoo', contentType: 'text/plain', base64: 'eA==' }],
    }),
  ));
test('reject URL/file attachment inputs by requiring explicit bytes', () =>
  assert.throws(() =>
    composeSchema.parse({
      ...input,
      attachments: [{ filename: 'x', contentType: 'text/plain', path: '/etc/passwd' }],
    }),
  ));
test('validate verified email identity against exact allowlist', () => {
  assert.deepEqual(
    allowIdentity({ email: 'OWNER@example.com', email_verified: true, sub: '123' }, [
      'owner@example.com',
    ]),
    { email: 'owner@example.com', sub: '123' },
  );
  assert.throws(() =>
    allowIdentity({ email: 'owner@example.com', email_verified: false, sub: '123' }, [
      'owner@example.com',
    ]),
  );
  assert.throws(() =>
    allowIdentity({ email: 'stranger@example.com', email_verified: true, sub: '123' }, [
      'owner@example.com',
    ]),
  );
});
test('OAuth rejects missing PKCE, plain PKCE, wrong resource and unknown scopes', () => {
  const base = 'https://mail.example.com';
  for (const query of [
    '',
    'code_challenge=abc&code_challenge_method=plain',
    'resource=https://evil.example',
  ])
    assert.throws(() => validateOAuthRequest(new URLSearchParams(query), base, true));
  assert.throws(() => validateOAuthRequest(new URLSearchParams('scope=admin'), base, false));
  const params = new URLSearchParams({
    redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect',
    code_challenge: 'a'.repeat(43),
    code_challenge_method: 'S256',
    resource: base,
    scope: 'openid email',
  });
  assert.doesNotThrow(() => validateOAuthRequest(params, base, true));
});
test('MIME hides Bcc but includes it in SMTP envelope', async () => {
  const built = await makeMail().compile('test', input);
  assert.deepEqual(built.envelope.to, ['to@example.com', 'hidden@example.com']);
  assert.doesNotMatch(built.raw.toString(), /^Bcc:/im);
  const parsed = await simpleParser(built.raw);
  assert.equal(parsed.from?.value[0].address, account.email);
  assert.equal(parsed.text?.trim(), 'Synthetic mail only');
});
test('reject sends without recipients', async () => {
  await assert.rejects(makeMail().compile('test', { ...input, to: [], bcc: [] }), /At least/);
});
test('concurrent same-key send is submitted exactly once', async () => {
  let calls = 0;
  const mail = makeMail(() => ({
    sendMail: async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return { accepted: ['x'], rejected: [] };
    },
    close() {},
  }));
  mail.withImap = async () => true as any;
  const results = await Promise.all([
    mail.send('test', input, 'one'),
    mail.send('test', input, 'one'),
  ]);
  assert.equal(calls, 1);
  assert.ok(results.some((r: any) => r.replayed));
});
test('same key and changed content fails closed', async () => {
  const mail = makeMail(() => ({
    sendMail: async () => ({ accepted: ['x'], rejected: [] }),
    close() {},
  }));
  mail.withImap = async () => true as any;
  await mail.send('test', input, 'one');
  await assert.rejects(mail.send('test', { ...input, text: 'Changed' }, 'one'), /Idempotency/);
});
test('SMTP timeout remains uncertain and cannot trigger resend', async () => {
  let calls = 0;
  const mail = makeMail(() => ({
    sendMail: async () => {
      calls++;
      throw Error('timed out after DATA');
    },
    close() {},
  }));
  const first: any = await mail.send('test', input, 'one'),
    second: any = await mail.send('test', input, 'one');
  assert.equal(first.delivery, 'unknown');
  assert.equal(second.state, 'uncertain');
  assert.equal(calls, 1);
});
test('Sent append failure preserves SMTP acceptance without resend', async () => {
  let calls = 0;
  const mail = makeMail(() => ({
    sendMail: async () => {
      calls++;
      return { accepted: ['x'], rejected: ['y'] };
    },
    close() {},
  }));
  mail.withImap = async () => {
    throw Error('IMAP down');
  };
  const result: any = await mail.send('test', input, 'one');
  assert.equal(result.sentCopy, 'failed');
  assert.equal(result.acceptedCount, 1);
  assert.equal(result.rejectedCount, 1);
  await mail.send('test', input, 'one');
  assert.equal(calls, 1);
});
test('receipt persistence failure after acceptance does not retry SMTP', async () => {
  let calls = 0;
  const ledger = new Ledger();
  ledger.finish = async () => {
    throw Error('Firestore down');
  };
  const mail = makeMail(
    () => ({
      sendMail: async () => {
        calls++;
        return { accepted: ['x'], rejected: [] };
      },
      close() {},
    }),
    undefined,
    ledger,
  );
  const result: any = await mail.send('test', input, 'one');
  assert.equal(result.receipt, 'persistence_failed');
  await mail.send('test', input, 'one');
  assert.equal(calls, 1);
});
function fakeImap(validity = '1') {
  return Object.assign(new EventEmitter(), {
    mailbox: { uidValidity: BigInt(validity), readOnly: false },
    capabilities: new Set(),
    connect: async () => {},
    logout: async () => {},
    close() {},
    getMailboxLock: async () => ({ release() {} }),
    messageDelete: async () => true,
  });
}
test('stale UIDVALIDITY blocks operations before mutation', async () => {
  let deletes = 0;
  const imap = fakeImap('2');
  imap.messageDelete = async () => {
    deletes++;
    return true;
  };
  const mail = makeMail(undefined, () => imap);
  await assert.rejects(
    mail.deletePermanent(
      'test',
      encodeRef({ account: 'test', folder: 'INBOX', validity: '1', uid: 1 }),
    ),
    /Mailbox changed/,
  );
  assert.equal(deletes, 0);
});
test('permanent deletion refuses servers without UIDPLUS', async () => {
  const mail = makeMail(undefined, () => fakeImap());
  await assert.rejects(
    mail.deletePermanent(
      'test',
      encodeRef({ account: 'test', folder: 'INBOX', validity: '1', uid: 1 }),
    ),
    /UIDPLUS/,
  );
});
test('move refuses unsafe COPY plus global EXPUNGE fallback before mutation', async () => {
  const c = fakeImap();
  let moved = false;
  Object.assign(c, {
    messageMove: async () => {
      moved = true;
      return true;
    },
  });
  const mail = makeMail(undefined, () => c);
  await assert.rejects(
    mail.move(
      'test',
      encodeRef({ account: 'test', folder: 'INBOX', validity: '1', uid: 1 }),
      'Archive',
    ),
    /safe move disabled/,
  );
  assert.equal(moved, false);
});
test('failed flag operation does not report success', async () => {
  const c = fakeImap();
  Object.assign(c, { messageFlagsAdd: async () => false });
  const mail = makeMail(undefined, () => c);
  await assert.rejects(
    mail.flags(
      'test',
      encodeRef({ account: 'test', folder: 'INBOX', validity: '1', uid: 1 }),
      ['\\Seen'],
      [],
    ),
    /Flag update failed/,
  );
});
test('reject reused crypto keys in deployment configuration', () => {
  assert.throws(() =>
    secretSchema.parse({
      googleClientId: 'x.apps.googleusercontent.com',
      googleClientSecret: 'test-only-secret',
      allowedEmails: ['owner@example.com'],
      jwtSigningKey: 'a'.repeat(50),
      encryptionKey: 'a'.repeat(50),
      consentSigningKey: 'b'.repeat(50),
      accounts: [account],
    }),
  );
});
test('special folders: configured name wins when present, SPECIAL-USE fallback when the provider prefixes paths', async () => {
  const listing = [
    { path: 'INBOX', specialUse: '\\Inbox' },
    { path: 'INBOX.Sent', specialUse: '\\Sent' },
    { path: 'INBOX.Drafts', specialUse: '\\Drafts' },
    { path: 'Sent' },
  ];
  const c = Object.assign(fakeImap(), { list: async () => listing });
  const prefixed = new MailService(
    [{ ...account, sentFolder: 'Sent', draftsFolder: 'Drafts', trashFolder: 'Trash' }],
    () => c,
  );
  const access = prefixed as unknown as {
    special: (c: unknown, a: unknown, t: string) => Promise<string>;
  };
  const a = (prefixed as unknown as { accounts: unknown[] }).accounts[0];
  assert.equal(await access.special(c, a, 'sent'), 'Sent', 'configured folder exists: used as is');
  assert.equal(
    await access.special(c, a, 'drafts'),
    'INBOX.Drafts',
    'missing Drafts: SPECIAL-USE wins',
  );
  await assert.rejects(access.special(c, a, 'trash'), /Configured trash folder does not exist/);
  await assert.rejects(access.special(c, a, 'archive'), /No archive folder discovered/);
});
