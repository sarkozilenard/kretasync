import type { Sql } from './db';
import { HttpError } from './http';

/** Fix ablakú, adatbázisalapú rate limit (szerverless környezetben nincs közös memória). */
export async function rateLimit(sql: Sql, key: string, limit: number, windowSec: number) {
  const [row] = await sql`
    insert into rate_limits (key, window_start, count) values (${key}, now(), 1)
    on conflict (key) do update set
      count = case when rate_limits.window_start < now() - make_interval(secs => ${windowSec}) then 1 else rate_limits.count + 1 end,
      window_start = case when rate_limits.window_start < now() - make_interval(secs => ${windowSec}) then now() else rate_limits.window_start end
    returning count`;
  if (row.count > limit) throw new HttpError(429, 'Túl sok próbálkozás. Kérjük, próbáld újra később.');
}
