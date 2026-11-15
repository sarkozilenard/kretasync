import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from '../src/app';
import { closeDb, db } from '../src/db';
import type { KretaApi, KretaLesson } from '../src/kreta/client';
import { addDays, budapestDate } from '../src/time';

export async function resetDb() {
  const sql = db();
  await sql.unsafe('drop schema public cascade; create schema public;');
  await sql.unsafe(readFileSync(join(__dirname, '..', 'migrations', '001_init.sql'), 'utf8'));
}
export { closeDb, db };

export class FakeKreta implements KretaApi {
  lessons: KretaLesson[] = [];
  loginCalls: { username: string; password: string }[] = [];
  refreshCounter = 0;
  failAuth = false;
  async login(username: string, password: string) {
    this.loginCalls.push({ username, password });
    if (password === 'rossz') { const { KretaAuthError } = await import('../src/kreta/client'); throw new KretaAuthError('Hibás KRÉTA-felhasználónév, jelszó vagy intézménykód.'); }
    return { access_token: 'acc', refresh_token: 'refresh-0' };
  }
  async refresh() {
    if (this.failAuth) { const { KretaAuthError } = await import('../src/kreta/client'); throw new KretaAuthError('lejárt'); }
    return { access_token: 'acc', refresh_token: `refresh-${++this.refreshCounter}` };
  }
  async getLessons() { return this.lessons.map((l) => ({ ...l })); }
}

export const soon = (offsetDays: number, hh = '08:00', hh2 = '08:45') => {
  const d = addDays(budapestDate(), offsetDays);
  return { start_date: `${d} ${hh}`, end_date: `${d} ${hh2}` };
};

export const lesson = (id: string, name: string, offsetDays: number, extra: Partial<KretaLesson> = {}): KretaLesson => ({
  external_id: id, lesson_name: name, ...soon(offsetDays), lesson_index: 1, classroom_name: '101', teacher_name: 'Kiss Anna', substitute_teacher_name: null, ...extra,
});

export function client(kreta: KretaApi = new FakeKreta()) {
  const app = createApp({ kreta });
  return async (method: string, path: string, body?: unknown, cookie?: string, extra: Record<string, string> = {}) => {
    const headers: Record<string, string> = { 'x-requested-with': 'kretasync', 'content-type': 'application/json', 'x-real-ip': extra['x-real-ip'] || '10.0.0.1', ...extra };
    if (cookie) headers.cookie = cookie;
    const res = await app(new Request(`https://kretasync.test${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
    const sc = res.headers.getSetCookie()[0]?.split(';')[0];
    const text = await res.text();
    let data: any = text; try { data = JSON.parse(text); } catch { /* nem JSON */ }
    return { status: res.status, data, cookie: sc, headers: res.headers, text };
  };
}

export const PW = 'Titkos-jelszo-123';
export async function register(call: ReturnType<typeof client>, email: string, ip = '10.0.0.1') {
  const r = await call('POST', '/api/register', { email, password: PW, passwordConfirm: PW, acceptPrivacy: true }, undefined, { 'x-real-ip': ip });
  if (r.status !== 201) throw new Error(`register failed ${r.status} ${JSON.stringify(r.data)}`);
  return { cookie: r.cookie!, calendarUrl: r.data.calendarUrl as string };
}
export const icsPath = (url: string) => '/api/calendar-ics?token=' + new URL(url).pathname.replace('/calendar/', ''); // a vercel.json rewrite megfelelője
