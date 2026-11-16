'use strict';
const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view'), nav = $('#nav');
let state = { me: null, config: { emailEnabled: false } };

/* ---------- segédfüggvények ---------- */
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
async function api(method, path, body) {
  const res = await fetch(path, { method, credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-requested-with': 'kretasync' }, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = {}; try { data = await res.json(); } catch { /* üres */ }
  if (!res.ok) { const e = new Error(data.error || 'Ismeretlen hiba.'); e.status = res.status; e.data = data; throw e; }
  return data;
}
let toastTimer;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3200); }
function busy(btn, fn) {
  return async (e) => {
    e?.preventDefault?.();
    const old = [...btn.childNodes]; btn.disabled = true; btn.replaceChildren(h('span', { class: 'spin' }));
    try { await fn(); } finally { btn.disabled = false; btn.replaceChildren(...old); }
  };
}
const fmtDT = (iso) => iso ? new Date(iso).toLocaleString('hu-HU', { timeZone: 'Europe/Budapest', dateStyle: 'medium', timeStyle: 'short' }) : '—';
const fmtDay = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('hu-HU', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const errBox = (msg, kind = 'err') => h('div', { class: `alert ${kind}`, role: 'alert' }, msg);
function showError(form, e) { form.querySelector('.alert')?.remove(); form.prepend(errBox(e.message)); }
function field(label, name, type = 'text', extra = {}) {
  return h('label', {}, label, h('input', { name, type, required: true, ...extra }));
}

/* ---------- navigáció ---------- */
function renderNav() {
  nav.replaceChildren(...(state.me
    ? [h('a', { class: 'btn ghost small', href: '#/dashboard' }, 'Irányítópult'), h('a', { class: 'btn ghost small', href: '#/settings' }, 'Beállítások'),
       h('button', { class: 'btn small', onclick: logout }, 'Kijelentkezés')]
    : [h('a', { class: 'btn ghost small', href: '#/login' }, 'Bejelentkezés'), h('a', { class: 'btn primary small', href: '#/register' }, 'Regisztráció')]));
}
async function logout() { try { await api('POST', '/api/logout', {}); } catch { /* mindegy */ } sessionStorage.removeItem('calUrl'); sessionStorage.removeItem('relayToken'); state.me = null; location.hash = '#/'; route(); }

/* ---------- nézetek ---------- */
function landing() {
  const f = (ico, t, d) => h('div', { class: 'card' }, h('div', { class: 'ico' }, ico), h('h3', {}, t), h('p', { class: 'muted' }, d));
  return h('div', {},
    h('section', { class: 'hero' },
      h('h1', {}, 'A KRÉTA-órarended ', h('span', { class: 'grad' }, 'mindig a naptáradban.')),
      h('p', { class: 'lead' }, 'Kösd össze a KRÉTA-fiókodat, iratkozz fel a személyes naptárlinkedre az Apple Naptárban (vagy bármely ICS-t támogató alkalmazásban), és az órarended automatikusan frissül.'),
      h('div', { class: 'actions' }, h('a', { class: 'btn primary', href: '#/register' }, 'Fiók létrehozása'), h('a', { class: 'btn', href: '#/login' }, 'Bejelentkezés'))),
    h('section', { class: 'features' },
      f('🔄', 'Automatikus frissítés', 'Új óra, elmaradás, teremváltás vagy helyettesítés – a változások megjelennek a naptárban.'),
      f('🔒', 'Személyes, titkos link', 'Minden felhasználó külön, kitalálhatatlan naptárlinket kap, bármikor újragenerálhatod.'),
      f('📱', 'Apple Naptár és más', 'Szabványos ICS-előfizetés: iPhone, Mac, Google Naptár, Outlook.'),
      f('🛡️', 'Adatkímélő', 'A KRÉTA-jelszavadat nem tároljuk, a hozzáférési tokent titkosítva őrizzük.')));
}

function authCard(title, body) { return h('div', { class: 'auth card' }, h('h2', {}, title), body); }

function loginView() {
  const form = h('form', {}, field('E-mail-cím', 'email', 'email', { autocomplete: 'email' }), field('Jelszó', 'password', 'password', { autocomplete: 'current-password' }));
  const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Bejelentkezés');
  form.append(btn, h('div', { class: 'row small' }, state.config.emailEnabled ? h('a', { href: '#/forgot' }, 'Elfelejtett jelszó') : null, h('span', { class: 'muted' }, 'Nincs fiókod? '), h('a', { href: '#/register' }, 'Regisztráció')));
  form.addEventListener('submit', busy(btn, async () => {
    const d = Object.fromEntries(new FormData(form));
    try { await api('POST', '/api/login', d); await loadMe(); location.hash = '#/dashboard'; } catch (e) { showError(form, e); }
  }));
  return authCard('Bejelentkezés', form);
}

function registerView() {
  const form = h('form', {}, field('E-mail-cím', 'email', 'email', { autocomplete: 'email' }),
    field('Jelszó (legalább 10 karakter)', 'password', 'password', { autocomplete: 'new-password', minlength: 10 }),
    field('Jelszó megerősítése', 'passwordConfirm', 'password', { autocomplete: 'new-password', minlength: 10 }),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'acceptPrivacy', required: true }),
      h('span', {}, 'Elfogadom az adatvédelmi tájékoztatót: a KrétaSync az e-mail-címemet, a jelszavam hash-ét, a KRÉTA-hozzáférés titkosított tokenjét és az órarendemet tárolja, a fiókom törlésekor ezek törlődnek.')));
  const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Fiók létrehozása');
  form.append(btn, h('div', { class: 'small' }, h('span', { class: 'muted' }, 'Már van fiókod? '), h('a', { href: '#/login' }, 'Bejelentkezés')));
  form.addEventListener('submit', busy(btn, async () => {
    const fd = new FormData(form);
    const d = { email: fd.get('email'), password: fd.get('password'), passwordConfirm: fd.get('passwordConfirm'), acceptPrivacy: fd.get('acceptPrivacy') === 'on' };
    try { const r = await api('POST', '/api/register', d); sessionStorage.setItem('calUrl', r.calendarUrl); await loadMe(); location.hash = '#/dashboard'; } catch (e) { showError(form, e); }
  }));
  return authCard('Fiók létrehozása', form);
}

