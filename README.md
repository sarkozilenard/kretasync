# KrétaSync

A diákok KRÉTA-órarendjét automatikusan szinkronizálja személyes, titkos ICS-naptárlinkre (Apple Naptár, Google Naptár, Outlook…).
**Stack:** Vercel Functions (TypeScript, Node.js) + Vercel statikus fájlok + Postgres (Neon) + Vercel Cron.

## Fontos tudnivalók (olvasd el)

1. **A KRÉTA-integráció nem hivatalos.** A `kreta.py` alapján készült: az iOS diákalkalmazás kliensazonosítóját használja és az `idp.e-kreta.hu` bejelentkezési folyamatát automatizálja. Ez nem dokumentált, nem engedélyezett API; a KRÉTA bármikor letilthatja vagy megváltoztathatja, és ellentétes lehet a használati feltételeikkel. Ezt a felhasználók felé is jelzi a felület.
2. **A KRÉTA-jelszó nem kerül tárolásra.** Csak a csatlakozáskor használjuk; az adatbázisban kizárólag a KRÉTA *refresh tokenje* van, AES-256-GCM-mel titkosítva (`ENCRYPTION_KEY`). Ha a token lejár, a felhasználónak újra meg kell adnia a jelszavát.
3. **A valódi KRÉTA ellen ez a projekt nincs élesben tesztelve** (a fejlesztői környezetből nem volt hozzáférés). A lépéssort szimulált IdP ellen teszteltük (`tests/kreta.test.ts`). Az első éles kipróbálás a te feladatod; ha a KRÉTA válasza eltér, a `src/kreta/client.ts`-t kell igazítani. Ha a KRÉTA az időpontokat valódi UTC-ként adja, állítsd `KRETA_TIMES_ARE_UTC=true`-ra (alapértelmezés a `kreta.py` szerinti: az időpont változatlanul helyi idő).
4. **A naptárlink csak létrehozáskor látható**, mert az adatbázisban csak a hash-e van (specifikáció). Elvesztése esetén újat kell generálni.
5. **Vercel Hobby csomagon a cron naponta egyszer futhat.** A `vercel.json` ezért `0 5 * * *`. Gyakoribb futáshoz Pro csomag kell (a `SYNC_INTERVAL_HOURS` és a cron-ütemezés együtt szabályozza a gyakoriságot). A felhasználó bármikor kézzel is szinkronizálhat.

## Helyi indítás

```bash
npm install
cp .env.example .env        # töltsd ki: DATABASE_URL, ENCRYPTION_KEY (openssl rand -hex 32), CRON_SECRET
npm run db:migrate          # sémák létrehozása a DATABASE_URL adatbázisban
npm run dev                 # http://localhost:3000
```

Szükséges egy helyi Postgres (pl. `docker run -p 5432:5432 -e POSTGRES_PASSWORD=pw postgres:16`, majd `DATABASE_URL=postgres://postgres:pw@localhost:5432/postgres`).
A `npm run dev` saját kis szervere a `public/` fájlokat és az API-t szolgálja ki; Vercel-specifikus működéshez használhatod a `npx vercel dev` parancsot is.

## Telepítés Vercelre

1. Push a repót GitHubra, majd Vercel → *Add New Project* → importáld (Framework: *Other*, nincs build parancs).
2. Adatbázis: Vercel → *Storage / Marketplace* → **Neon (Postgres)** → kapcsold a projekthez; ez beállítja a `DATABASE_URL`-t (vagy add meg kézzel; `?sslmode=require` kell).
3. Environment Variables (Project Settings): `ENCRYPTION_KEY`, `CRON_SECRET`, `APP_URL` (pl. `https://kretasync.hu`), opcionálisan `SYNC_INTERVAL_HOURS`, `SYNC_DAYS`, `RESEND_API_KEY`, `EMAIL_FROM`.
   A `CRON_SECRET`-et a Vercel automatikusan `Authorization: Bearer …` fejlécként küldi a cron-hívásokhoz.
4. Migráció a távoli adatbázisra (a saját gépedről):
   ```bash
   DATABASE_URL="postgres://…neon…?sslmode=require" npm run db:migrate
   ```
