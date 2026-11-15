import { randomBytes, createHash, scrypt, timingSafeEqual, createCipheriv, createDecipheriv } from 'node:crypto';
import { env } from './env';
import { ConfigError } from './db';

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

// scrypt (N=2^15, r=8, p=1) – OWASP által elfogadott paraméterek; Vercel Node futtatókörnyezetben nincs 10 ms-os CPU-korlát.
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };
function scryptAsync(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((res, rej) => scrypt(password.normalize('NFKC'), salt, 64, SCRYPT, (e, k) => (e ? rej(e) : res(k))));
}

export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt);
  return { hash: hash.toString('base64'), salt: salt.toString('base64') };
}

export async function verifyPassword(password: string, hashB64: string, saltB64: string) {
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scryptAsync(password, Buffer.from(saltB64, 'base64'));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function key(): Buffer {
  const k = env.encryptionKey;
  if (!/^[0-9a-fA-F]{64}$/.test(k)) {
    throw new ConfigError('Az ENCRYPTION_KEY hiányzik vagy érvénytelen (64 hexadecimális karakter kell: openssl rand -hex 32).');
  }
  return Buffer.from(k, 'hex');
}

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}

export function decrypt(blob: string): string {
  const [iv, tag, enc] = blob.split('.').map((p) => Buffer.from(p, 'base64'));
  const d = createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}
