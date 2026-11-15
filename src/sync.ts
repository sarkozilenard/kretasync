import type { Sql } from './db';
import { decrypt, encrypt } from './crypto';
import { env } from './env';
import { addDays, budapestDate } from './time';
import { createKretaClient, KretaApi, KretaAuthError, KretaLesson } from './kreta/client';

export interface SyncResult { ok: boolean; busy?: boolean; lessons?: number; error?: string }

const publicMsg = (e: unknown) => (e instanceof Error ? e.message : 'Ismeretlen hiba a szinkronizálás során.');

/** Egy lekért órarend beírása: upsert (nincs duplikáció, a módosult óra ugyanazt az azonosítót kapja), az ablakból kikerült órák törlése. */
export async function applyLessons(sql: Sql, userId: string, lessons: KretaLesson[], from: string, to: string) {
  await sql.begin(async (tx: any) => {
    for (const l of lessons) {
      await tx`
        insert into lessons (user_id, external_id, lesson_name, start_date, end_date, lesson_index, classroom_name, teacher_name, substitute_teacher_name)
        values (${userId}, ${l.external_id}, ${l.lesson_name}, ${l.start_date}, ${l.end_date}, ${l.lesson_index}, ${l.classroom_name}, ${l.teacher_name}, ${l.substitute_teacher_name})
        on conflict (user_id, external_id) do update set
          lesson_name = excluded.lesson_name, start_date = excluded.start_date, end_date = excluded.end_date,
          lesson_index = excluded.lesson_index, classroom_name = excluded.classroom_name,
          teacher_name = excluded.teacher_name, substitute_teacher_name = excluded.substitute_teacher_name,
          updated_at = case when (lessons.lesson_name, lessons.start_date, lessons.end_date, lessons.lesson_index, lessons.classroom_name,
                                  lessons.teacher_name, lessons.substitute_teacher_name)
                              is not distinct from
                              (excluded.lesson_name, excluded.start_date, excluded.end_date, excluded.lesson_index, excluded.classroom_name,
                               excluded.teacher_name, excluded.substitute_teacher_name)
                            then lessons.updated_at else now() end`;
    }
    const ids = lessons.map((l) => l.external_id);
    // Az ablakban lévő, de a KRÉTA által már nem adott (törölt/elmaradt) órák eltávolítása
    await tx`delete from lessons where user_id = ${userId} and start_date >= ${from + ' 00:00'} and start_date <= ${to + ' 23:59'}
             and external_id <> all(${ids}::text[])`;
    // Régi órák karbantartása (30 napnál régebbiek)
    await tx`delete from lessons where user_id = ${userId} and start_date < ${addDays(from, -30) + ' 00:00'}`;
  });
}

export async function syncUser(sql: Sql, userId: string, kreta: KretaApi = createKretaClient()): Promise<SyncResult> {
  // Párhuzamos futások kizárása (a refresh token forgatása miatt fontos)
  const claimed = await sql`
    update kreta_connections set syncing_at = now()
    where user_id = ${userId} and (syncing_at is null or syncing_at < now() - interval '2 minutes')
    returning institute_code, refresh_token_enc`;
  if (!claimed.length) {
    const exists = await sql`select 1 from kreta_connections where user_id = ${userId}`;
    return exists.length ? { ok: false, busy: true, error: 'A szinkronizálás már folyamatban van.' } : { ok: false, error: 'Nincs KRÉTA-kapcsolat beállítva.' };
  }
  const { institute_code, refresh_token_enc } = claimed[0];

  try {
    const tokens = await kreta.refresh(decrypt(refresh_token_enc), institute_code);
    // A refresh token forgatódik: azonnal mentjük az újat
    await sql`update kreta_connections set refresh_token_enc = ${encrypt(tokens.refresh_token)}, updated_at = now() where user_id = ${userId}`;

    const from = budapestDate();
    const to = addDays(from, env.syncDays);
    const lessons = await kreta.getLessons(tokens.access_token, institute_code, from, to, env.kretaTimesAreUtc);
    await applyLessons(sql, userId, lessons, from, to);

    await sql`update kreta_connections set connection_status = 'connected', last_sync_at = now(), last_error = null, syncing_at = null, updated_at = now() where user_id = ${userId}`;
    await sql`insert into sync_logs (user_id, success, lessons_seen) values (${userId}, true, ${lessons.length})`;
    return { ok: true, lessons: lessons.length };
  } catch (e) {
    const msg = publicMsg(e);
    const status = e instanceof KretaAuthError ? 'reauth_required' : 'error';
    await sql`update kreta_connections set connection_status = ${status}, last_error = ${msg}, syncing_at = null, updated_at = now() where user_id = ${userId}`;
    await sql`insert into sync_logs (user_id, success, message) values (${userId}, false, ${msg})`;
    console.error('sync failed', { userId, status, message: msg }); // nincs token/jelszó a naplóban
    return { ok: false, error: msg };
  }
}

/** Cron: a legrégebben szinkronizált kapcsolatok először, időkerettel. */
export async function syncDue(sql: Sql, budgetMs = 50_000, kreta?: KretaApi) {
  const started = Date.now();
  const rows = await sql`
    select user_id from kreta_connections
    where connection_status in ('connected', 'error')
      and (last_sync_at is null or last_sync_at < now() - make_interval(hours => ${env.syncIntervalHours}) + interval '5 minutes')
    order by last_sync_at asc nulls first limit 500`;
  let ok = 0, failed = 0;
  for (const r of rows) {
    if (Date.now() - started > budgetMs) break;
    const res = await syncUser(sql, r.user_id, kreta);
    res.ok ? ok++ : failed++;
  }
  return { due: rows.length, ok, failed };
}
