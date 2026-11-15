import postgres from 'postgres';
import { env } from './env';

export type Sql = postgres.Sql<{}>;
let client: Sql | null = null;

export class ConfigError extends Error {}

/** Lusta kapcsolat: hiányzó konfiguráció érthető hibaüzenetet ad, nem félrevezető egyéb hibát. */
export function db(): Sql {
  if (!env.databaseUrl) {
    throw new ConfigError('Az adatbázis nincs beállítva: hiányzik a DATABASE_URL környezeti változó.');
  }
  if (!client) {
    client = postgres(env.databaseUrl, { max: 3, idle_timeout: 10, prepare: false, onnotice: () => {} });
  }
  return client;
}

export async function closeDb() {
  if (client) { await client.end({ timeout: 2 }); client = null; }
}
