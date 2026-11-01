-- Daily digest for accountants: instead of an email per event, notifications are collected
-- and sent once a day (urgent ones still go out at once). One digest email covers many items,
-- so email_items links it to each of them; delivery and opening are logged on every item.

alter table users add column notify_mode text check (notify_mode in ('instant', 'digest'));  -- null: accountants digest, clients instant
alter table users add column digest_hour integer not null default 8 check (digest_hour between 0 and 23);
alter table users add column last_digest_at timestamptz;

create table digest_entries (
  id          bigserial primary key,
  user_id     uuid not null references users(id),
  company_id  uuid not null references companies(id),
  item_id     uuid references items(id),
  kind        text not null,
  subject     text not null,
  line        text not null,
  created_at  timestamptz not null default now(),
  email_id    uuid references email_messages(id)
);
create index digest_pending_idx on digest_entries (user_id) where email_id is null;

create table email_items (
  id          bigserial primary key,
  email_id    uuid not null references email_messages(id),
  company_id  uuid not null references companies(id),
  item_id     uuid references items(id)
);
create index email_items_email_idx on email_items (email_id);
