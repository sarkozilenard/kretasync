import { timingSafeEqual } from 'node:crypto';
import { ConfigError, db, Sql } from './db';
import { encrypt, hashPassword, randomToken, sha256, verifyPassword } from './crypto';
import { assertCsrf, clientIp, HttpError, json, parseCookies, readJson, sessionCookie } from './http';
import { rateLimit } from './ratelimit';
import { email as vEmail, newPassword, str } from './validate';
import { env } from './env';
import { sendEmail } from './email';
import { buildIcs } from './ics';
import { assertInstituteCode, createKretaClient, KretaApi, KretaAuthError, KretaError } from './kreta/client';
import { syncDue, syncUser } from './sync';
import { budapestLocal } from './time';

const SESSION_DAYS = 30;
const SESSION_SEC = SESSION_DAYS * 86400;

export interface AppDeps { kreta?: KretaApi }
interface User { id: string; email: string; email_verified_at: string | null }

const origin = (req: Request) => env.appUrl || `${req.headers.get('x-forwarded-proto') || new URL(req.url).protocol.replace(':', '')}://${req.headers.get('x-forwarded-host') || req.headers.get('host') || new URL(req.url).host}`;
const calendarUrl = (req: Request, token: string) => `${origin(req)}/calendar/${token}.ics`;
const DUMMY = hashPassword('dummy-password-for-timing');

async function currentUser(sql: Sql, req: Request): Promise<User | null> {
  const t = parseCookies(req).ks_session;
  if (!t) return null;
  const rows = await sql`
    select u.id, u.email, u.email_verified_at from sessions s join users u on u.id = s.user_id
    where s.token_hash = ${sha256(t)} and s.expires_at > now()`;
  return (rows[0] as User) ?? null;
}

async function requireUser(sql: Sql, req: Request): Promise<User> {
  const u = await currentUser(sql, req);
  if (!u) throw new HttpError(401, 'Nem vagy bejelentkezve.');
  return u;
}

async function startSession(sql: Sql, req: Request, userId: string) {
  const token = randomToken(32);
  await sql`insert into sessions (user_id, token_hash, expires_at) values (${userId}, ${sha256(token)}, now() + make_interval(days => ${SESSION_DAYS}))`;
  await sql`delete from sessions where user_id = ${userId} and expires_at < now()`;
  return sessionCookie(req, token, SESSION_SEC);
}

async function sendVerification(sql: Sql, req: Request, user: { id: string; email: string }) {
  if (!env.emailEnabled) return;
  const token = randomToken(32);
  await sql`delete from email_verification_tokens where user_id = ${user.id}`;
  await sql`insert into email_verification_tokens (user_id, token_hash, expires_at) values (${user.id}, ${sha256(token)}, now() + interval '24 hours')`;
  await sendEmail(user.email, 'KrétaSync – E-mail-cím megerősítése', `Erősítsd meg az e-mail-címedet:\n${origin(req)}/#/verify?token=${token}\n\nA link 24 óráig érvényes.`);
}

type Handler = (req: Request, sql: Sql, deps: AppDeps) => Promise<Response>;

