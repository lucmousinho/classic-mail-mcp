import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, createHmac } from 'node:crypto';

/**
 * Per-user mailbox passwords at rest (mailbox mode). AES-256-GCM with a key derived from the
 * operator's encryptionKey; the associated data binds a ciphertext to one subject so a record
 * copied onto another user cannot be opened. Rotating encryptionKey invalidates every seal, and
 * everyone signs in again (the design accepts that over keeping an unlocked key around).
 */
const key = (secret: string) =>
  Buffer.from(hkdfSync('sha256', secret, 'classic-mail-mcp', 'user-credential-v1', 32));

export function seal(secret: string, subject: string, plaintext: string) {
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key(secret), iv);
  cipher.setAAD(Buffer.from(subject));
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}

export function open(secret: string, subject: string, sealed: string) {
  const buf = Buffer.from(sealed, 'base64url');
  if (buf.length < 29) throw new Error('Sealed value too short');
  const decipher = createDecipheriv('aes-256-gcm', key(secret), buf.subarray(0, 12));
  decipher.setAAD(Buffer.from(subject));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
}

/** Stable, non-reversible subject for an email address; doubles as an account ID (hex, 32 chars). */
export function subjectFor(secret: string, email: string) {
  return createHmac('sha256', key(secret))
    .update(email.trim().toLowerCase())
    .digest('hex')
    .slice(0, 32);
}
