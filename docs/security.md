# Security and privacy model

Classic Mail is a **single-operator self-hosted service**. Every configured mailbox belongs to the same trust boundary. It is not a hosted multi-tenant service, and additional users must receive separate instances and storage.

## Trust boundaries

1. The operator configures trusted IMAP/SMTP hosts and credentials. Tools cannot choose remote hosts or supply login credentials.
2. Stdio trusts the local launching process. HTTP requires either a random bearer token or OAuth. Public deployments require HTTPS.
3. Google OAuth identifies the exact allowed owner with a verified email claim. Mailbox passwords authenticate separately to IMAP/SMTP.
4. Email, attachments, folder names and headers remain untrusted content. A connected AI client receives requested message content and may transmit it to its model provider.

The application does not implement provider XOAUTH2, per-mailbox users, S/MIME, PGP, end-to-end email encryption or a human-approval UI. TLS protects transport; it does not make ordinary email end-to-end encrypted.

## Multi-user mailbox mode

`AUTH_MODE=mailbox` replaces the Google proxy with a built-in authorization server. Trust boundaries change as follows:

- Identity is the mailbox: a sign-in is one TLS-verified IMAP login with the credentials the person typed, on a domain the operator allowed. Nothing else vouches for the person.
- Each person's password is sealed with AES-256-GCM under a key derived from `encryptionKey`, with the subject as associated data, and opened only to build that person's own `MailService`. Tool calls never take a credential or a host; the account they can name is the one bound to their token.
- Tokens: HS256 access tokens (1 h) checked against a server-side issuance record; refresh tokens (30 d) are random, client-bound, atomically rotated; authorization codes are one-use and PKCE-bound; only public clients are registered. Removing a user deletes the sealed record, which denies every outstanding token at the next request.
- Sign-in throttling runs per mailbox, per client IP and globally **before** the provider is contacted, because providers such as DreamHost block an IP after repeated failures and all users share the server's egress IP.
- The sign-in page is served by this server under its CSP (no scripts) and binds the browser transaction with a signed, HttpOnly, Secure cookie; the form is accepted only from the server's own origin.
- Residual risks: a compromised host exposes `encryptionKey` and the sealed records together; the operator can impersonate any user; the page is a password form on the operator's domain, so people must be told to type it only at that exact address.

## OAuth controls

- S256 PKCE, with independent upstream Google and downstream MCP verifier/challenge pairs.
- Exact issuer and audience checks; identity scopes are verified.
- A signed, short-lived HttpOnly Secure SameSite cookie binds consent and callback to the browser transaction.
- Redirects are restricted to the ChatGPT callback and a narrow native loopback pattern.
- Authorization code exchange checks the client, redirect and verifier.
- Access and refresh tokens have separate server-side issuance records. Refresh tokens cannot be used for tools; access tokens cannot be used for refresh. Refresh is client-bound and rotated.
- OAuthProxy encrypts its stored token values. Document IDs hash sensitive keys. SQLite files use restricted permissions; on Cloud Run use dedicated Firestore IAM and Secret Manager.
- Owner identity is checked using Google's userinfo endpoint; unverified decoded identity claims are never trusted.

The OAuth library and platform remain part of the trusted computing base. Tests are not an independent audit. Reconnect after key rotation; preserve send history.

## Mail and mutation safety

TLS 1.2 or later and hostname/certificate verification are mandatory. STARTTLS is required, never opportunistically downgraded. [ImapFlow policy](https://imapflow.com/docs/api/imapflow-client/) and [Nodemailer TLS settings](https://nodemailer.com/smtp) describe the underlying transport options.

Read operations use read-only selection and BODY.PEEK. Message references include account, folder, UIDVALIDITY and UID to reject stale/cross-account references. Permanent message deletion requires UIDPLUS to avoid a global expunge of unrelated messages. System folders cannot be deleted, and folder deletion requires an empty folder.

Sending uses a persistent claim before SMTP and stores acceptance before copying into Sent. A timeout is uncertain, not automatically retried. Idempotency only protects repeated calls with the **same key and payload**, against the same preserved database. It cannot promise exactly-once email delivery across SMTP failures.

Read-only mode omits write tools entirely. Read-write mode exposes them to the authenticated operator; tool annotations and descriptions are not an enforcement mechanism for human approval. Configure your MCP client accordingly.

## Data at rest and logs

- Config files contain mailbox credentials in plaintext and must be mode 600, stored outside Git and mounted read-only. Disk encryption and encrypted backups are the operator's responsibility.
- OAuth token values are encrypted by the proxy; send ledger metadata (including accepted/rejected recipient addresses and message IDs) is not application-encrypted. Protect storage accordingly.
- Mail bodies and attachments are processed in memory and returned to the client. The application does not intentionally persist an inbox cache.
- Provider errors are sanitized before being returned to tools. Do not enable raw IMAP/SMTP logging.
- Infrastructure access logs, client histories and provider logs are separate; operators must control them.
- Size/concurrency/rate limits reduce resource abuse; there is no antivirus, attachment sandbox or comprehensive DDoS protection.
- Operator-configured hosts can reach internal networks. Do not let untrusted tenants edit config, and use network egress restrictions if your hosting environment requires them.

See [SECURITY.md](../SECURITY.md) for vulnerability reporting.
