import { env } from './env';

/** Resend API-n át; ha nincs beállítva, a hívó oldalon a funkció ki van kapcsolva. */
export async function sendEmail(to: string, subject: string, text: string) {
  if (!env.emailEnabled) throw new Error('Az e-mail-szolgáltató nincs beállítva.');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.resendApiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: env.emailFrom, to, subject, text }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`E-mail küldési hiba (${res.status}).`);
}
