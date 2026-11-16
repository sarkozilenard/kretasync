import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { client, closeDb, db, icsPath, register, resetDb } from './helpers';
import { addDays, budapestDate } from '../src/time';

const call = client();
const today = budapestDate();
const raw = (uid: string, name: string, off: number, extra: Record<string, unknown> = {}) => ({
  Uid: uid, Nev: name, Oraszam: 1, KezdetIdopont: `${addDays(today, off)}T08:00:00Z`, VegIdopont: `${addDays(today, off)}T08:45:00Z`,
  TeremNeve: '101', TanarNeve: 'Kiss Anna', HelyettesTanarNeve: null, Tipus: { Nev: 'TanitasiOra' }, Allapot: { Nev: 'Megtartott' }, ...extra,
});
const push = (token: string, items: unknown[], extra: Record<string, unknown> = {}, ip = '10.7.0.1') =>
  call('POST', '/api/relay/push', { from: today, to: addDays(today, 14), items, ...extra }, undefined, { authorization: `Bearer ${token}`, 'x-real-ip': ip });

describe('relay mód (magyar IP-ről futó script tölti fel az órarendet)', () => {
  beforeAll(resetDb);
  afterAll(closeDb);
  let a: { cookie: string; calendarUrl: string }, b: { cookie: string; calendarUrl: string }, tokenA: string, tokenB: string;

  it('token létrehozása: csak hash tárolva, bejelentkezés kell', async () => {
    a = await register(call, 'ra@example.com', '10.7.1.1'); b = await register(call, 'rb@example.com', '10.7.1.2');
    expect((await call('POST', '/api/relay/token', {})).status).toBe(401);
    const r = await call('POST', '/api/relay/token', {}, a.cookie); expect(r.status).toBe(200);
    tokenA = r.data.token; tokenB = (await call('POST', '/api/relay/token', {}, b.cookie)).data.token;
    expect(tokenA).toMatch(/^[\w-]{43}$/); expect(tokenA).not.toBe(tokenB);
    expect((await db()`select token_hash from relay_tokens`).some((x) => x.token_hash === tokenA)).toBe(false);
  });

  it('érvénytelen vagy hiányzó token elutasítva', async () => {
    expect((await push('x'.repeat(43), [])).status).toBe(401);
    expect((await push('rovid', [])).status).toBe(401);
    expect((await call('POST', '/api/relay/push', { from: today, to: today, items: [] })).status).toBe(401);
  });

  it('feltöltés: átalakítja, az elmaradtat kiszűri, az ICS-ben megjelenik', async () => {
    const r = await push(tokenA, [raw('u1', 'Matematika', 1), raw('u2', 'Fizika', 2), raw('u3', 'Ének', 2, { Allapot: { Nev: 'Elmaradt' } }), raw('x', 'Szünet', 2, { Tipus: { Nev: 'Egyeb' } })]);
    expect(r.status).toBe(200); expect(r.data.lessons).toBe(2);
    const ics = (await call('GET', icsPath(a.calendarUrl))).text;
    expect((ics.match(/BEGIN:VEVENT/g) || []).length).toBe(2); expect(ics).toContain('UID:u1@kretasync'); expect(ics).not.toContain('Ének');
    const d = await call('GET', '/api/dashboard', undefined, a.cookie);
    expect(d.data.relay).toMatchObject({ enabled: true, lastLessons: 2 }); expect(d.data.relay.lastPushAt).toBeTruthy();
    expect(d.data.upcoming.length).toBe(2);
  });

  it('újabb feltöltés: módosult óra nem duplikálódik, a hiányzó törlődik', async () => {
    await push(tokenA, [raw('u1', 'Matematika', 1, { TeremNeve: '202', HelyettesTanarNeve: 'Nagy Béla' })]);
    const ics = (await call('GET', icsPath(a.calendarUrl))).text.replace(/\r\n /g, '');
    expect((ics.match(/BEGIN:VEVENT/g) || []).length).toBe(1); expect(ics).toContain('LOCATION:202'); expect(ics).toContain('Nagy Béla'); expect(ics).not.toContain('u2@');
  });

  it('felhasználók elkülönülnek: A tokenje nem ír B órarendjébe', async () => {
    expect((await call('GET', icsPath(b.calendarUrl))).text).not.toContain('BEGIN:VEVENT');
    await push(tokenB, [raw('b1', 'Biológia', 3)], {}, '10.7.0.2');
    expect((await call('GET', icsPath(b.calendarUrl))).text).toContain('UID:b1@kretasync');
    expect((await call('GET', icsPath(a.calendarUrl))).text).not.toContain('b1@kretasync');
  });

  it('veszélyes időszakok és hibás adat elutasítva; a régi órák nem törölhetők', async () => {
    await db()`insert into lessons (user_id, external_id, lesson_name, start_date, end_date) select user_id, 'old', 'Régi', ${addDays(today, -20) + ' 08:00'}, ${addDays(today, -20) + ' 08:45'} from relay_tokens limit 1`;
    expect((await push(tokenA, [], { from: addDays(today, -20), to: today })).status).toBe(400);
    expect((await push(tokenA, [], { from: today, to: addDays(today, 200) })).status).toBe(400);
    expect((await push(tokenA, [], { from: today, to: 'nemdatum' })).status).toBe(400);
    expect((await push(tokenA, 'nem-tomb' as any)).status).toBe(400);
    expect((await push(tokenA, [{ Tipus: { Nev: 'TanitasiOra' }, KezdetIdopont: 'rossz', VegIdopont: 'rossz', Nev: 'x' }])).status).toBe(400);
    expect((await db()`select count(*)::int n from lessons where external_id = 'old'`)[0].n).toBe(1);
  });

  it('token újragenerálása érvényteleníti a régit; kikapcsolás törli a tokent', async () => {
    const fresh = (await call('POST', '/api/relay/token', {}, a.cookie)).data.token;
    expect((await push(tokenA, [])).status).toBe(401);
    expect((await push(fresh, [])).status).toBe(200);
    expect((await call('DELETE', '/api/relay/token', undefined, a.cookie)).status).toBe(200);
    expect((await push(fresh, [])).status).toBe(401);
    expect((await call('GET', '/api/dashboard', undefined, a.cookie)).data.relay.enabled).toBe(false);
  });
});
