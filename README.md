<p align="center"><img src="assets/banner.svg" alt="Classic Mail — Your mailbox. Your agent. Your server." width="100%"></p>

<p align="center">
  <a href="https://github.com/kapitelh/classic-mail-mcp/actions/workflows/ci.yml">CI</a> ·
  <a href="LICENSE">MIT license</a> ·
  <a href="docs/README.de.md">Deutsch</a> ·
  <a href="docs/deployment.md">Deployment</a> ·
  <a href="docs/security.md">Security model</a>
</p>

**A self-hosted MCP server for the IMAP and SMTP mailbox you already have.**
Connect an AI assistant to search and read email, inspect attachments, and — when explicitly enabled — send messages, manage drafts and organize folders.

Built for people whose mail provider does not offer an AI integration. Run it on your computer with Docker, on your own server, or on Google Cloud Run. Every installation belongs to **one operator**, with up to ten configured mailboxes.

> Public preview. Automated tests cover the protocol and security boundaries; provider compatibility and client sign-in must still be verified on your installation. This project has not had an independent security audit.

## What it does

| Read-only (default)                             | Read-write (opt-in)                     |
| ----------------------------------------------- | --------------------------------------- |
| List accounts and folders                       | Send, reply, reply-all and forward      |
| Search mail with pagination                     | Save and send drafts                    |
| Read without changing unread state              | Move, copy, archive and trash           |
| Download attachments in bounded chunks          | Manage folders and read/starred flags   |
| Check IMAP and SMTP credentials without sending | Explicitly confirmed permanent deletion |

Six tools are available by default; all **21 tools** become available with `ACCESS_MODE=read-write`. [Complete tool reference →](docs/tools.md)

- TLS certificate validation for every mailbox connection.
- IMAP 993 / SMTP 465 with implicit TLS; IMAP 143 / SMTP 587 with **mandatory STARTTLS**.
- OAuth with Google sign-in for remote clients (Claude's hosted callback, Claude Code's loopback callback and ChatGPT's callback are allowlisted); bearer authentication for local HTTP; stdio for local MCP clients.
- Persistent send history prevents automatic duplicate submissions when the same idempotency key is retried.
- No mailbox passwords, bearer tokens or mail bodies in application logs.
- SQLite with persistent disk locally; Firestore for multiple Cloud Run instances.

## Choose a connection

| Your situation                                                                     | Transport                         | Authentication                 | Storage                                                |
| ---------------------------------------------------------------------------------- | --------------------------------- | ------------------------------ | ------------------------------------------------------ |
| Desktop client that can launch Docker                                              | stdio                             | Local process access           | SQLite volume                                          |
| Desktop client with an HTTP MCP endpoint                                           | Streamable HTTP on localhost      | Random bearer token            | SQLite volume                                          |
| Claude (claude.ai, Desktop, mobile, Claude Code), ChatGPT or another remote client | Streamable HTTP over public HTTPS | Google OAuth + owner allowlist | SQLite on a persistent host, or Firestore on Cloud Run |

Google sign-in authenticates **you to this MCP**. It does not grant Gmail access. Your configured IMAP/SMTP credentials authenticate to your mail provider separately.

## Quick start: local Docker

Requirements: Docker with Compose, Python 3 for the private setup wizard, and an IMAP/SMTP account that permits password or app-password authentication.

```sh
git clone https://github.com/kapitelh/classic-mail-mcp.git
cd classic-mail-mcp
python3 scripts/setup.py
docker compose up --build -d
```

The wizard hides passwords and generates independent random keys. It creates `.secrets/config.json`, `.data/` and `.env`. These are excluded from Git and Docker builds. The default Compose service binds **only to 127.0.0.1:8080**.

Open [the local service page](http://127.0.0.1:8080). In your MCP client, use:

| Setting        | Value                                                         |
| -------------- | ------------------------------------------------------------- |
| Name           | `classic-mail`                                                |
| Type           | Streamable HTTP                                               |
| URL            | `http://127.0.0.1:8080/mcp`                                   |
| Authentication | Bearer token from `bearerToken` in your private configuration |

If your client asks for a **bearer-token environment variable**, enter a variable name such as `CLASSIC_MAIL_TOKEN`, not the token itself. Set that variable in the environment used to launch your client. A GUI app may not inherit variables from your terminal. The Google OAuth client secret is never a bearer token. [Client examples →](docs/clients.md)

Then ask your agent:

1. “List the accounts available through Classic Mail.”
2. “Check the connection for account mail1.”
3. “Show the latest five messages in INBOX without marking them as read.”

A healthy service page is not proof of a working mailbox. These checks verify discovery, credentials and an actual read.

### Enable sending and management

Set `ACCESS_MODE=read-write` in `.env`, then:

```sh
docker compose up -d
```

Refresh the tool list in your client. Configure the client to request confirmation for sending and destructive operations. Server descriptions cannot enforce a human approval dialog in arbitrary clients. All connected clients for this operator share access to the same configured accounts.

### Local stdio

Use the same private configuration or run the wizard with `--mode stdio`. Build once:

```sh
docker build -t classic-mail-mcp:local .
```

Configure your MCP client to launch the Docker command documented in [client setup](docs/clients.md). Use `-i`, **never `-t`**, and mount both configuration and persistent data. No HTTP port is exposed in stdio mode.

## Deploy with OAuth

[Deployment guide →](docs/deployment.md) covers a persistent Docker host with an HTTPS reverse proxy and a two-stage Google Cloud Run setup script. [Portainer guide (português) →](docs/portainer.md) covers a Portainer stack behind Traefik or Nginx Proxy Manager, the DreamHost mailbox preset and the claude.ai custom connector, with ready-made stack files in `deploy/portainer/`. You need your **own** cloud project, Google OAuth web client, credentials and allowed sign-in identity. There is no shared hosted mailbox service.

## Provider support

Any provider with standard IMAP/SMTP **password or app-password** authentication and a valid TLS certificate can be configured. Credentials may have a separate SMTP username/password. Hostnames are supplied by the operator, not by tools.

The automated suite uses synthetic IMAP, SMTP and OAuth responses. It does not certify individual providers. Accounts requiring provider OAuth/XOAUTH2 (for example some Microsoft or Google configurations), local plaintext mail bridges, custom ports and enterprise SSO are not implemented. Check your provider's current requirements before installing.

## Limits you should know

- Raw message: 8 MiB. Downloaded attachment: 4 MiB, in 128 KiB chunks. Read text: 50,000 characters.
- A search page scans at most 10,000 UIDs. Follow `nextBeforeUid` even if a page is empty.
- Folder restrictions are exact matches. Special folders may need explicit configuration.
- SMTP acceptance is not recipient delivery. Sent-folder copying can fail separately.
- Never retry an uncertain send with a new idempotency key. Inspect the provider's Sent folder first.
- The server connects to existing mailboxes; it does not host incoming SMTP, run a background inbox watcher or provide push notifications.
- No multi-user isolation: run a separate instance and storage for each person.

## Development

Node.js 24, npm, Python 3 and OpenSSL are used by the checks.

```sh
npm ci
npm run check
docker build -t classic-mail-mcp:local .
```

See [configuration](docs/configuration.md), [architecture](docs/architecture.md), [troubleshooting](docs/troubleshooting.md), [contributing](CONTRIBUTING.md) and [security reporting](SECURITY.md).

Made by [kapitelh](https://github.com/kapitelh). Released under the [MIT license](LICENSE).
