-- Web Push: the browsers and installed apps that asked for notifications, and what is waiting to go out.
create table push_subscriptions (
  endpoint    text primary key,
  user_id     uuid not null references users(id) on delete cascade,
  p256dh      text not null,
  auth        text not null,
  user_agent  text not null default '',
  created_at  timestamptz not null default now()
);
create index push_subscriptions_user_idx on push_subscriptions (user_id);
create table push_messages (
  id          bigserial primary key,
  user_id     uuid not null references users(id) on delete cascade,
  title       text not null,
  body        text not null default '',
  url         text not null default '/',
  created_at  timestamptz not null default now(),
  sent_at     timestamptz
);
create index push_messages_pending_idx on push_messages (id) where sent_at is null;
-- keys the server makes for itself once (VAPID for Web Push)
create table app_settings (key text primary key, value text not null);