function forgotView() {
  if (!state.config.emailEnabled) return authCard('Elfelejtett jelszó', h('div', {}, errBox('A jelszó-visszaállítás jelenleg nem érhető el, mert az e-mail-küldés nincs beállítva.', 'warn'), h('a', { href: '#/login' }, '← Vissza')));
  const form = h('form', {}, h('p', { class: 'muted small' }, 'Megadott e-mail-címedre egyszer használható, 1 óráig érvényes linket küldünk.'), field('E-mail-cím', 'email', 'email'));
  const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Link küldése');
  form.append(btn, h('a', { href: '#/login', class: 'small' }, '← Vissza a bejelentkezéshez'));
  form.addEventListener('submit', busy(btn, async () => {
    try { const r = await api('POST', '/api/password/forgot', Object.fromEntries(new FormData(form))); form.replaceChildren(errBox(r.message, 'ok')); } catch (e) { showError(form, e); }
  }));
  return authCard('Elfelejtett jelszó', form);
}

function tokenFromHash() { return new URLSearchParams(location.hash.split('?')[1] || '').get('token') || ''; }

function resetView() {
  const token = tokenFromHash();
  const form = h('form', {}, field('Új jelszó (legalább 10 karakter)', 'password', 'password', { autocomplete: 'new-password', minlength: 10 }));
  const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Új jelszó beállítása');
  form.append(btn);
  form.addEventListener('submit', busy(btn, async () => {
    try { await api('POST', '/api/password/reset', { token, password: new FormData(form).get('password') }); toast('Jelszó módosítva. Jelentkezz be!'); state.me = null; location.hash = '#/login'; } catch (e) { showError(form, e); }
  }));
  return authCard('Új jelszó beállítása', token ? form : errBox('Hiányzik a visszaállító token. Kérj új linket.'));
}

