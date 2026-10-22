// Guard the distributable file set, including untracked source. Never print matching content.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const skip = new Set([
  'node_modules',
  'dist',
  '.git',
  '.secrets',
  '.data',
  'data',
  'coverage',
  '__pycache__',
]);
const forbidden = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /GOCSPX-[A-Za-z0-9_-]{20,}/,
  /AIza[A-Za-z0-9_-]{30,}/,
  /gh[pousr]_[A-Za-z0-9]{30,}/,
  /[0-9]{10,}-[a-z0-9]{25,}\.apps\.googleusercontent\.com/,
  // Company domains of this fork are documentation placeholders, not private addresses.
  /[a-z0-9._%+-]+@(?!example\.(?:com|org|net)\b|mamboo\.co\.(?:ao|tz)\b|mambootech\.com\b)[a-z0-9.-]+\.[a-z]{2,}/i,
];
let failed = false;
function scan(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (
      skip.has(e.name) ||
      e.name.startsWith('.env') ||
      e.name.endsWith('.sqlite') ||
      e.name === '.DS_Store'
    )
      continue;
    const path = join(dir, e.name);
    if (e.isDirectory()) {
      scan(path);
      continue;
    }
    if (
      e.name.endsWith('.png') ||
      e.name === 'package-lock.json' ||
      path.endsWith('scripts/check-public.mjs')
    )
      continue;
    const text = readFileSync(path, 'utf8');
    if (forbidden.some((pattern) => pattern.test(text))) {
      console.error('Review possible private content in ' + path);
      failed = true;
    }
  }
}
scan('.');
if (failed) process.exit(1);
console.log('Public source scan passed. Also review the staged diff before publishing.');
