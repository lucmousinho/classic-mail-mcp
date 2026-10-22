#!/usr/bin/env python3
"""Create a private configuration. Passwords are hidden; existing files are never overwritten."""
import argparse
import getpass
import json
import os
from pathlib import Path
import re
import secrets

def ask(label, default=None):
    value = input(label + (f" [{default}]" if default is not None else "") + ": ").strip()
    return value or default or ""

def hidden(label):
    value = getpass.getpass(label + ": ")
    if not value:
        raise ValueError("A secret cannot be empty")
    return value

def write_private(path, content):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as handle:
        handle.write(content)

# Provider presets only fill the prompts' defaults; every value can still be changed.
# Hostnames come from each provider's own documentation (see docs/providers.md).
PRESETS = {
    "dreamhost": dict(imap="imap.dreamhost.com", imap_port=993, smtp="smtp.dreamhost.com", smtp_port=587,
                      folders=dict(sentFolder="Sent", draftsFolder="Drafts", trashFolder="Trash")),
    "custom": dict(imap="", imap_port=993, smtp="", smtp_port=465, folders={}),
}

def mailbox_setup(path, print_env=False):
    """Multi-user mode: no mailbox password here. People sign in with their own IMAP credentials."""
    print("Classic Mail MCP · multi-user (mailbox) setup\nEach person signs in with their own mailbox; only domains you allow may register.")
    domains = [d.strip().lower() for d in ask("Allowed email domains, comma separated (e.g. mamboo.co.ao,mambootech.com)").split(",") if d.strip()]
    if not domains or any(not re.fullmatch(r"[a-z0-9.-]{1,253}", d) for d in domains):
        raise ValueError("Enter at least one valid domain")
    preset = PRESETS[ask("Provider preset (" + "/".join(PRESETS) + ")", "dreamhost").lower()]
    imap = ask("IMAP hostname", preset["imap"] or None)
    imap_port = int(ask("IMAP port: 993 = TLS, 143 = required STARTTLS", str(preset["imap_port"])))
    smtp = ask("SMTP hostname", preset["smtp"] or None)
    smtp_port = int(ask("SMTP port: 465 = TLS, 587 = required STARTTLS", str(preset["smtp_port"])))
    if imap_port not in [993, 143] or smtp_port not in [465, 587]:
        raise ValueError("Only encrypted standard mail ports are supported")
    if not imap or not smtp:
        raise ValueError("IMAP and SMTP hostnames are required")
    provider = dict(imapHost=imap, imapPort=imap_port, smtpHost=smtp, smtpPort=smtp_port,
                    appendSent=ask("Append sent mail to IMAP? Use no if the provider already saves it", "yes").lower() == "yes")
    for key, default in preset["folders"].items():
        provider[key] = ask(f"{key} name", default)
    config = dict(allowedDomains=domains, provider=provider,
                  displayName=ask("Name shown on the sign-in page", "Classic Mail"),
                  jwtSigningKey=secrets.token_urlsafe(48), encryptionKey=secrets.token_urlsafe(48),
                  consentSigningKey=secrets.token_urlsafe(48))
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    write_private(path, json.dumps(config, indent=2) + "\n")
    Path(".data").mkdir(mode=0o700, exist_ok=True)
    if not Path(".env").exists():
        uid = os.getuid() if hasattr(os, "getuid") else 1000
        gid = os.getgid() if hasattr(os, "getgid") else 1000
        write_private(".env", f"LOCAL_UID={uid}\nLOCAL_GID={gid}\nACCESS_MODE=read-write\nAUTH_MODE=mailbox\n")
    print(f"\nSaved private configuration: {path}\nNo mailbox password is stored in it; people sign in with their own.")
    if print_env:
        # Portainer without shell/SCP access: the whole configuration travels as one stack variable.
        # It holds signing/encryption keys (no mailbox password), so paste it only into the stack's
        # environment variables and nowhere else.
        print("\nPortainer > stack > Environment variables > Advanced mode: add this line, exactly as printed.")
        print("Treat it as a secret: it carries the server's signing and encryption keys.\n")
        print("APP_CONFIG_JSON=" + json.dumps(config, separators=(",", ":")))
    print("Next: docs/portainer.md (Portainer + Claude Team) or docs/deployment.md.")

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=["bearer", "stdio", "oauth", "mailbox"], default="bearer")
    parser.add_argument("--output", default=".secrets/config.json")
    parser.add_argument("--print-env", action="store_true",
                        help="mailbox mode only: also print the configuration as an APP_CONFIG_JSON line for Portainer")
    args = parser.parse_args()
    os.umask(0o077)
    path = Path(args.output)
    if path.exists():
        raise ValueError("Configuration already exists; choose a new --output path")
    if args.mode == "mailbox":
        return mailbox_setup(path, args.print_env)
    print("Classic Mail MCP · private setup\nOne operator owns every mailbox in this instance.")
    count = int(ask("Number of mailboxes (1–10)", "1"))
    if not 1 <= count <= 10:
        raise ValueError("Choose 1–10 mailboxes")
    accounts = []
    for index in range(count):
        print(f"\nMailbox {index + 1}")
        account_id = ask("Short account ID", f"mail{index + 1}")
        if not re.fullmatch(r"[a-z0-9_-]{1,40}", account_id) or any(a["id"] == account_id for a in accounts):
            raise ValueError("Account ID must be unique and use lowercase letters, digits, _ or -")
        preset = PRESETS[ask("Provider preset (" + "/".join(PRESETS) + ")", "dreamhost").lower()]
        email = ask("Email address")
        username = ask("IMAP username (DreamHost: the full email address)", email)
        password = hidden("Mailbox / app password")
        imap = ask("IMAP hostname", preset["imap"] or None)
        imap_port = int(ask("IMAP port: 993 = TLS, 143 = required STARTTLS", str(preset["imap_port"])))
        smtp = ask("SMTP hostname", preset["smtp"] or None)
        smtp_port = int(ask("SMTP port: 465 = TLS, 587 = required STARTTLS", str(preset["smtp_port"])))
        if imap_port not in [993, 143] or smtp_port not in [465, 587]:
            raise ValueError("Only encrypted standard mail ports are supported")
        if not imap or not smtp:
            raise ValueError("IMAP and SMTP hostnames are required")
        account = dict(id=account_id, email=email, username=username, password=password,
                       imapHost=imap, imapPort=imap_port, smtpHost=smtp, smtpPort=smtp_port,
                       appendSent=ask("Append sent mail to IMAP? Use no if your provider already saves it", "yes").lower() == "yes")
        for key, default in preset["folders"].items():
            account[key] = ask(f"{key} name", default)
        if ask("Separate SMTP credentials?", "no").lower() == "yes":
            account.update(smtpUsername=ask("SMTP username"), smtpPassword=hidden("SMTP password"))
        accounts.append(account)
    config = dict(accounts=accounts, encryptionKey=secrets.token_urlsafe(48))
    if args.mode == "bearer":
        config["bearerToken"] = secrets.token_urlsafe(48)
    if args.mode == "oauth":
        config.update(googleClientId=ask("Google OAuth WEB client ID"),
                      googleClientSecret=hidden("Google OAuth WEB client secret"),
                      allowedEmails=[ask("ONE Google sign-in email allowed to access all mailboxes")],
                      jwtSigningKey=secrets.token_urlsafe(48), consentSigningKey=secrets.token_urlsafe(48))
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    write_private(path, json.dumps(config, indent=2) + "\n")
    Path(".data").mkdir(mode=0o700, exist_ok=True)
    if not Path(".env").exists():
        uid = os.getuid() if hasattr(os, "getuid") else 1000
        gid = os.getgid() if hasattr(os, "getgid") else 1000
        write_private(".env", f"LOCAL_UID={uid}\nLOCAL_GID={gid}\nACCESS_MODE=read-only\nAUTH_MODE={args.mode}\n")
    print(f"\nSaved private configuration: {path}\nNo password or token was printed. Default access is read-only.")
    print("Next: follow README.md for Docker or docs/deployment.md for OAuth.")

if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, EOFError, KeyboardInterrupt):
        raise SystemExit("Setup stopped. Check input and permissions; no secret values are logged.")