function verifyView() {
  const box = h('div', {}, h('p', { class: 'muted' }, 'E-mail-cím megerősítése…'));
  api('POST', '/api/email/verify', { token: tokenFromHash() })
    .then(() => box.replaceChildren(errBox('Az e-mail-címed megerősítve.', 'ok'), h('a', { class: 'btn primary', href: '#/dashboard' }, 'Tovább')))
    .catch((e) => box.replaceChildren(errBox(e.message), h('a', { href: '#/dashboard' }, 'Tovább az irányítópultra')));
  return authCard('E-mail-megerősítés', box);
}

const STATUS = {
  connected: ['ok', 'Csatlakoztatva'], error: ['err', 'Szinkronizálási hiba'], reauth_required: ['warn', 'Újra be kell jelentkezned a KRÉTA-ba'],
};

async function dashboardView() {
  const d = await api('GET', '/api/dashboard');
  state.config.emailEnabled = d.emailEnabled;
  const k = d.kreta;
  const root = h('div', {}, h('h1', { style: 'font-size:2rem' }, 'Szia, ', h('span', { class: 'grad' }, d.user.email.split('@')[0]), '!'));
  if (d.emailEnabled && !d.user.emailVerified) {
    const rb = h('button', { class: 'btn small', style: 'margin-left:10px' }, 'Megerősítő levél újraküldése');
    rb.addEventListener('click', busy(rb, async () => { try { await api('POST', '/api/email/resend', {}); toast('Elküldtük a megerősítő levelet.'); } catch (e) { toast(e.message); } }));
    root.append(h('div', { class: 'alert warn' }, 'Az e-mail-címed még nincs megerősítve.', rb));
  }
  const grid = h('div', { class: 'grid' });

  /* KRÉTA-kártya */
  const kc = h('section', { class: 'card' }, h('h2', {}, 'KRÉTA-kapcsolat'));
  if (k.connected) {
    const [cls, label] = STATUS[k.status] || ['off', k.status];
    kc.append(h('span', { class: `badge ${cls}` }, label));
    if (k.lastError) kc.append(h('div', { class: 'alert err', style: 'margin-top:12px' }, k.lastError));
    kc.append(h('dl', { class: 'kv' }, h('dt', {}, 'Intézmény'), h('dd', {}, k.instituteCode), h('dt', {}, 'Utolsó sikeres szinkron'), h('dd', {}, fmtDT(k.lastSyncAt)), h('dt', {}, 'Következő szinkron'), h('dd', {}, k.nextSyncAt ? fmtDT(k.nextSyncAt) : '—')));
    const sync = h('button', { class: 'btn primary' }, 'Szinkronizálás most');
    sync.addEventListener('click', busy(sync, async () => { try { await api('POST', '/api/sync', {}); toast('Szinkronizálás kész.'); } catch (e) { toast(e.message); } route(); }));
    const dis = h('button', { class: 'btn danger' }, 'Kapcsolat bontása');
    dis.addEventListener('click', busy(dis, async () => {
      if (!confirm('Biztosan bontod a KRÉTA-kapcsolatot? A naptárból az órák is törlődnek.')) return;
      try { await api('DELETE', '/api/kreta/disconnect'); toast('Kapcsolat bontva.'); } catch (e) { toast(e.message); } route();
    }));
    kc.append(h('div', { class: 'row' }, sync, dis));
    if (k.status === 'reauth_required') kc.append(h('p', { class: 'small muted' }, 'Add meg újra a KRÉTA-adataidat alább a kapcsolat megújításához.'), connectForm());
  } else {
    kc.append(h('span', { class: 'badge off' }, 'Nincs közvetlen kapcsolat'),
      h('p', { class: 'muted small' }, 'A KRÉTA a szerverről általában nem érhető el; használd a fenti relay módot. Ha mégis eléri a szerver, itt közvetlenül is csatlakozhatsz (a jelszót nem tároljuk, a tokent titkosítjuk).'),
      h('details', {}, h('summary', { class: 'small', style: 'cursor:pointer;color:var(--accent-2)' }, 'Közvetlen csatlakozás megnyitása'), connectForm()));
  }
  grid.append(relayCard(d.relay));
  grid.append(kc);

  /* Naptár-kártya */
  const url = sessionStorage.getItem('calUrl');
  const cc = h('section', { class: 'card' }, h('h2', {}, 'Naptár-előfizetés'));
  if (url) {
    const input = h('input', { type: 'text', readonly: true, value: url, 'aria-label': 'Naptárlink' });
    const copy = h('button', { class: 'btn' }, 'Másolás');
    copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(url); } catch { input.select(); document.execCommand('copy'); } toast('Link a vágólapon.'); });
    cc.append(h('div', { class: 'linkbox' }, input, copy), h('div', { class: 'row', style: 'margin-top:12px' }, h('a', { class: 'btn primary', href: url.replace(/^https?:/, 'webcal:') }, 'Megnyitás Apple Naptárban')),
      h('p', { class: 'small muted' }, 'Ez a link titkos – ne oszd meg. Biztonsági okból csak most látható; ha elveszted, generálj újat.'));
  } else {
    cc.append(h('p', { class: 'muted small' }, 'A titkos naptárlinket biztonsági okból csak létrehozáskor mutatjuk meg (az adatbázisban csak a hash-e van). Ha nincs meg, generálj újat – a régi azonnal érvénytelen lesz.'));
  }
  const rot = h('button', { class: 'btn', style: 'margin-top:12px' }, 'Új link generálása');
  rot.addEventListener('click', busy(rot, async () => {
    if (!confirm('Az új link létrehozása után a régi azonnal megszűnik. Folytatod?')) return;
    try { const r = await api('POST', '/api/calendar/rotate', {}); sessionStorage.setItem('calUrl', r.calendarUrl); toast('Új link kész.'); } catch (e) { toast(e.message); } route();
  }));
  cc.append(rot);
  grid.append(cc);

  /* Közelgő órák */
  const lc = h('section', { class: 'card wide' }, h('h2', {}, 'Közelgő órák'));
  if (!d.upcoming.length) lc.append(h('div', { class: 'empty' }, k.connected ? 'Nincs közelgő óra a szinkronizált időszakban.' : 'Kösd össze a KRÉTA-fiókodat, és itt megjelennek az óráid.'));
  else lc.append(h('ul', { class: 'lessons' }, d.upcoming.map((l) => {
    const meta = [l.classroom_name && `Terem: ${l.classroom_name}`, l.substitute_teacher_name ? `Helyettesít: ${l.substitute_teacher_name} (${l.teacher_name || '—'})` : l.teacher_name].filter(Boolean).join(' · ');
    return h('li', { class: 'lesson' }, h('div', { class: 't' }, l.start_date.slice(11), h('small', {}, fmtDay(l.start_date.slice(0, 10)))),
      h('div', {}, h('div', { class: 'n' }, (l.lesson_index != null ? l.lesson_index + '. ' : '') + l.lesson_name, l.substitute_teacher_name ? h('span', { class: 'badge warn', style: 'margin-left:8px' }, 'helyettesítés') : null), h('div', { class: 'm' }, meta)));
  })));
  grid.append(lc);
  root.append(grid);
  return root;
}

