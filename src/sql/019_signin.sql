-- Sign-in: devices already seen (to warn about new ones), passkeys, and Google / Microsoft accounts.
create table known_devices (
  user_id     uuid not null references users(id) on delete cascade,
  device_hash text not null,
  label       text not null,
  first_seen  timestamptz not null default now(),
  last_seen   timestamptz not null default now(),
  primary key (user_id, device_hash)
);

-- "This was not me" links in new-device emails: one click signs out everywhere
create table signin_alerts (
  token_hash  text primary key,
  user_id     uuid not null references users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz
);

create table passkeys (
  id            text primary key,           -- credential ID, base64url
  user_id       uuid not null references users(id) on delete cascade,
  public_key    bytea not null,
  counter       bigint not null default 0,
  transports    text[] not null default '{}',
  name          text not null default '',
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz
);
create index passkeys_user_idx on passkeys (user_id);

create table user_identities (
  provider    text not null check (provider in ('google', 'microsoft')),
  subject     text not null,                -- the provider's stable ID for the person
  user_id     uuid not null references users(id) on delete cascade,
  email       text not null default '',
  created_at  timestamptz not null default now(),
  last_used_at timestamptz,
  primary key (provider, subject)
);
create index user_identities_user_idx on user_identities (user_id);

-- short-lived state for passkey ceremonies and Google / Microsoft redirects
create table auth_challenges (
  id          text primary key,
  kind        text not null,
  user_id     uuid references users(id) on delete cascade,
  data        jsonb not null default '{}',
  expires_at  timestamptz not null
);
