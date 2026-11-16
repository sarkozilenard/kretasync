import { createHash } from 'node:crypto';
import { randomToken } from '../crypto';
import { budapestLocal } from '../time';

/**
 * KRÉTA-kliens a kreta.py folyamata szerint: az iOS diákalkalmazás kliensazonosítójával, az idp.e-kreta.hu
 * űrlapos bejelentkezésén át szerez tokent, majd a /ellenorzo/v3/Sajat/OrarendElemek végpontot kérdezi.
 * FIGYELEM: ez nem dokumentált, nem hivatalosan engedélyezett hozzáférés; a KRÉTA bármikor megváltoztathatja.
 * A felhasználó jelszavát csak a belépéshez használjuk, nem tároljuk és nem naplózzuk.
 */

export class KretaAuthError extends Error {}   // hibás adatok / lejárt refresh token → újra kell csatlakozni
export class KretaError extends Error {}       // átmeneti vagy váratlan hiba

export interface KretaLesson {
  external_id: string;
  lesson_name: string;
  start_date: string;
  end_date: string;
  lesson_index: number | null;
  classroom_name: string | null;
  teacher_name: string | null;
  substitute_teacher_name: string | null;
}

export interface Tokens { access_token: string; refresh_token: string }

export interface KretaApi {
  login(username: string, password: string, instituteCode: string): Promise<Tokens>;
  refresh(refreshToken: string, instituteCode: string): Promise<Tokens>;
  getLessons(accessToken: string, instituteCode: string, from: string, to: string, timesAreUtc?: boolean): Promise<KretaLesson[]>;
}

const IDP = 'https://idp.e-kreta.hu';
const CLIENT_ID = 'kreta-ellenorzo-student-mobile-ios';
const REDIRECT_URI = 'https://mobil.e-kreta.hu/ellenorzo-student/prod/oauthredirect';
const SCOPE = ['openid', 'email', 'offline_access', 'kreta-ellenorzo-webapi.public', 'kreta-eugyintezes-webapi.public',
  'kreta-fileservice-webapi.public', 'kreta-mobile-global-webapi.public', 'kreta-dkt-webapi.public', 'kreta-ier-webapi.public'].join(' ');
// A kreta.py pontosan így küld kéréseket: csak a bejelentkezési POST kap böngésző User-Agentet,
// a többi a Python `requests` alapértelmezett fejléceit használja.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const PY_HEADERS = { 'user-agent': 'python-requests/2.32.3', 'accept-encoding': 'gzip, deflate', accept: '*/*', connection: 'keep-alive' };

type FetchFn = typeof fetch;

export function assertInstituteCode(code: string) {
  if (!/^[a-z0-9]{3,40}$/i.test(code)) throw new KretaAuthError('Érvénytelen intézménykód (klik azonosító).');
}