function copyBtn(text, label = 'Másolás') {
  const b = h('button', { class: 'btn small', type: 'button' }, label);
  b.addEventListener('click', async () => { try { await navigator.clipboard.writeText(text); } catch { /* régi böngésző */ } toast('A vágólapon.'); });
  return b;
}

function relayCard(rl) {
  const card = h('section', { class: 'card wide' }, h('h2', {}, 'KRÉTA-szinkron relay módban'));
  card.append(h('p', { class: 'muted small' }, 'A KRÉTA nem engedi el a külföldi szervereket, ezért a lekérdezést a saját (magyar IP-jű) gépeden futó kis script végzi, és csak a kész órarendet tölti fel ide. A KRÉTA-jelszavad így sosem hagyja el a gépedet.'));
  const token = sessionStorage.getItem('relayToken');
  if (rl.enabled) {
    card.append(h('span', { class: `badge ${rl.lastPushAt ? 'ok' : 'warn'}` }, rl.lastPushAt ? 'Aktív' : 'Várja az első feltöltést'),
      h('dl', { class: 'kv' }, h('dt', {}, 'Utolsó feltöltés'), h('dd', {}, fmtDT(rl.lastPushAt)), h('dt', {}, 'Feltöltött órák'), h('dd', {}, rl.lastLessons ?? '—')));
  }
  if (token) {
    const url = location.origin;
    const envText = `KRETASYNC_URL=${url}\nKRETASYNC_TOKEN=${token}\nKRETA_USER=a_kreta_felhasznalonev\nKRETA_PASS=a_kreta_jelszo\nKRETA_KLIK=klik012345678\nSYNC_DAYS=14\n`;
    card.append(h('div', { class: 'alert ok', style: 'margin-top:14px' }, 'A relay-token csak most látható. Mentsd el a relay.env fájlba (lásd lent).'),
      h('ol', { class: 'small', style: 'padding-left:20px;display:grid;gap:8px' },
        h('li', {}, 'Töltsd le a fájlokat, és tedd őket a kreta.py mellé egy mappába: ',
          h('a', { href: '/relay/kreta_relay.py', download: 'kreta_relay.py' }, 'kreta_relay.py'), ', ', h('a', { href: '/relay/run_relay.sh', download: 'run_relay.sh' }, 'run_relay.sh'), '.'),
        h('li', {}, 'Telepítsd a függőségeket: ', h('code', {}, 'pip install requests beautifulsoup4'), ' és add meg a futtatási jogot: ', h('code', {}, 'chmod +x run_relay.sh'), '.'),
        h('li', {}, 'Hozz létre ugyanott egy ', h('code', {}, 'relay.env'), ' fájlt ezzel a tartalommal (töltsd ki a KRÉTA-adataidat), majd ', h('code', {}, 'chmod 600 relay.env'), ':'),
        h('li', {}, 'Próbáld ki: ', h('code', {}, './run_relay.sh'), ' – ennek ki kell írnia: „Kész: N óra feltöltve”.'),
        h('li', {}, 'Időzítsd óránként (', h('code', {}, 'crontab -e'), '): ', h('code', {}, '0 * * * * /teljes/utvonal/run_relay.sh >> /teljes/utvonal/relay.log 2>&1'))),
      h('pre', { style: 'background:var(--bg);border:1px solid var(--border);border-radius:12px;padding:12px;overflow:auto;font-size:.8rem;margin:10px 0' }, envText),
      h('div', { class: 'row' }, copyBtn(envText, 'relay.env tartalmának másolása')));
  }
  const gen = h('button', { class: 'btn primary', style: 'margin-top:14px' }, rl.enabled ? 'Új relay-token generálása' : 'Relay beállítása');
  gen.addEventListener('click', busy(gen, async () => {
    if (rl.enabled && !confirm('Az új token után a régi azonnal érvénytelen lesz, és a relay.env-ben cserélned kell. Folytatod?')) return;
    try { const r = await api('POST', '/api/relay/token', {}); sessionStorage.setItem('relayToken', r.token); } catch (e) { toast(e.message); }
    route();
  }));
  const row = h('div', { class: 'row' }, gen);
  if (rl.enabled) {
    const off = h('button', { class: 'btn danger', style: 'margin-top:14px' }, 'Relay kikapcsolása');
    off.addEventListener('click', busy(off, async () => {
      if (!confirm('Kikapcsolod a relay-t? A feltöltött órák megmaradnak, de a frissítés leáll.')) return;
      try { await api('DELETE', '/api/relay/token'); sessionStorage.removeItem('relayToken'); } catch (e) { toast(e.message); }
      route();
    }));
    row.append(off);
  }
  card.append(row);
  return card;
}

