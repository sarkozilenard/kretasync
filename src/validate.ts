import { HttpError } from './http';

export function str(v: unknown, name: string, max = 200): string {
  if (typeof v !== 'string' || !v.length || v.length > max) throw new HttpError(400, `Érvénytelen mező: ${name}.`);
  return v;
}

export function email(v: unknown): string {
  const s = str(v, 'e-mail', 254).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s)) throw new HttpError(400, 'Érvénytelen e-mail-cím.');
  return s;
}

export function newPassword(v: unknown): string {
  const s = str(v, 'jelszó', 200);
  if (s.length < 10) throw new HttpError(400, 'A jelszó legalább 10 karakter legyen.');
  return s;
}
