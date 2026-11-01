-- Bank statements fetched through open banking (PSD2 account information, through a licensed
-- provider). The client authorises access at their bank; Pescada then fetches new movements and
-- stores them as a statement file, so they go through the same log and matching as uploads.
create table bank_connections (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references companies(id),
  provider         text not null,
  institution_id   text not null,
  institution_name text not null,
  requisition_id   text,
  reference        text not null unique,
  status           text not null default 'pending' check (status in ('pending', 'linked', 'expired', 'error', 'removed')),
  accounts         jsonb not null default '[]',
  created_by       uuid references users(id),
  created_at       timestamptz not null default now(),
  linked_at        timestamptz,
  expires_at       timestamptz,
  last_sync_at     timestamptz,
  last_error       text
);
create index bank_connections_company_idx on bank_connections (company_id);

create table bank_feed_seen (
  connection_id  uuid not null references bank_connections(id),
  tx_id          text not null,
  primary key (connection_id, tx_id)
);
