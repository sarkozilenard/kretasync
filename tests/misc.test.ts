import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { client, closeDb, db, PW, register, resetDb } from './helpers';

const call = client();

describe('jelszó-visszaállítás és e-mail-megerősítés', () => {
  beforeAll(resetDb);
  afterAll(closeDb);

  it('e-mail-szolgáltató nélkül a funkció nem működik (503), és jelzi a /api/config', async () => {
    expect((await call('GET', '/api/config')).data.emailEnabled).toBe(false);
    expect((await call('POST', '/api/password/forgot', { email: 'x@y.hu' })).status).toBe(503);
  });

  it('11. biztonságos visszaállítás: egyszer használható, lejáró, régi jelszó/munkamenet érvényét veszti', async () => {
    process.env.RESEND_API_KEY = 're_test'; process.env.EMAIL_FROM = 'KrétaSync <t@kretasync.test>';
    const sent: { to: string; text: string }[] = [];
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: any, init: any) => {
      if (String(url).startsWith('https://api.resend.com/')) { sent.push(JSON.parse(init.body)); return new Response('{}', { status: 200 }); }
      return realFetch(url, init);
    });
    try {
      const { cookie } = await register(call, 'reset@example.com', '10.9.0.1');
      await new Promise((r) => setTimeout(r, 100));
      const verifyMail = sent.find((m) => m.text.includes('#/verify?token='))!;
      expect(verifyMail.to).toBe('reset@example.com');
      const vtoken = verifyMail.text.match(/token=([\w-]+)/)![1];
      expect((await call('GET', '/api/me', undefined, cookie)).data.user.emailVerified).toBe(false);
      expect((await call('POST', '/api/email/verify', { token: vtoken })).status).toBe(200);
      expect((await call('POST', '/api/email/verify', { token: vtoken })).status).toBe(400);
      expect((await call('GET', '/api/me', undefined, cookie)).data.user.emailVerified).toBe(true);

      // ismeretlen e-mail: ugyanaz a válasz (nincs fióklistázás), nincs levél
      sent.length = 0;
      const unknown = await call('POST', '/api/password/forgot', { email: 'nincs@example.com' }, undefined, { 'x-real-ip': '10.9.0.2' });
      expect(unknown.status).toBe(200); expect(sent).toHaveLength(0);

      const f = await call('POST', '/api/password/forgot', { email: 'reset@example.com' }, undefined, { 'x-real-ip': '10.9.0.3' });
      expect(f.status).toBe(200); expect(sent).toHaveLength(1);
      const token = sent[0].text.match(/token=([\w-]+)/)![1];
      const [row] = await db()`select token_hash from password_reset_tokens`;
      expect(row.token_hash).not.toBe(token); // csak hash tárolva

      expect((await call('POST', '/api/password/reset', { token: 'hamis-token', password: 'Uj-jelszo-12345' })).status).toBe(400);
      expect((await call('POST', '/api/password/reset', { token, password: 'rovid' })).status).toBe(400);
      expect((await call('POST', '/api/password/reset', { token, password: 'Uj-jelszo-12345' })).status).toBe(200);
      expect((await call('POST', '/api/password/reset', { token, password: 'Masik-jelszo-123' })).status).toBe(400); // egyszer használható
      expect((await call('GET', '/api/me', undefined, cookie)).status).toBe(401);                                // régi munkamenet megszűnt
      expect((await call('POST', '/api/login', { email: 'reset@example.com', password: PW })).status).toBe(401);
      expect((await call('POST', '/api/login', { email: 'reset@example.com', password: 'Uj-jelszo-12345' })).status).toBe(200);

      // lejárt token
      await call('POST', '/api/password/forgot', { email: 'reset@example.com' }, undefined, { 'x-real-ip': '10.9.0.4' });
      const t2 = sent[1].text.match(/token=([\w-]+)/)![1];
      await db()`update password_reset_tokens set expires_at = now() - interval '1 minute'`;
      expect((await call('POST', '/api/password/reset', { token: t2, password: 'Harmadik-jelszo-1' })).status).toBe(400);
    } finally {
      vi.unstubAllGlobals(); delete process.env.RESEND_API_KEY; delete process.env.EMAIL_FROM;
    }
  });
});

describe('hibakezelés és konfiguráció', () => {
  const saved = { ...process.env };
  afterAll(async () => { process.env = saved as any; await closeDb(); });

  it('12. hiányzó DATABASE_URL érthető hibaüzenet (503), nem általános hiba', async () => {
    await closeDb(); delete process.env.DATABASE_URL;
    const r = await call('POST', '/api/login', { email: 'a@b.hu', password: 'valami-hosszu-jelszo' });
    expect(r.status).toBe(503); expect(r.data.error).toContain('DATABASE_URL'); expect(r.data.code).toBe('config');
  });

  it('13. adatbázis-kapcsolati hiba nem „e-mail már létezik" (409), hanem 500', async () => {
    process.env.DATABASE_URL = 'postgres://ks:ks@localhost:1/nincs'; await closeDb();
    const r = await call('POST', '/api/register', { email: 'valami@example.com', password: PW, passwordConfirm: PW, acceptPrivacy: true });
    expect(r.status).toBe(500); expect(r.data.error).not.toMatch(/létezik/);
    expect(JSON.stringify(r.data)).not.toContain('localhost'); // belső részletek nem szivárognak
    process.env.DATABASE_URL = saved.DATABASE_URL; await closeDb();
  });

  it('hiányzó ENCRYPTION_KEY: érthető hiba, a KRÉTA-jelszó még el sem hagyja a szervert', async () => {
    const { cookie } = await register(call, 'enc@example.com', '10.9.1.1');
    const fake = client();
    delete process.env.ENCRYPTION_KEY;
    const r = await fake('POST', '/api/kreta/connect', { username: 'd', password: 'p', instituteCode: 'klik011111111' }, cookie);
    expect(r.status).toBe(503); expect(r.data.error).toContain('ENCRYPTION_KEY');
    process.env.ENCRYPTION_KEY = saved.ENCRYPTION_KEY;
  });

  it('ismeretlen végpont 404, hibás JSON 400', async () => {
    expect((await call('GET', '/api/nincs')).status).toBe(404);
    const { createApp } = await import('../src/app');
    const res = await createApp()(new Request('https://x.test/api/login', { method: 'POST', headers: { 'x-requested-with': 'kretasync' }, body: '{nem json' }));
    expect(res.status).toBe(400);
  });
});
