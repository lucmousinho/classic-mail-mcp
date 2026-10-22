# Connect your client

## Local HTTP

Use `http://127.0.0.1:8080/mcp` with a Bearer token. The token lives in `bearerToken` in your private JSON configuration. It is not the Google client secret or the mailbox password.

For a terminal-launched client, load it without placing its literal value in shell history:

```sh
export CLASSIC_MAIL_TOKEN="$(python3 -c 'import json; print(json.load(open(".secrets/config.json"))["bearerToken"])')"
```

Use `CLASSIC_MAIL_TOKEN` in an environment-variable-name field. Do not paste the name into a field that expects the actual token. GUI clients may require a different environment setup; consult that client's documentation. Keep credentials out of shared client configuration files and screenshots.

Example for clients supporting a Codex-style TOML configuration:

```toml
[mcp_servers.classic_mail]
url = "http://127.0.0.1:8080/mcp"
bearer_token_env_var = "CLASSIC_MAIL_TOKEN"
```

## Docker stdio

For a JSON-configured local MCP client, replace paths and UID/GID with your actual values. On macOS/Linux, obtain them with `id -u` and `id -g`. The configuration and data directory must already exist. Docker must be running.

```json
{
  "mcpServers": {
    "classic-mail": {
      "command": "docker",
      "args": [
        "run",
        "--rm",
        "-i",
        "--init",
        "--user",
        "1000:1000",
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--mount",
        "type=bind,src=/absolute/path/classic-mail-mcp/.secrets/config.json,dst=/run/secrets/config.json,readonly",
        "--mount",
        "type=bind,src=/absolute/path/classic-mail-mcp/.data,dst=/data",
        "-e",
        "TRANSPORT=stdio",
        "-e",
        "AUTH_MODE=stdio",
        "-e",
        "ACCESS_MODE=read-only",
        "-e",
        "APP_CONFIG_FILE=/run/secrets/config.json",
        "classic-mail-mcp:local"
      ]
    }
  }
}
```

Do not use `-t`: terminal decoration would corrupt MCP's JSON stream. Stdio trusts the local process that launches the server and does not use bearer/OAuth authentication. A bearer-mode JSON configuration is also accepted for stdio; its bearer token is unused.

## Remote OAuth / Claude (claude.ai, Desktop, mobile, Claude Code)

Deploy first, using [the OAuth guide](deployment.md) or the [Portainer guide](portainer.md). Then in claude.ai go to **Settings → Connectors → Add custom connector**, enter `https://YOUR-SERVICE/mcp` and leave the OAuth client ID and secret fields empty: Claude registers itself through Dynamic Client Registration. The same connector appears in Claude Desktop and the mobile apps.

The server accepts Claude's hosted callback `https://claude.ai/api/mcp/auth_callback` and advertises `https://YOUR-SERVICE/mcp` as the RFC 9728 resource, which Claude verifies against the URL you entered. Sign in with the single Google account listed in `allowedEmails`.

For Claude Code, add the server with `claude mcp add --transport http classic-mail https://YOUR-SERVICE/mcp` and run `/mcp` to sign in; Claude Code returns to a loopback callback (`http://localhost:PORT/callback`), which the allowlist accepts on any port.

After authentication, refresh the tool list and run `list_accounts`, `check_connection` and a real `search_messages` call.

## Remote OAuth / ChatGPT

Deploy first, using [the OAuth guide](deployment.md). Enter `https://YOUR-SERVICE/mcp` in the client's remote MCP setup and choose OAuth. Leave manual bearer tokens and custom authorization headers empty.

The server supports dynamic client registration. **Do not enter the Google OAuth client secret in your MCP client**: that secret belongs only in the server configuration. Sign in using the single Google account listed in `allowedEmails`.

The allowlist accepts the Claude callback `https://claude.ai/api/mcp/auth_callback`, the ChatGPT callback `https://chatgpt.com/connector_platform_oauth_redirect` and native loopback callbacks shaped as `http://127.0.0.1:PORT/callback` or `http://localhost:PORT/callback/OPAQUE_ID`. Other hosted callbacks require a code change in `src/auth.ts` (`HOSTED_CALLBACKS`) and a security review.

After authentication, refresh the client's tools and run `list_accounts`, `check_connection` and a real `search_messages` call. Authentication alone does not prove action discovery or mailbox access. Client product names and settings can change; this project is independent of OpenAI.