5. Deploy (git push vagy `npx vercel --prod`).
6. Ellenőrzés: nyisd meg az oldalt, regisztrálj, és próbáld ki a naptárlinket; cron kézzel:
   `curl -H "Authorization: Bearer $CRON_SECRET" https://DOMAIN/api/cron/sync`

> `ENCRYPTION_KEY` elvesztése/cseréje után az összes mentett KRÉTA-kapcsolat érvénytelen; a felhasználóknak újra kell csatlakozniuk.

Az API-kéréseket a Vercel egyetlen `api/index.ts` függvényhez irányítja; az eredeti végpontot a rewrite `__route` paraméterként adja át.

## E-mail (opcionális)

Jelszó-visszaállítás és e-mail-megerősítés csak akkor működik, ha `RESEND_API_KEY` és `EMAIL_FROM` be van állítva ([resend.com](https://resend.com), ellenőrzött küldő-domain kell). Beállításig a felület kikapcsolva mutatja ezeket (`GET /api/config`), és az API 503-at ad.

## API

| Végpont | Leírás |
|---|---|
| `POST /api/register`, `POST /api/login`, `POST /api/logout`, `GET /api/me`, `GET /api/dashboard` | fiók, munkamenet |
| `POST /api/password/forgot`, `POST /api/password/reset`, `POST /api/password/change` | jelszókezelés |
| `POST /api/email/verify`, `POST /api/email/resend` | e-mail-megerősítés |
| `POST /api/calendar/rotate` | új titkos naptárlink (a régi azonnal érvénytelen) |
| `POST /api/kreta/connect`, `DELETE /api/kreta/disconnect`, `POST /api/sync` | KRÉTA-kapcsolat, kézi szinkron |
| `DELETE /api/account` | fiók végleges törlése |
| `GET /calendar/{token}.ics` | ICS-előfizetés (Vercel rewrite → `/api/calendar-ics`) |
| `GET /api/cron/sync` | Cron, `CRON_SECRET`-tel védett |

## Biztonság – ami megvalósult

- Jelszó: scrypt (N=2¹⁵, r=8, p=1), egyedi só. Munkamenet-, naptár-, visszaállító és megerősítő tokenek: csak SHA-256 hash az adatbázisban.
- Cookie: `HttpOnly; SameSite=Lax; Secure` (HTTPS-en). CSRF: kötelező `X-Requested-With` fejléc + Origin-ellenőrzés minden módosító kérésnél.
- Rate limit (Postgres-alapú): regisztráció, belépés (IP + e-mail), jelszó-visszaállítás, KRÉTA-csatlakozás, szinkron, hibás ICS-token.
- Paraméterezett SQL; minden adat `user_id`-hoz kötött; az intézménykód szigorúan validált (nem lehet idegen hostra irányítani).
- Jelszó-visszaállítás után minden munkamenet megszűnik; a válasz nem árulja el, létezik-e az e-mail.
- A naplókba nem kerül jelszó vagy token.

## Szinkron működése

Csatlakozáskor és minden szinkronnál az elkövetkező `SYNC_DAYS` (14) nap órarendje töltődik le. Az órák a KRÉTA egyedi azonosítója (`Uid`) szerint upsertelődnek (módosult óra = ugyanaz az ICS-UID, nincs duplikáció); ami az ablakból eltűnt vagy `Elmaradt` státuszú, törlődik. Hiba esetén semmi nem törlődik, az állapot (`error` / `reauth_required`) és az üzenet megjelenik az irányítópulton. Párhuzamos szinkronok egy zárral kizárva (a refresh token forgatása miatt).

## Tesztek

```bash
export TEST_DATABASE_URL=postgres://user:pass@localhost:5432/kretasync_test   # külön, eldobható adatbázis!
npm test                  # 28 teszt: valódi Postgres ellen, szimulált KRÉTA-val
npm run typecheck
```

A tesztek törlik/újraépítik a `public` sémát a teszt-adatbázisban – **ne mutass velük éles adatbázisra!**