class CookieJar {
  private c = new Map<string, string>();
  store(res: Response) {
    for (const sc of res.headers.getSetCookie?.() ?? []) {
      const [pair] = sc.split(';'); const i = pair.indexOf('=');
      if (i > 0) this.c.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }
  header() { return [...this.c].map(([k, v]) => `${k}=${v}`).join('; '); }
}

export function createKretaClient(fetchImpl: FetchFn = fetch): KretaApi {
  const req = async (url: string, init: RequestInit & { jar?: CookieJar } = {}) => {
    const headers = new Headers(init.headers);
    if (init.jar?.header()) headers.set('cookie', init.jar.header());
    let res: Response;
    try {
      res = await fetchImpl(url, { ...init, headers, redirect: 'manual', signal: AbortSignal.timeout(20_000) });
    } catch (error) {
      const cause = error instanceof Error ? error.cause : undefined;
      const causeCode = typeof cause === 'object' && cause !== null && 'code' in cause && typeof cause.code === 'string'
        ? cause.code
        : undefined;
      const endpoint = new URL(url);
      console.error('KRÉTA request failed', {
        host: endpoint.host,
        path: endpoint.pathname,
        errorName: error instanceof Error ? error.name : 'UnknownError',
        causeCode,
      });
      // hálózati hiba/időtúllépés; a régió és a hibakód nem érzékeny adat, de megmutatja, hol akad el a kapcsolat
      throw new KretaError(`A KRÉTA jelenleg nem érhető el (szerver: ${process.env.VERCEL_REGION || 'helyi'}, hiba: ${causeCode ?? (error instanceof Error ? error.name : 'ismeretlen')}).`);
    }
    init.jar?.store(res);
    return res;
  };

  const getFollow = async (url: string, jar: CookieJar) => {
    let res = await req(url, { jar, headers: PY_HEADERS });
    for (let i = 0; i < 5 && res.status >= 300 && res.status < 400 && res.headers.get('location'); i++) {
      res = await req(new URL(res.headers.get('location')!, url).toString(), { jar, headers: PY_HEADERS });
    }
    return res;
  };

  const tokenRequest = async (body: Record<string, string>): Promise<Tokens> => {
    const res = await req(`${IDP}/connect/token`, {
      method: 'POST', headers: { ...PY_HEADERS, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString(),
    });
    if (res.status === 400 || res.status === 401) throw new KretaAuthError('A KRÉTA elutasította a hozzáférést (lejárt vagy érvénytelen token).');
    if (!res.ok) throw new KretaError(`KRÉTA token-végpont hiba (${res.status}).`);
    const j = (await res.json()) as Partial<Tokens>;
    if (!j.access_token || !j.refresh_token) throw new KretaError('A KRÉTA válasza nem tartalmaz tokent.');
    return { access_token: j.access_token, refresh_token: j.refresh_token };
  };

  return {
    async refresh(refreshToken, instituteCode) {
      assertInstituteCode(instituteCode);
      return tokenRequest({ refresh_token: refreshToken, institute_code: instituteCode, client_id: CLIENT_ID, grant_type: 'refresh_token' });
    },

    async login(username, password, instituteCode) {
      assertInstituteCode(instituteCode);
      const jar = new CookieJar();
      const verifier = randomToken(32);
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      const q: [string, string][] = [
        ['prompt', 'login'], ['nonce', randomToken(24)], ['response_type', 'code'], ['code_challenge_method', 'S256'],
        ['scope', SCOPE], ['code_challenge', challenge], ['redirect_uri', REDIRECT_URI], ['client_id', CLIENT_ID],
        ['state', 'kreten_student_mobile'], ['suppressed_prompt', 'login'],
      ];
      const callbackPath = '/connect/authorize/callback?' + q.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

      const page = await getFollow(`${IDP}/Account/Login?ReturnUrl=${encodeURIComponent(callbackPath)}`, jar);
      if (!page.ok) throw new KretaError(`A KRÉTA bejelentkezési oldala nem érhető el (${page.status}).`);
      const html = await page.text();
      const m = html.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/) || html.match(/value="([^"]+)"[^>]*name="__RequestVerificationToken"/);
      if (!m) throw new KretaError('A KRÉTA bejelentkezési oldalának szerkezete megváltozott (hiányzik az ellenőrző token).');

      const form = new URLSearchParams({
        ReturnUrl: callbackPath, IsTemporaryLogin: 'False', UserName: username, Password: password,
        InstituteCode: instituteCode, loginType: 'InstituteLogin', __RequestVerificationToken: m[1],
      });
      const post = await req(`${IDP}/account/login`, {
        method: 'POST', jar, body: form.toString(),
        headers: { 'user-agent': UA, 'content-type': 'application/x-www-form-urlencoded' },
      });
      // Sikeres belépés → átirányítás; ha az űrlap 200-zal újra megjelenik, az adatok hibásak.
      if (post.status < 300 || post.status >= 400) throw new KretaAuthError('Hibás KRÉTA-felhasználónév, jelszó vagy intézménykód.');

      const cb = await req(`${IDP}${callbackPath}`, { jar, headers: PY_HEADERS });
      const loc = cb.headers.get('location');
      const code = loc ? new URL(loc, IDP).searchParams.get('code') : null;
      if (!code) throw new KretaAuthError('A KRÉTA bejelentkezés nem adott engedélyezési kódot.');

      return tokenRequest({ code, code_verifier: verifier, redirect_uri: REDIRECT_URI, client_id: CLIENT_ID, grant_type: 'authorization_code' });
    },

    async getLessons(accessToken, instituteCode, from, to, timesAreUtc = false) {
      assertInstituteCode(instituteCode);
      const url = `https://${instituteCode}.e-kreta.hu/ellenorzo/v3/Sajat/OrarendElemek?` + new URLSearchParams({ datumTol: from, datumIg: to });
      const res = await req(url, { headers: { ...PY_HEADERS, authorization: `Bearer ${accessToken}` } });
      if (res.status === 401 || res.status === 403) throw new KretaAuthError('A KRÉTA elutasította a hozzáférési tokent.');
      if (!res.ok) throw new KretaError(`Az órarend lekérése sikertelen (${res.status}).`);
      return convertLessons(await res.json(), timesAreUtc);
    },
  };
}

