import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Egyszerű .env betöltő helyi fejlesztéshez (a Vercel a saját környezeti változóit használja). */
export function loadEnvFile() {
  for (const name of ['.env.local', '.env']) {
    const p = join(__dirname, '..', name);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}
