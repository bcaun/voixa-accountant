-- Second factor for accountants, session housekeeping and the firm's own audit log.

alter table users add column totp_secret text;            -- sealed (AES-256-GCM), see src/totp.js
alter table users add column totp_pending text;           -- sealed secret during set-up, until the first code is confirmed
alter table users add column totp_enabled_at timestamptz;
alter table users add column totp_last_step bigint;       -- a code cannot be used twice
alter table users add column recovery_codes text[] not null default '{}';  -- SHA-256 of unused recovery codes

alter table firms add column require_mfa boolean not null default false;

alter table sessions add column mfa_pending boolean not null default false;
alter table sessions add column last_seen_at timestamptz not null default now();

-- what happens to the firm itself (settings, team, security), apart from any client's log
create table firm_events (
  id          bigserial primary key,
  firm_id     uuid not null references firms(id),
  at          timestamptz not null default now(),
  actor_id    uuid references users(id),
  actor_name  text not null,
  type        text not null,
  text        text not null,
  data        jsonb not null default '{}'
);
create index firm_events_idx on firm_events (firm_id, at desc);
