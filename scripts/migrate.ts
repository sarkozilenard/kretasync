import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnvFile } from './env-file';
import { closeDb, db } from '../src/db';

loadEnvFile();

async function main() {
  const sql = db();
  await sql`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
  const dir = join(__dirname, '..', 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    const [done] = await sql`select 1 from schema_migrations where name = ${f}`;
    if (done) { console.log(`- ${f} (már lefutott)`); continue; }
    await sql.begin(async (tx: any) => {
      await tx.unsafe(readFileSync(join(dir, f), 'utf8'));
      await tx`insert into schema_migrations (name) values (${f})`;
    });
    console.log(`+ ${f} lefutott`);
  }
  await closeDb();
}

main().catch((e) => { console.error('Migrációs hiba:', e.message); process.exit(1); });
