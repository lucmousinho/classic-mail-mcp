import { readConfig, mailboxSecretSchema } from './config.js';
import { SqliteStore } from './sqlite.js';
import { MailboxAuth } from './mailbox-auth.js';

/**
 * Operator CLI for mailbox mode. Runs inside the container with the same environment:
 *   docker exec classic-mail-mcp node dist/users-cli.js list
 *   docker exec classic-mail-mcp node dist/users-cli.js remove person@example.com
 * Removing a person deletes their sealed credential and revokes every token at once.
 */
const config = readConfig();
if (config.authMode !== 'mailbox' || !config.secrets) {
  console.error('users-cli requires AUTH_MODE=mailbox with a configuration');
  process.exit(2);
}
if (config.storage !== 'sqlite') {
  console.error('users-cli supports the SQLite storage only');
  process.exit(2);
}
const auth = new MailboxAuth({
  baseUrl: config.baseUrl,
  secrets: mailboxSecretSchema.parse(config.secrets),
  db: new SqliteStore(config.sqlitePath),
  accessMode: config.accessMode,
});
const [command, argument] = process.argv.slice(2);
if (command === 'list') {
  const users = await auth.listUsers();
  console.log(users.length ? users.map((u) => u.email).join('\n') : '(no users yet)');
} else if (command === 'remove' && argument) {
  await auth.removeUser(argument.toLowerCase());
  console.log('removed ' + argument.toLowerCase());
} else {
  console.error('usage: users-cli.js list | remove <email>');
  process.exit(2);
}