const routes: Record<string, Handler> = {
  'GET /api/config': async () => json({ emailEnabled: env.emailEnabled }),

  'POST /api/register': async (req, sql) => {
    await rateLimit(sql, `register:${clientIp(req)}`, 10, 3600);
    const b = await readJson(req);
    const mail = vEmail(b.email);
    const pw = newPassword(b.password);
    if (b.passwordConfirm !== pw) throw new HttpError(400, 'A két jelszó nem egyezik.');
    if (b.acceptPrivacy !== true) throw new HttpError(400, 'Az adatvédelmi tájékoztató elfogadása kötelező.');
    const { hash, salt } = await hashPassword(pw);
    const calToken = randomToken(32);
    let userId: string;
    try {
      userId = await sql.begin(async (tx: any) => {
        const [u] = await tx`insert into users (email, password_hash, password_salt) values (${mail}, ${hash}, ${salt}) returning id`;
        await tx`insert into calendars (user_id, token_hash) values (${u.id}, ${sha256(calToken)})`;
        return u.id;
      }) as unknown as string;
    } catch (e: any) {
      // Csak a valódi egyediségi sértés jelent "már létezik"-et; minden más hiba tovább dobódik.
      if (e?.code === '23505') throw new HttpError(409, 'Ezzel az e-mail-címmel már létezik fiók.');
      throw e;
    }
    sendVerification(sql, req, { id: userId, email: mail }).catch((e) => console.error('verification email failed', e.message));
    const cookie = await startSession(sql, req, userId);
    return json({ user: { email: mail }, calendarUrl: calendarUrl(req, calToken) }, 201, { 'set-cookie': cookie });
  },

  'POST /api/login': async (req, sql) => {
    const ip = clientIp(req);
    await rateLimit(sql, `login-ip:${ip}`, 20, 900);
    const b = await readJson(req);
    const mail = vEmail(b.email);
    await rateLimit(sql, `login-email:${sha256(mail)}`, 10, 900);
    const pw = str(b.password, 'jelszó');
    const [u] = await sql`select id, password_hash, password_salt from users where lower(email) = ${mail}`;
    let ok = false;
    if (u) ok = await verifyPassword(pw, u.password_hash, u.password_salt);
    else { const d = await DUMMY; await verifyPassword(pw, d.hash, d.salt); }
    if (!ok) throw new HttpError(401, 'Hibás e-mail-cím vagy jelszó.');
    return json({ ok: true }, 200, { 'set-cookie': await startSession(sql, req, u.id) });
  },

  'POST /api/logout': async (req, sql) => {
    const t = parseCookies(req).ks_session;
    if (t) await sql`delete from sessions where token_hash = ${sha256(t)}`;
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie(req, '', 0) });
  },

  'GET /api/me': async (req, sql) => {
    const u = await requireUser(sql, req);
    return json({ user: { email: u.email, emailVerified: !!u.email_verified_at }, emailEnabled: env.emailEnabled });
  },

  'GET /api/dashboard': async (req, sql) => {
    const u = await requireUser(sql, req);
    const [conn] = await sql`select institute_code, connection_status, last_sync_at, last_error from kreta_connections where user_id = ${u.id}`;
    const [cal] = await sql`select created_at, rotated_at from calendars where user_id = ${u.id}`;
    const upcoming = await sql`
      select external_id, lesson_name, start_date, end_date, lesson_index, classroom_name, teacher_name, substitute_teacher_name
      from lessons where user_id = ${u.id} and end_date >= ${budapestLocal()} order by start_date limit 10`;
    const next = conn?.last_sync_at ? new Date(new Date(conn.last_sync_at).getTime() + env.syncIntervalHours * 3600_000) : null;
    return json({
      user: { email: u.email, emailVerified: !!u.email_verified_at },
      emailEnabled: env.emailEnabled,
      kreta: conn
        ? { connected: true, status: conn.connection_status, instituteCode: conn.institute_code, lastSyncAt: conn.last_sync_at, lastError: conn.last_error,
            nextSyncAt: conn.connection_status === 'reauth_required' ? null : next }
        : { connected: false },
      calendar: { exists: !!cal, rotatedAt: cal?.rotated_at ?? null },
      upcoming,
    });
  },

  'POST /api/calendar/rotate': async (req, sql) => {
    const u = await requireUser(sql, req);
    const token = randomToken(32);
    await sql`insert into calendars (user_id, token_hash, rotated_at) values (${u.id}, ${sha256(token)}, now())
              on conflict (user_id) do update set token_hash = excluded.token_hash, rotated_at = now()`;
    return json({ calendarUrl: calendarUrl(req, token) });
  },

  'GET /api/calendar-ics': async (req, sql) => {
    // A Vercel rewrite után a függvény az eredeti (/calendar/TOKEN.ics) vagy az átírt (?token=) címet is kaphatja – mindkettőt kezeljük.
    const u = new URL(req.url);
    const raw = u.searchParams.get('token') || u.pathname.match(/^\/calendar\/([^/]+)$/)?.[1] || '';
    const m = raw.match(/^([A-Za-z0-9_-]{20,100})\.ics$/);
    const miss = async () => { await rateLimit(sql, `ics-miss:${clientIp(req)}`, 30, 900); return new Response('Not found', { status: 404 }); };
    if (!m) return miss();
    const [cal] = await sql`select user_id from calendars where token_hash = ${sha256(m[1])}`;
    if (!cal) return miss();
    const lessons = await sql`
      select external_id, lesson_name, start_date, end_date, lesson_index, classroom_name, teacher_name, substitute_teacher_name, updated_at
      from lessons where user_id = ${cal.user_id} order by start_date`;
    return new Response(buildIcs(lessons as any), {
      headers: { 'content-type': 'text/calendar; charset=utf-8', 'cache-control': 'private, max-age=300', 'content-disposition': 'inline; filename="kretasync.ics"' },
    });
  },

  'POST /api/password/forgot': async (req, sql) => {
    if (!env.emailEnabled) throw new HttpError(503, 'A jelszó-visszaállítás nem érhető el: az e-mail-szolgáltató nincs beállítva.');
    await rateLimit(sql, `forgot-ip:${clientIp(req)}`, 10, 3600);
    const mail = vEmail((await readJson(req)).email);
    await rateLimit(sql, `forgot-email:${sha256(mail)}`, 3, 3600);
    const [u] = await sql`select id, email from users where lower(email) = ${mail}`;
    if (u) {
      const token = randomToken(32);
      await sql`delete from password_reset_tokens where user_id = ${u.id} and used_at is null`;
      await sql`insert into password_reset_tokens (user_id, token_hash, expires_at) values (${u.id}, ${sha256(token)}, now() + interval '1 hour')`;
      try {
        await sendEmail(u.email, 'KrétaSync – Jelszó-visszaállítás', `Új jelszó beállítása:\n${origin(req)}/#/reset?token=${token}\n\nA link 1 óráig érvényes és egyszer használható. Ha nem te kérted, hagyd figyelmen kívül.`);
      } catch (e: any) { console.error('reset email failed', e.message); }
    }
    return json({ ok: true, message: 'Ha létezik ilyen fiók, elküldtük a visszaállító linket.' });
  },

  'POST /api/password/reset': async (req, sql) => {
    await rateLimit(sql, `reset-ip:${clientIp(req)}`, 20, 3600);
    const b = await readJson(req);
    const token = str(b.token, 'token', 200);
    const pw = newPassword(b.password);
    const { hash, salt } = await hashPassword(pw);
    const used = await sql`update password_reset_tokens set used_at = now()
      where token_hash = ${sha256(token)} and used_at is null and expires_at > now() returning user_id`;
    if (!used.length) throw new HttpError(400, 'A visszaállító link érvénytelen vagy lejárt.');
    await sql`update users set password_hash = ${hash}, password_salt = ${salt} where id = ${used[0].user_id}`;
    await sql`delete from sessions where user_id = ${used[0].user_id}`;
    return json({ ok: true });
  },

  'POST /api/password/change': async (req, sql) => {
    const u = await requireUser(sql, req);
    await rateLimit(sql, `pwchange:${u.id}`, 10, 3600);
    const b = await readJson(req);
    const [row] = await sql`select password_hash, password_salt from users where id = ${u.id}`;
    if (!(await verifyPassword(str(b.currentPassword, 'jelenlegi jelszó'), row.password_hash, row.password_salt))) throw new HttpError(403, 'A jelenlegi jelszó hibás.');
    const { hash, salt } = await hashPassword(newPassword(b.newPassword));
    await sql`update users set password_hash = ${hash}, password_salt = ${salt} where id = ${u.id}`;
    const keep = sha256(parseCookies(req).ks_session || '');
    await sql`delete from sessions where user_id = ${u.id} and token_hash <> ${keep}`;
    return json({ ok: true });
  },

  'POST /api/email/verify': async (req, sql) => {
    const token = str((await readJson(req)).token, 'token', 200);
    const r = await sql`update email_verification_tokens set used_at = now() where token_hash = ${sha256(token)} and used_at is null and expires_at > now() returning user_id`;
    if (!r.length) throw new HttpError(400, 'A megerősítő link érvénytelen vagy lejárt.');
    await sql`update users set email_verified_at = now() where id = ${r[0].user_id}`;
    return json({ ok: true });
  },

  'POST /api/email/resend': async (req, sql) => {
    const u = await requireUser(sql, req);
    if (!env.emailEnabled) throw new HttpError(503, 'Az e-mail-szolgáltató nincs beállítva.');
    if (u.email_verified_at) return json({ ok: true });
    await rateLimit(sql, `resend:${u.id}`, 3, 3600);
    await sendVerification(sql, req, u);
    return json({ ok: true });
  },

  'POST /api/kreta/connect': async (req, sql, deps) => {
    const u = await requireUser(sql, req);
    await rateLimit(sql, `kreta-connect:${u.id}`, 5, 3600);
    const b = await readJson(req);
    const username = str(b.username, 'KRÉTA-felhasználónév', 100);
    const password = str(b.password, 'KRÉTA-jelszó', 200);
    const institute = str(b.instituteCode, 'intézménykód', 40).trim();
    assertInstituteCode(institute);
    encrypt('config-check'); // hiányzó ENCRYPTION_KEY esetén még a belépés előtt érthető hibát adunk
    const kreta = deps.kreta ?? createKretaClient();
    // A jelszót csak a belépéshez használjuk; csak a titkosított refresh token kerül mentésre.
    const tokens = await kreta.login(username, password, institute);
    await sql`
      insert into kreta_connections (user_id, institute_code, refresh_token_enc, connection_status, last_error)
      values (${u.id}, ${institute}, ${encrypt(tokens.refresh_token)}, 'connected', null)
      on conflict (user_id) do update set institute_code = excluded.institute_code, refresh_token_enc = excluded.refresh_token_enc,
        connection_status = 'connected', last_error = null, syncing_at = null, updated_at = now()`;
    const sync = await syncUser(sql, u.id, kreta);
    return json({ connected: true, sync });
  },

  'DELETE /api/kreta/disconnect': async (req, sql) => {
    const u = await requireUser(sql, req);
    await sql`delete from kreta_connections where user_id = ${u.id}`;
    await sql`delete from lessons where user_id = ${u.id}`;
    return json({ ok: true });
  },

  'POST /api/sync': async (req, sql, deps) => {
    const u = await requireUser(sql, req);
    await rateLimit(sql, `sync:${u.id}`, 10, 3600);
    const r = await syncUser(sql, u.id, deps.kreta);
    if (!r.ok && !r.busy && r.error === 'Nincs KRÉTA-kapcsolat beállítva.') throw new HttpError(409, r.error);
    return json({ sync: r }, r.ok || r.busy ? 200 : 502);
  },

  'DELETE /api/account': async (req, sql) => {
    const u = await requireUser(sql, req);
    const [row] = await sql`select password_hash, password_salt from users where id = ${u.id}`;
    if (!(await verifyPassword(str((await readJson(req)).password, 'jelszó'), row.password_hash, row.password_salt))) throw new HttpError(403, 'A jelszó hibás.');
    await sql`delete from users where id = ${u.id}`; // idegen kulcsok: minden kapcsolódó adat törlődik
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie(req, '', 0) });
  },

  'GET /api/cron/sync': async (req, sql, deps) => {
    const given = (req.headers.get('authorization') || '').replace(/^Bearer /, '');
    const a = Buffer.from(sha256(given)), b = Buffer.from(sha256(env.cronSecret));
    if (!env.cronSecret || !timingSafeEqual(a, b)) throw new HttpError(401, 'Unauthorized');
    return json(await syncDue(sql, 50_000, deps.kreta));
  },
};

export function createApp(deps: AppDeps = {}) {
  return async function handle(req: Request): Promise<Response> {
    try {
      let path = new URL(req.url).pathname.replace(/\/+$/, '') || '/';
      if (/^\/calendar\/[^/]+$/.test(path)) path = '/api/calendar-ics';
      const handler = routes[`${req.method} ${path}`];
      if (!handler) {
        if (path.startsWith('/api/')) throw new HttpError(404, 'Ismeretlen végpont.');
        return new Response('Not found', { status: 404 });
      }
      assertCsrf(req);
      return await handler(req, db(), deps);
    } catch (e: any) {
      if (e instanceof HttpError) return json({ error: e.message, ...e.extra }, e.status);
      if (e instanceof ConfigError) { console.error('config error:', e.message); return json({ error: e.message, code: 'config' }, 503); }
      if (e instanceof KretaAuthError) return json({ error: e.message, code: 'kreta_auth' }, 401);
      if (e instanceof KretaError) return json({ error: e.message, code: 'kreta' }, 502);
      console.error('internal error:', e?.code || '', e?.message || String(e));
      return json({ error: 'Belső szerverhiba. Kérjük, próbáld újra később.' }, 500);
    }
  };
}