function connectForm() {
  const form = h('form', { style: 'margin-top:12px' }, field('KRÉTA-felhasználónév', 'username', 'text', { autocomplete: 'username' }), field('KRÉTA-jelszó', 'password', 'password', { autocomplete: 'off' }),
    field('Intézménykód (pl. klik012345678)', 'instituteCode', 'text', { pattern: '[A-Za-z0-9]{3,40}' }));
  const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Csatlakozás és szinkronizálás');
  form.append(btn, h('p', { class: 'small muted' }, 'Ez nem hivatalos KRÉTA-integráció; a KRÉTA bármikor megváltoztathatja a működését.'));
  form.addEventListener('submit', busy(btn, async () => {
    try {
      const r = await api('POST', '/api/kreta/connect', Object.fromEntries(new FormData(form)));
      form.reset(); toast(r.sync.ok ? `Csatlakoztatva, ${r.sync.lessons} óra szinkronizálva.` : 'Csatlakoztatva, de a szinkron hibára futott.'); route();
    } catch (e) { showError(form, e); }
  }));
  return form;
}

async function settingsView() {
  const d = await api('GET', '/api/me');
  const pf = h('form', {}, field('Jelenlegi jelszó', 'currentPassword', 'password', { autocomplete: 'current-password' }), field('Új jelszó (legalább 10 karakter)', 'newPassword', 'password', { autocomplete: 'new-password', minlength: 10 }));
  const pb = h('button', { class: 'btn primary', type: 'submit' }, 'Jelszó módosítása'); pf.append(pb);
  pf.addEventListener('submit', busy(pb, async () => { try { await api('POST', '/api/password/change', Object.fromEntries(new FormData(pf))); pf.reset(); pf.querySelector('.alert')?.remove(); toast('Jelszó módosítva.'); } catch (e) { showError(pf, e); } }));

  const df = h('form', {}, h('p', { class: 'muted small' }, 'A fiók, a KRÉTA-kapcsolat, az órarend és a naptárlink véglegesen törlődik.'), field('Jelszó megerősítése', 'password', 'password', { autocomplete: 'current-password' }));
  const db = h('button', { class: 'btn danger', type: 'submit' }, 'Fiók végleges törlése'); df.append(db);
  df.addEventListener('submit', busy(db, async () => {
    if (!confirm('Biztosan véglegesen törlöd a fiókodat?')) return;
    try { await api('DELETE', '/api/account', Object.fromEntries(new FormData(df))); sessionStorage.removeItem('calUrl'); state.me = null; toast('A fiókod törölve.'); location.hash = '#/'; route(); } catch (e) { showError(df, e); }
  }));
  return h('div', {}, h('h1', { style: 'font-size:2rem' }, 'Fiókbeállítások'), h('div', { class: 'grid' },
    h('section', { class: 'card' }, h('h2', {}, 'Fiók'), h('dl', { class: 'kv' }, h('dt', {}, 'E-mail-cím'), h('dd', {}, d.user.email), h('dt', {}, 'Megerősítve'), h('dd', {}, d.emailEnabled ? (d.user.emailVerified ? 'Igen' : 'Nem') : 'n/a (e-mail nincs beállítva)'))),
    h('section', { class: 'card' }, h('h2', {}, 'Jelszó módosítása'), pf),
    h('section', { class: 'card' }, h('h2', {}, 'Veszélyzóna'), df)));
}

