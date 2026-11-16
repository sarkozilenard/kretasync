-- Relay mód: a KRÉTA-lekérdezést a felhasználó saját (magyar IP-jű) gépe végzi, és a kész órarendet tölti fel.
create table relay_tokens (
  user_id uuid primary key references users(id) on delete cascade,
  token_hash text not null unique,      -- csak a hash tárolva
  created_at timestamptz not null default now(),
  last_push_at timestamptz,
  last_lessons integer
);
