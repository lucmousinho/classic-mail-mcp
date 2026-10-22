# Provider notes

The server works with any IMAP/SMTP provider that accepts password or app-password authentication over TLS. This page collects the values the setup wizard offers as presets and the quirks worth knowing. Hostnames come from each provider's own documentation; verify them in your provider's panel before relying on them.

## DreamHost (shared hosting mailboxes)

Values from DreamHost's [email client configuration overview](https://help.dreamhost.com/hc/en-us/articles/214918038):

| Setting   | Value                                                                                                   |
| --------- | ------------------------------------------------------------------------------------------------------- |
| IMAP host | `imap.dreamhost.com`, port 993 (implicit TLS)                                                           |
| SMTP host | `smtp.dreamhost.com`, port 587 (STARTTLS, the setting DreamHost recommends)                             |
| Username  | the full address usually works; DreamHost documents the local part                                      |
| Password  | the mailbox password set on the panel's **Manage Email** page                                           |
| Folders   | advertised via SPECIAL-USE; paths are usually `INBOX.Sent`, `INBOX.Drafts`, `INBOX.Trash`, `INBOX.Spam` |

Wizard preset: `python3 scripts/setup.py --mode oauth` and answer `dreamhost` at the provider prompt; every default can still be edited.

Things to keep in mind:

- **Failed logins block your IP temporarily.** DreamHost blocks an address after several wrong passwords. Run `check_connection` once after each configuration change instead of retrying blindly; if a block happens it lifts on its own or DreamHost support can clear it.
- **Port 465 also works** on `smtp.dreamhost.com` if your network blocks 587. This server requires STARTTLS on 587 and never downgrades, so either port is safe.
- **Sending quotas apply.** DreamHost limits outbound mail per hour per account; the server's idempotency ledger prevents duplicate sends on retries but cannot raise the quota.
- **Folder names**: leave `sentFolder`, `draftsFolder` and `trashFolder` unset for DreamHost. Mailboxes advertise the special folders (`\\Sent`, `\\Drafts`, `\\Trash`) and the server discovers the right path per mailbox, which matters because some DreamHost mailboxes use the `INBOX.` prefix and others do not. A configured name that does not exist on a mailbox falls back to discovery.
- The IMAP username is the full address (`name@example.com`), not the panel login.

## Other providers

Use `custom` at the provider prompt and enter the hostnames from your provider. Providers that require OAuth/XOAUTH2 for IMAP (some Microsoft 365 and Google configurations) are not supported; see the README.