/* ---------- útválasztás ---------- */
async function loadMe() { try { const r = await api('GET', '/api/me'); state.me = r.user; state.config.emailEnabled = r.emailEnabled; } catch { state.me = null; } renderNav(); }

const PUBLIC_ONLY = new Set(['login', 'register', 'forgot']);
const PRIVATE = new Set(['dashboard', 'settings']);

async function route() {
  const name = (location.hash.replace(/^#\/?/, '').split('?')[0]) || '';
  if (PRIVATE.has(name) && !state.me) { location.hash = '#/login'; return; }
  if (PUBLIC_ONLY.has(name) && state.me) { location.hash = '#/dashboard'; return; }
  const views = { '': landing, login: loginView, register: registerView, forgot: forgotView, reset: resetView, verify: verifyView, dashboard: dashboardView, settings: settingsView };
  const fn = views[name] || landing;
  try {
    const el = await fn();
    view.replaceChildren(el); renderNav(); window.scrollTo(0, 0);
  } catch (e) {
    if (e.status === 401) { state.me = null; renderNav(); location.hash = '#/login'; return; }
    view.replaceChildren(h('div', { class: 'card' }, errBox(e.message), h('button', { class: 'btn', onclick: route }, 'Újrapróbálás')));
  }
}

window.addEventListener('hashchange', route);
(async () => {
  try { state.config = await api('GET', '/api/config'); } catch { /* alapértelmezés */ }
  await loadMe(); route();
})();
