-- Sealed PDF reports are kept until the client's log changes, so downloading one again does not
-- spend another timestamp or seal operation.
create table sealed_reports (
  company_id  uuid not null references companies(id) on delete cascade,
  item_id     uuid references items(id) on delete cascade,
  head_seq    bigint not null,
  stamp_id    bigint not null default 0,
  pdf         bytea not null,
  created_at  timestamptz not null default now()
);
create unique index sealed_reports_key on sealed_reports (company_id, coalesce(item_id, '00000000-0000-0000-0000-000000000000'::uuid));
