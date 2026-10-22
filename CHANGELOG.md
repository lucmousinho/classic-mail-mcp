# Changelog

## 2.2.0 — multi-user "mailbox" mode

- New `AUTH_MODE=mailbox`: the server is its own OAuth 2.1 authorization server. Each person signs in with the IMAP credentials of a mailbox on an operator-allowed domain; the password is verified against the provider once, sealed with AES-256-GCM under the operator's `encryptionKey` (bound to that person), and every tool call resolves to that person's mailbox only. No mailbox credential exists in the configuration.
- Dynamic Client Registration limited to public clients with S256 PKCE (what Claude and Claude Code use); authorization codes are one-use, refresh tokens rotate and are client-bound, access tokens can be revoked, removing a user revokes everything at once.
- Sign-in attempts are throttled per mailbox (5 / 15 min), per client IP and globally before the provider is contacted, so a shared egress IP cannot be locked out by one person's typos.
- Per-user MailService resolution in the tool layer (`registerTools` accepts a session resolver); send-idempotency ledger keys are prefixed with the subject.
- `scripts/setup.py --mode mailbox`, `dist/users-cli.js list|remove`, Portainer stacks default to `AUTH_MODE=mailbox`, Portuguese guide rewritten for Claude Team.
- The single-operator modes (`oauth` with Google, `bearer`, `stdio`) are unchanged.

## 2.1.0 — Claude connector, DreamHost preset, Portainer stack

- OAuth: allowlist the hosted Claude callback `https://claude.ai/api/mcp/auth_callback` (claude.ai, Desktop, mobile, Cowork) next to the ChatGPT callback; Claude Code's loopback callback was already accepted. Gateway Origin check accepts `https://claude.ai`.
- OAuth: advertise the MCP endpoint (`BASE_URL/mcp`) as the RFC 9728 protected resource so Claude's resource check passes; `401` responses now point at `/.well-known/oauth-protected-resource/mcp`. The token and authorize endpoints accept both the origin and the endpoint as `resource`.
- Consent page shows the redirect host and warns when it is a loopback address, as the MCP authorization spec asks.
- Setup wizard: provider presets (`dreamhost`, `custom`) with hostnames, ports and standard folder names; new `docs/providers.md`.
- Deployment: `deploy/portainer/` stack files for Traefik and for a local proxy port, example configuration, GHCR publish workflow and a Portuguese Portainer + claude.ai guide (`docs/portainer.md`).
- Tests: full simulated OAuth flow for the Claude callback, resource-indicator validation, discovery metadata at both well-known paths, wizard preset test.

## 2.0.0 — public preview

- General operator-configured IMAP and SMTP hosts, including mandatory STARTTLS.
- Local Docker/stdio and bearer HTTP modes, without a Google Cloud dependency at runtime.
- SQLite persistence for OAuth state, rate limits and send idempotency; Firestore for Cloud Run.
- Read-only default with six tools; explicit opt-in to all 21 mail tools.
- Google OAuth with browser/redirect/PKCE binding and separate access/refresh token-purpose records.
- Hidden-input configuration wizard, hardened Compose service, service landing page and English/German documentation.
- CI tests, Docker smoke checks and public-source checks.

This release begins a clean public source history. Private configurations and deployment artifacts are not included.
