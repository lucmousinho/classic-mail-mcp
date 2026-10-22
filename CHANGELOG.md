# Changelog

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
