import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("setup", Path(__file__).parents[1] / "scripts/setup.py")
setup = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(setup)

class SetupTests(unittest.TestCase):
    def test_wizard_hides_secrets_uses_private_permissions_and_refuses_overwrite(self):
        previous = Path.cwd()
        with tempfile.TemporaryDirectory() as tmp:
            try:
                os.chdir(tmp)
                answers = ["1", "personal", "custom", "owner@example.com", "", "imap.example.com", "993", "smtp.example.com", "587", "no", "no"]
                output = io.StringIO()
                with patch("sys.argv", ["setup.py"]), patch("builtins.input", side_effect=answers), patch("getpass.getpass", return_value="hidden-test-value"), contextlib.redirect_stdout(output):
                    setup.main()
                path = Path(".secrets/config.json")
                config = json.loads(path.read_text())
                self.assertEqual(config["accounts"][0]["password"], "hidden-test-value")
                self.assertNotIn("hidden-test-value", output.getvalue())
                self.assertNotIn(config["bearerToken"], output.getvalue())
                self.assertNotEqual(config["bearerToken"], config["encryptionKey"])
                self.assertGreaterEqual(len(config["bearerToken"]), 43)
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
                self.assertFalse(config["accounts"][0]["appendSent"])
                with patch("sys.argv", ["setup.py"]), self.assertRaises(ValueError):
                    setup.main()
                self.assertEqual(json.loads(path.read_text()), config)
            finally:
                os.chdir(previous)

    def test_dreamhost_preset_fills_hosts_ports_and_folders(self):
        previous = Path.cwd()
        with tempfile.TemporaryDirectory() as tmp:
            try:
                os.chdir(tmp)
                # Empty answers accept each default: DreamHost hosts, 993/587, standard folder names.
                answers = ["1", "", "", "contato@example.com", "", "", "", "", "", "", "", "", "", "no"]
                with patch("sys.argv", ["setup.py"]), patch("builtins.input", side_effect=answers), patch("getpass.getpass", return_value="hidden-test-value"), contextlib.redirect_stdout(io.StringIO()):
                    setup.main()
                account = json.loads(Path(".secrets/config.json").read_text())["accounts"][0]
                self.assertEqual(account["imapHost"], "imap.dreamhost.com")
                self.assertEqual(account["imapPort"], 993)
                self.assertEqual(account["smtpHost"], "smtp.dreamhost.com")
                self.assertEqual(account["smtpPort"], 587)
                self.assertEqual(account["username"], "contato@example.com")
                self.assertEqual((account["sentFolder"], account["draftsFolder"], account["trashFolder"]), ("Sent", "Drafts", "Trash"))
                self.assertTrue(account["appendSent"])
            finally:
                os.chdir(previous)

    def test_mailbox_mode_stores_domains_and_provider_without_any_password(self):
        previous = Path.cwd()
        with tempfile.TemporaryDirectory() as tmp:
            try:
                os.chdir(tmp)
                answers = ["Mamboo.co.ao, mambootech.com", "", "", "", "", "", "", "", "", "", "Mamboo Mail"]
                with patch("sys.argv", ["setup.py", "--mode", "mailbox"]), patch("builtins.input", side_effect=answers), patch("getpass.getpass", side_effect=AssertionError("no password prompt expected")), contextlib.redirect_stdout(io.StringIO()):
                    setup.main()
                config = json.loads(Path(".secrets/config.json").read_text())
                self.assertEqual(config["allowedDomains"], ["mamboo.co.ao", "mambootech.com"])
                self.assertEqual(config["provider"]["imapHost"], "imap.dreamhost.com")
                self.assertEqual(config["provider"]["smtpPort"], 587)
                self.assertEqual(config["provider"]["sentFolder"], "Sent")
                self.assertEqual(config["displayName"], "Mamboo Mail")
                self.assertNotIn("accounts", config)
                self.assertEqual(len({config["jwtSigningKey"], config["encryptionKey"], config["consentSigningKey"]}), 3)
                self.assertIn("AUTH_MODE=mailbox", Path(".env").read_text())
            finally:
                os.chdir(previous)

if __name__ == "__main__":
    unittest.main()
