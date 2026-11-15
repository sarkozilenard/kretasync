import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { convertLessons, createKretaClient, KretaAuthError } from '../src/kreta/client';

/** Szimulált idp.e-kreta.hu + intézményi API: a kreta.py által követett lépéssorrendet ellenőrzi (valódi KRÉTA nélkül). */
function fakeKretaFetch() {
  let challenge = ''; let rvt = 'RVT-123'; const log: string[] = [];
  const fn = (async (input: any, init: any = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const method = init.method || 'GET';
    const headers = new Headers(init.headers);
    log.push(`${method} ${url.host}${url.pathname}`);
    if (url.host === 'idp.e-kreta.hu' && url.pathname === '/Account/Login' && method === 'GET') {
      const ret = new URL(url.searchParams.get('ReturnUrl')!, 'https://idp.e-kreta.hu');
      expect(ret.searchParams.get('client_id')).toBe('kreta-ellenorzo-student-mobile-ios');
      expect(ret.searchParams.get('code_challenge_method')).toBe('S256');
      expect(ret.searchParams.get('scope')).toContain('kreta-ellenorzo-webapi.public');
      challenge = ret.searchParams.get('code_challenge')!;
      return new Response(`<form><input name="__RequestVerificationToken" type="hidden" value="${rvt}" /></form>`, { headers: { 'set-cookie': 'af=cookie1; path=/; httponly' } });
    }
    if (url.pathname === '/account/login' && method === 'POST') {
      const f = new URLSearchParams(init.body);
      expect(headers.get('cookie')).toContain('af=cookie1');
      expect(f.get('__RequestVerificationToken')).toBe(rvt);
      expect(f.get('InstituteCode')).toBe('klik011111111'); expect(f.get('loginType')).toBe('InstituteLogin');
      if (f.get('UserName') === 'diak' && f.get('Password') === 'jo-jelszo') return new Response(null, { status: 302, headers: { location: '/connect/authorize/callback', 'set-cookie': 'idp=sess; path=/' } });
      return new Response('<form>hibás</form>', { status: 200 });
    }
    if (url.pathname === '/connect/authorize/callback') {
      expect(headers.get('cookie')).toContain('idp=sess');
      return new Response(null, { status: 302, headers: { location: 'https://mobil.e-kreta.hu/ellenorzo-student/prod/oauthredirect?code=CODE42&state=kreten_student_mobile' } });
    }
    if (url.pathname === '/connect/token') {
      const f = new URLSearchParams(init.body);
      if (f.get('grant_type') === 'authorization_code') {
        const ok = f.get('code') === 'CODE42' && createHash('sha256').update(f.get('code_verifier')!).digest('base64url') === challenge;
        return ok ? Response.json({ access_token: 'AT1', refresh_token: 'RT1' }) : new Response('{}', { status: 400 });
      }
      if (f.get('grant_type') === 'refresh_token') {
        expect(f.get('institute_code')).toBe('klik011111111');
        return f.get('refresh_token') === 'RT1' ? Response.json({ access_token: 'AT2', refresh_token: 'RT2' }) : new Response('{"error":"invalid_grant"}', { status: 400 });
      }
    }
    if (url.host === 'klik011111111.e-kreta.hu' && url.pathname === '/ellenorzo/v3/Sajat/OrarendElemek') {
      if (headers.get('authorization') !== 'Bearer AT2') return new Response('', { status: 401 });
      expect(url.searchParams.get('datumTol')).toBe('2025-01-06'); expect(url.searchParams.get('datumIg')).toBe('2025-01-19');
      return Response.json(SAMPLE);
    }
    return new Response('unexpected ' + url, { status: 500 });
  }) as typeof fetch;
  return { fn, log };
}

