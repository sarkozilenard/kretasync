create extension if not exists pgcrypto;

create table users (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  password_hash text not null,
  password_salt text not null,
  email_verified_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index users_email_lower_idx on users (lower(email));

create table sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index sessions_user_idx on sessions (user_id);

create table calendars (
  user_id uuid primary key references users(id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  rotated_at timestamptz
);

create table lessons (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  external_id text not null,
  lesson_name text not null,
  start_date text not null,   -- "YYYY-MM-DD HH:MM", Europe/Budapest helyi idő (mint a kreta.py-ban)
  end_date text not null,
  lesson_index integer,
  classroom_name text,
  teacher_name text,
  substitute_teacher_name text,
  updated_at timestamptz not null default now(),
  unique (user_id, external_id)
);
create index lessons_user_start_idx on lessons (user_id, start_date);

create table kreta_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references users(id) on delete cascade,
  institute_code text not null,
  refresh_token_enc text not null,        -- AES-256-GCM; a KRÉTA-jelszó SOHA nem kerül tárolásra
  connection_status text not null default 'connected', -- connected | error | reauth_required
  last_sync_at timestamptz,
  last_error text,
  syncing_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table password_reset_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz
);

create table email_verification_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz
);

create table rate_limits (
  key text primary key,
  window_start timestamptz not null,
  count integer not null
);

create table sync_logs (
  id bigserial primary key,
  user_id uuid not null references users(id) on delete cascade,
  started_at timestamptz not null default now(),
  success boolean not null,
  lessons_seen integer,
  message text
);
create index sync_logs_user_idx on sync_logs (user_id, started_at desc);
