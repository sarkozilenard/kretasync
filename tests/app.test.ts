import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { client, closeDb, db, FakeKreta, icsPath, lesson, PW, register, resetDb } from './helpers';

const kreta = new FakeKreta();
const call = client(kreta);

beforeAll(resetDb);
afterAll(closeDb);

describe('fiók és munkamenet', () => {
  it('1. új felhasználó regisztrál', async () => {
    const r = await call('POST', '/api/register', { email: 'Anna@Example.com', password: PW, passwordConfirm: PW, acceptPrivacy: true });
    expect(r.status).toBe(201);
    expect(r.data.calendarUrl).toMatch(/^https:\/\/kretasync\.test\/calendar\/[\w-]{43}\.ics$/);
    const set = r.headers.getSetCookie()[0];
    expect(set).toMatch(/HttpOnly/); expect(set).toMatch(/SameSite=Lax/); expect(set).toMatch(/Secure/);
    const [u] = await db()`select password_hash, password_salt from users where email = 'anna@example.com'`;
    expect(u.password_hash).not.toContain(PW); expect(u.password_salt.length).toBeGreaterThan(10);
  });

  it('2. ugyanazzal az e-mail-címmel nem lehet második fiók', async () => {
    const r = await call('POST', '/api/register', { email: 'anna@example.com', password: PW, passwordConfirm: PW, acceptPrivacy: true });
    expect(r.status).toBe(409);
  });

  it('regisztráció bemenet-ellenőrzés', async () => {
    const bad = [
      { email: 'nem-email', password: PW, passwordConfirm: PW, acceptPrivacy: true },
      { email: 'x@y.hu', password: 'rovid', passwordConfirm: 'rovid', acceptPrivacy: true },
      { email: 'x@y.hu', password: PW, passwordConfirm: PW + 'x', acceptPrivacy: true },
      { email: 'x@y.hu', password: PW, passwordConfirm: PW, acceptPrivacy: false },
    ];
    for (const b of bad) expect((await call('POST', '/api/register', b)).status).toBe(400);
  });

  it('3. hibás jelszóval nem lehet belépni, jó jelszóval igen', async () => {
    expect((await call('POST', '/api/login', { email: 'anna@example.com', password: 'hibas-jelszo-1' })).status).toBe(401);
    expect((await call('POST', '/api/login', { email: 'nincs@example.com', password: 'hibas-jelszo-1' })).status).toBe(401);
    const ok = await call('POST', '/api/login', { email: 'ANNA@example.com', password: PW });
    expect(ok.status).toBe(200);
    expect((await call('GET', '/api/me', undefined, ok.cookie)).data.user.email).toBe('anna@example.com');
  });

  it('4. kijelentkezés után a védett végpontok nem érhetők el', async () => {
    const { cookie } = await register(call, 'logout@example.com', '10.0.0.2');
    expect((await call('GET', '/api/dashboard', undefined, cookie)).status).toBe(200);
    expect((await call('POST', '/api/logout', {}, cookie)).status).toBe(200);
    for (const [m, p] of [['GET', '/api/me'], ['GET', '/api/dashboard'], ['POST', '/api/sync'], ['POST', '/api/calendar/rotate'], ['DELETE', '/api/kreta/disconnect']]) {
      expect((await call(m, p, m === 'GET' ? undefined : {}, cookie)).status).toBe(401);
    }
    expect((await call('GET', '/api/dashboard')).status).toBe(401);
  });

  it('CSRF: fejléc nélküli módosító kérés elutasítva; idegen Origin is', async () => {
    const { cookie } = await register(call, 'csrf@example.com', '10.0.0.3');
    const bare = await fetchRaw('POST', '/api/logout', cookie, {});
    expect(bare).toBe(403);
    expect(await fetchRaw('POST', '/api/logout', cookie, { 'x-requested-with': 'kretasync', origin: 'https://evil.example' })).toBe(403);
  });

  it('jelszó módosítása és a fiók törlése', async () => {
    const { cookie } = await register(call, 'del@example.com', '10.0.0.4');
    expect((await call('POST', '/api/password/change', { currentPassword: 'rossz-jelszo-1', newPassword: 'Uj-jelszo-12345' }, cookie)).status).toBe(403);
    expect((await call('POST', '/api/password/change', { currentPassword: PW, newPassword: 'Uj-jelszo-12345' }, cookie)).status).toBe(200);
    expect((await call('POST', '/api/login', { email: 'del@example.com', password: 'Uj-jelszo-12345' })).status).toBe(200);
    expect((await call('DELETE', '/api/account', { password: 'rossz-jelszo-1' }, cookie)).status).toBe(403);
    expect((await call('DELETE', '/api/account', { password: 'Uj-jelszo-12345' }, cookie)).status).toBe(200);
    const [n] = await db()`select count(*)::int as n from users where email = 'del@example.com'`;
    expect(n.n).toBe(0);
    expect((await call('GET', '/api/me', undefined, cookie)).status).toBe(401);
  });

  it('rate limit: sok hibás belépés után 429', async () => {
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await call('POST', '/api/login', { email: 'brute@example.com', password: 'hibas-jelszo-1' })).status;
    expect(last).toBe(429);
  });
});