const SAMPLE = [
  { Uid: 'u1', Nev: 'Matematika', Oraszam: 2, KezdetIdopont: '2025-01-07T08:55:00Z', VegIdopont: '2025-01-07T09:40:00Z', TeremNeve: '12', TanarNeve: 'Kiss Anna', HelyettesTanarNeve: null, Tipus: { Nev: 'TanitasiOra' }, Allapot: { Nev: 'Megtartott' } },
  { Uid: 'u0', Nev: 'Magyar', Oraszam: 1, KezdetIdopont: '2025-01-07T08:00:00Z', VegIdopont: '2025-01-07T08:45:00Z', TeremNeve: '3', TanarNeve: 'Nagy Béla', HelyettesTanarNeve: 'Szabó Éva', Tipus: { Nev: 'OrarendiOra' } },
  { Uid: 'u2', Nev: 'Ének', Oraszam: 3, KezdetIdopont: '2025-01-07T10:00:00Z', VegIdopont: '2025-01-07T10:45:00Z', Tipus: { Nev: 'TanitasiOra' }, Allapot: { Nev: 'Elmaradt' } },
  { Uid: 'u3', Nev: 'Ebédszünet', Oraszam: 4, KezdetIdopont: '2025-01-07T11:00:00Z', VegIdopont: '2025-01-07T11:30:00Z', Tipus: { Nev: 'Egyeb' } },
];

describe('KRÉTA-kliens (szimulált IdP)', () => {
  it('belépés → refresh → órarend a kreta.py szerinti lépésekkel', async () => {
    const { fn, log } = fakeKretaFetch();
    const k = createKretaClient(fn);
    const t1 = await k.login('diak', 'jo-jelszo', 'klik011111111');
    expect(t1).toEqual({ access_token: 'AT1', refresh_token: 'RT1' });
    expect(log).toEqual(['GET idp.e-kreta.hu/Account/Login', 'POST idp.e-kreta.hu/account/login', 'GET idp.e-kreta.hu/connect/authorize/callback', 'POST idp.e-kreta.hu/connect/token']);
    const t2 = await k.refresh('RT1', 'klik011111111');
    expect(t2.refresh_token).toBe('RT2');
    const lessons = await k.getLessons(t2.access_token, 'klik011111111', '2025-01-06', '2025-01-19');
    expect(lessons.map((l) => l.external_id)).toEqual(['u0', 'u1']); // rendezve; elmaradt és nem tanítási kiszűrve
    expect(lessons[0]).toMatchObject({ lesson_name: 'Magyar', start_date: '2025-01-07 08:00', end_date: '2025-01-07 08:45', lesson_index: 1, classroom_name: '3', teacher_name: 'Nagy Béla', substitute_teacher_name: 'Szabó Éva' });
  });

  it('hibás jelszó és lejárt refresh token KretaAuthError', async () => {
    const k = createKretaClient(fakeKretaFetch().fn);
    await expect(k.login('diak', 'rossz', 'klik011111111')).rejects.toBeInstanceOf(KretaAuthError);
    await expect(k.refresh('RT-regi', 'klik011111111')).rejects.toBeInstanceOf(KretaAuthError);
  });

  it('az intézménykód nem tud idegen hostra mutatni (SSRF-védelem)', async () => {
    const k = createKretaClient(fakeKretaFetch().fn);
    for (const bad of ['evil.com/x', 'a.b', 'klik@evil', '../x', '']) await expect(k.getLessons('AT', bad, '2025-01-01', '2025-01-02')).rejects.toBeInstanceOf(KretaAuthError);
  });

  it('időpontok: alapból a kreta.py szerint változatlan; UTC módban Budapest-időre váltva (DST)', () => {
    const raw = [{ Uid: 'x', Nev: 'T', Oraszam: 1, KezdetIdopont: '2025-07-01T06:00:00Z', VegIdopont: '2025-07-01T06:45:00Z', Tipus: { Nev: 'TanitasiOra' } }];
    expect(convertLessons(raw)[0].start_date).toBe('2025-07-01 06:00');
    expect(convertLessons(raw, true)[0].start_date).toBe('2025-07-01 08:00'); // CEST
    expect(convertLessons([{ ...raw[0], KezdetIdopont: '2025-01-07T07:00:00Z', VegIdopont: '2025-01-07T07:45:00Z' }], true)[0].start_date).toBe('2025-01-07 08:00'); // CET
  });
});
