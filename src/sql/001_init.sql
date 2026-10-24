-- Voixa Exchange: initial schema.
-- The events table is the evidence log. Rows are hash-chained per company and
-- the trigger at the bottom refuses UPDATE, DELETE and TRUNCATE on it.

create extension if not exists citext;

create table users (
  id          uuid primary key default gen_random_uuid(),
  email       citext not null unique,
  name        text not null default '',
  role        text not null check (role in ('accountant', 'client')),
  created_at  timestamptz not null default now(),
  disabled_at timestamptz
);

create sequence company_no_seq;

create table companies (
  id          uuid primary key default gen_random_uuid(),
  no          integer not null unique default nextval('company_no_seq'),
  name        text not null,
  nif         text not null default '',
  city        text not null default '',
  created_at  timestamptz not null default now(),
  created_by  uuid references users(id),
  -- head of the company's event chain, updated in the same transaction as each insert
  head_seq    bigint not null default 0,
  head_hash   text not null default '',
  item_seq    integer not null default 0
);

create table memberships (
  company_id  uuid not null references companies(id),
  user_id     uuid not null references users(id),
  added_by    uuid references users(id),
  created_at  timestamptz not null default now(),
  removed_at  timestamptz,
  primary key (company_id, user_id)
);

create table login_tokens (
  token_hash  text primary key,
  user_id     uuid not null references users(id),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz
);

create table sessions (
  id_hash     text primary key,
  user_id     uuid not null references users(id),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  user_agent  text not null default '',
  ip          text not null default ''
);

create table obligations (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references companies(id),
  kind        text not null check (kind in ('request', 'report')),
  title       text not null,
  category    text not null default 'Other',
  frequency   text not null check (frequency in ('monthly', 'quarterly', 'yearly')),
  due_day     integer not null check (due_day between 1 and 31),
  due_month   integer check (due_month between 1 and 12),
  lead_days   integer not null default 7 check (lead_days between 0 and 60),
  note        text not null default '',
  active      boolean not null default true,
  created_by  uuid references users(id),
  created_at  timestamptz not null default now()
);

create table items (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references companies(id),
  seq              integer not null,
  kind             text not null check (kind in ('doc', 'report', 'request')),
  title            text not null,
  category         text not null default 'Other',
  period           text not null default '',
  note             text not null default '',
  due_at           timestamptz,
  obligation_id    uuid references obligations(id),
  for_request      uuid references items(id),
  fulfilled_by     uuid references items(id),
  created_by       uuid references users(id),
  created_at       timestamptz not null default now(),
  -- cached status, recomputed from events after every change
  state            text not null default 'sent' check (state in ('expected', 'sent', 'opened', 'done')),
  version          integer not null default 0,
  sent_at          timestamptz,
  version_at       timestamptz,
  opened_at        timestamptz,
  done_at          timestamptz,
  reminders        integer not null default 0,
  auto_reminders   integer not null default 0,
  last_reminder_at timestamptz,
  unique (company_id, seq),
  unique (obligation_id, due_at)
);
create index items_company_idx on items (company_id);
create index items_open_idx on items (state) where state <> 'done';

create table versions (
  id             uuid primary key default gen_random_uuid(),
  item_id        uuid not null references items(id),
  version        integer not null,
  storage_key    text not null,
  file_name      text not null,
  mime           text not null default 'application/octet-stream',
  size           bigint not null,
  sha256         text not null,
  uploaded_by    uuid references users(id),
  uploaded_at    timestamptz not null default now(),
  replace_reason text not null default '',
  unique (item_id, version)
);

create table events (
  id          bigserial primary key,
  company_id  uuid not null references companies(id),
  seq         bigint not null,
  at          timestamptz not null,
  actor_type  text not null check (actor_type in ('client', 'accountant', 'system')),
  actor_id    uuid references users(id),
  actor_name  text not null,
  type        text not null,
  item_id     uuid references items(id),
  version_id  uuid references versions(id),
  text        text not null,
  data        jsonb not null default '{}',
  prev_hash   text not null,
  hash        text not null,
  unique (company_id, seq)
);
create index events_item_idx on events (item_id, seq);

create table email_messages (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid references companies(id),
  item_id       uuid references items(id),
  to_user_id    uuid references users(id),
  to_email      text not null,
  kind          text not null,
  subject       text not null,
  html          text not null,
  body_text     text not null,
  status        text not null default 'queued'
                check (status in ('queued', 'sending', 'sent', 'delivered', 'opened', 'bounced', 'spam_complaint', 'failed')),
  provider_id   text,
  attempts      integer not null default 0,
  error         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index email_queue_idx on email_messages (status) where status in ('queued', 'failed');
create index email_item_idx on email_messages (item_id);

create function events_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'events is append-only: % is not allowed', tg_op;
end $$;

create trigger events_no_update before update or delete on events
  for each row execute function events_append_only();
create trigger events_no_truncate before truncate on events
  for each statement execute function events_append_only();