async function fetchRaw(method: string, path: string, cookie: string, headers: Record<string, string>) {
  const { createApp } = await import('../src/app');
  const res = await createApp()(new Request(`https://kretasync.test${path}`, { method, headers: { cookie, ...headers }, body: '{}' }));
  return res.status;
}

describe('naptár és szinkron', () => {
  let a: { cookie: string; calendarUrl: string };
  let b: { cookie: string; calendarUrl: string };

  beforeAll(async () => {
    a = await register(call, 'a@example.com', '10.1.0.1');
    b = await register(call, 'b@example.com', '10.1.0.2');
  });

  it('6. minden felhasználó külön ICS-linket kap; a token csak hash-elve van tárolva', async () => {
    expect(a.calendarUrl).not.toBe(b.calendarUrl);
    const token = a.calendarUrl.split('/').pop()!.replace('.ics', '');
    const rows = await db()`select token_hash from calendars`;
    expect(rows.some((r) => r.token_hash === token)).toBe(false);
    const sess = await db()`select token_hash from sessions`;
    expect(sess.some((r) => a.cookie.includes(r.token_hash))).toBe(false);
  });

  it('KRÉTA-kapcsolat: jelszó nem kerül tárolásra, refresh token titkosítva', async () => {
    expect((await call('POST', '/api?__route=kreta/connect', { username: 'diak', password: 'rossz', instituteCode: 'klik011111111' }, a.cookie)).status).toBe(401);
    expect((await call('POST', '/api/kreta/connect', { username: 'diak', password: 'x', instituteCode: 'evil.com/x' }, a.cookie)).status).toBe(401);
    kreta.lessons = [lesson('L1', 'Matematika', 1), lesson('L2', 'Történelem', 1, { start_date: soonD(1, '09:00'), end_date: soonD(1, '09:45'), lesson_index: 2 }), lesson('L3', 'Fizika', 2)];
    const r = await call('POST', '/api/kreta/connect', { username: 'diak', password: 'Sz3cr3t-kreta', instituteCode: 'klik011111111' }, a.cookie);
    expect(r.status).toBe(200); expect(r.data.sync.ok).toBe(true); expect(r.data.sync.lessons).toBe(3);
    const [c] = await db()`select * from kreta_connections`;
    const dump = JSON.stringify(c) + JSON.stringify(await db()`select * from users`) + JSON.stringify(await db()`select * from sync_logs`);
    expect(dump).not.toContain('Sz3cr3t-kreta');
    expect(c.refresh_token_enc).not.toContain('refresh-');
    expect(c.refresh_token_enc.split('.')).toHaveLength(3);
    expect(c.refresh_token_enc).not.toBe('refresh-1');
  });

  it('8. az ICS érvényes szerkezetű, Europe/Budapest időzónával', async () => {
    const r = await call('GET', icsPath(a.calendarUrl));
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/calendar');
    const t = r.text;
    expect(t.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true); expect(t.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(t).toContain('X-WR-CALNAME:KrétaSync – Órarend'); expect(t).toContain('BEGIN:VTIMEZONE'); expect(t).toContain('TZID:Europe/Budapest');
    expect((t.match(/BEGIN:VEVENT/g) || []).length).toBe(3);
    expect(t).toMatch(/DTSTART;TZID=Europe\/Budapest:\d{8}T\d{6}/);
    expect(t).toContain('SUMMARY:1. Matematika'); expect(t).toContain('LOCATION:101'); expect(t).toContain('Tanár: Kiss Anna');
    for (const line of t.split('\r\n')) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    expect(new Set(t.match(/^UID:.*$/gm)).size).toBe(3);
  });

  it('9. módosult óra nem duplikálódik, az UID stabil; helyettesítés megjelenik', async () => {
    const before = (await call('GET', icsPath(a.calendarUrl))).text.match(/UID:L1@kretasync/g)!.length;
    kreta.lessons[0] = { ...kreta.lessons[0], classroom_name: '202', substitute_teacher_name: 'Nagy Béla', ...soon2(1, '10:00', '10:45') };
    const r = await call('POST', '/api/sync', {}, a.cookie);
    expect(r.status).toBe(200);
    const t = (await call('GET', icsPath(a.calendarUrl))).text;
    expect((t.match(/BEGIN:VEVENT/g) || []).length).toBe(3);
    expect(before).toBe(1); expect((t.match(/UID:L1@kretasync/g) || []).length).toBe(1);
    const u = t.replace(/\r\n /g, ''); // RFC 5545 unfold
    expect(u).toContain('LOCATION:202'); expect(u).toContain('helyettesítés'); expect(u).toContain('Helyettesítő tanár: Nagy Béla'); expect(u).toContain('T100000');
    const [{ n }] = await db()`select count(*)::int n from lessons where external_id = 'L1'`;
    expect(n).toBe(1);
  });

  it('10. elmaradó óra eltávolításra kerül', async () => {
    kreta.lessons = kreta.lessons.filter((l) => l.external_id !== 'L3');
    await call('POST', '/api/sync', {}, a.cookie);
    const t = (await call('GET', icsPath(a.calendarUrl))).text;
    expect(t).not.toContain('UID:L3@kretasync'); expect((t.match(/BEGIN:VEVENT/g) || []).length).toBe(2);
  });

  it('5. felhasználók adatai elkülönülnek', async () => {
    const tb = (await call('GET', icsPath(b.calendarUrl))).text;
    expect((tb.match(/BEGIN:VEVENT/g) || []).length).toBe(0);
    const d = await call('GET', '/api/dashboard', undefined, b.cookie);
    expect(d.data.upcoming).toHaveLength(0); expect(d.data.kreta.connected).toBe(false);
    expect((await call('GET', '/api/dashboard', undefined, a.cookie)).data.upcoming.length).toBe(2);
    expect((await call('POST', '/api/sync', {}, b.cookie)).status).toBe(409);
    // B saját kapcsolata nem érinti A óráit
    await call('POST', '/api/kreta/connect', { username: 'masik', password: 'x', instituteCode: 'klik022222222' }, b.cookie);
    expect((await call('GET', icsPath(a.calendarUrl))).text).toContain('UID:L1@kretasync');
  });

  it('7. a régi ICS-link újragenerálás után érvénytelen', async () => {
    const oldPath = icsPath(a.calendarUrl);
    expect((await call('GET', oldPath)).status).toBe(200);
    const r = await call('POST', '/api/calendar/rotate', {}, a.cookie);
    expect(r.status).toBe(200);
    expect((await call('GET', oldPath)).status).toBe(404);
    const fresh = await call('GET', icsPath(r.data.calendarUrl));
    expect(fresh.status).toBe(200); expect(fresh.text).toContain('BEGIN:VEVENT');
    expect((await call('GET', '/api/calendar-ics?token=hamis.ics')).status).toBe(404);
  });

  it('lejárt KRÉTA-hozzáférés: állapot jelzi, a már mentett órák megmaradnak', async () => {
    kreta.failAuth = true;
    const r = await call('POST', '/api/sync', {}, a.cookie);
    expect(r.status).toBe(502);
    const d = await call('GET', '/api/dashboard', undefined, a.cookie);
    expect(d.data.kreta.status).toBe('reauth_required'); expect(d.data.kreta.lastError).toBeTruthy(); expect(d.data.upcoming.length).toBe(2);
    kreta.failAuth = false;
  });

  it('cron: titok nélkül tiltott, megfelelő titokkal szinkronizál', async () => {
    expect((await call('GET', '/api/cron/sync')).status).toBe(401);
    expect((await call('GET', '/api/cron/sync', undefined, undefined, { authorization: 'Bearer rossz' })).status).toBe(401);
    await db()`update kreta_connections set connection_status = 'connected', last_sync_at = now() - interval '2 days'`;
    const r = await call('GET', '/api/cron/sync', undefined, undefined, { authorization: 'Bearer test-cron-secret' });
    expect(r.status).toBe(200); expect(r.data.ok).toBeGreaterThanOrEqual(1);
  });

  it('kapcsolat bontása törli az órákat', async () => {
    expect((await call('DELETE', '/api/kreta/disconnect', undefined, a.cookie)).status).toBe(200);
    const d = await call('GET', '/api/dashboard', undefined, a.cookie);
    expect(d.data.kreta.connected).toBe(false); expect(d.data.upcoming).toHaveLength(0);
  });
});

import { addDays, budapestDate } from '../src/time';
function soonD(off: number, hh: string) { return `${addDays(budapestDate(), off)} ${hh}`; }
function soon2(off: number, s: string, e: string) { const d = addDays(budapestDate(), off); return { start_date: `${d} ${s}`, end_date: `${d} ${e}` }; }
