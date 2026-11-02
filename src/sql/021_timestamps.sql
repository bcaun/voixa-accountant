-- Trusted timestamps (RFC 3161) sealing the heads of the clients' logs.
create table timestamps (
  id          bigserial primary key,
  created_at  timestamptz not null default now(),
  tsa_url     text not null,
  tsa_name    text not null default '',
  qualified   boolean not null default false,
  digest      text not null,          -- SHA-256 of the manifest, as sent to the TSA
  manifest    text not null,          -- one line per client: "<company id> <entry number> <entry hash>"
  token       bytea not null,         -- the TSA's signed token (CMS), as returned
  gen_time    timestamptz not null,   -- the time the TSA put in the token
  serial      text not null,
  policy      text not null default '',
  signer      text
);
create table timestamp_entries (
  timestamp_id bigint not null references timestamps(id) on delete cascade,
  company_id   uuid not null references companies(id) on delete cascade,
  seq          bigint not null,
  hash         text not null,
  primary key (timestamp_id, company_id)
);
create index timestamp_entries_company_idx on timestamp_entries (company_id, seq desc);