function localTime(iso: string, timesAreUtc: boolean): string {
  if (timesAreUtc) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) throw new KretaError('Érvénytelen időpont a KRÉTA válaszában.');
    return budapestLocal(d);
  }
  // kreta.py: az időpont a megadott órával, időzóna-átváltás nélkül kerül tárolásra
  const m = iso.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/);
  if (!m) throw new KretaError('Érvénytelen időpont a KRÉTA válaszában.');
  return `${m[1]} ${m[2]}`;
}

/** A kreta.py convert_lessons logikája; kiegészítve stabil azonosítóval és az elmaradt órák kiszűrésével. */
export function convertLessons(json: unknown, timesAreUtc = false): KretaLesson[] {
  if (!Array.isArray(json)) throw new KretaError('Váratlan válaszformátum az órarendnél.');
  const out: KretaLesson[] = [];
  for (const item of json as any[]) {
    const type = item?.Tipus?.Nev;
    if (type !== 'TanitasiOra' && type !== 'OrarendiOra') continue;
    if (item?.Allapot?.Nev === 'Elmaradt') continue; // elmaradó óra: nem kerül a naptárba
    const start = localTime(String(item.KezdetIdopont), timesAreUtc);
    const end = localTime(String(item.VegIdopont), timesAreUtc);
    const name = String(item.Nev ?? item.Tantargy?.Nev ?? 'Tanóra');
    const idx = Number.isFinite(Number(item.Oraszam)) ? Number(item.Oraszam) : null;
    const external_id = String(item.Uid ?? item.Id ?? createHash('sha1').update(`${start}|${idx}|${name}`).digest('hex'));
    out.push({
      external_id, lesson_name: name, start_date: start, end_date: end, lesson_index: idx,
      classroom_name: item.TeremNeve ?? null, teacher_name: item.TanarNeve ?? null,
      substitute_teacher_name: item.HelyettesTanarNeve ?? null,
    });
  }
  out.sort((a, b) => a.start_date.slice(0, 10).localeCompare(b.start_date.slice(0, 10)) || (a.lesson_index ?? 0) - (b.lesson_index ?? 0));
  return out;
}

/** Diagnosztika: eléri-e a szerver (ebből a régióból) a KRÉTA bejelentkezési oldalát? Nem küld adatot. */
export async function pingIdp(fetchImpl: FetchFn = fetch) {
  const t0 = Date.now();
  const region = process.env.VERCEL_REGION || 'ismeretlen (helyi)';
  try {
    const res = await fetchImpl(`${IDP}/Account/Login`, { headers: PY_HEADERS, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    return { region, reachable: true, status: res.status, ms: Date.now() - t0 };
  } catch (error) {
    const cause = error instanceof Error ? (error.cause as { code?: string } | undefined) : undefined;
    return { region, reachable: false, errorCode: cause?.code ?? (error instanceof Error ? error.name : 'UnknownError'), ms: Date.now() - t0 };
  }
}
