export class HttpError extends Error {
  constructor(public status: number, message: string, public extra?: Record<string, unknown>) { super(message); }
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

export function parseCookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.get('cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export const isHttps = (req: Request) =>
  (req.headers.get('x-forwarded-proto') || new URL(req.url).protocol.replace(':', '')) === 'https';

export function sessionCookie(req: Request, value: string, maxAgeSec: number) {
  return `ks_session=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${isHttps(req) ? '; Secure' : ''}`;
}

export function clientIp(req: Request) {
  return (req.headers.get('x-real-ip') || req.headers.get('x-forwarded-for')?.split(',')[0] || 'unknown').trim();
}

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (text.length > 20_000) throw new HttpError(413, 'Túl nagy kérés.');
  try {
    const v = JSON.parse(text || '{}');
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch { /* alább hiba */ }
  throw new HttpError(400, 'Érvénytelen JSON.');
}

/** CSRF: módosító kéréseknél kötelező az egyedi fejléc (böngésző űrlap/cross-site nem tudja beállítani) + Origin egyezés. */
export function assertCsrf(req: Request) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
  if (req.headers.get('x-requested-with') !== 'kretasync') throw new HttpError(403, 'Érvénytelen kérés (CSRF).');
  const origin = req.headers.get('origin');
  if (origin) {
    const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || new URL(req.url).host;
    if (new URL(origin).host !== host) throw new HttpError(403, 'Érvénytelen kérés eredete.');
  }
}
