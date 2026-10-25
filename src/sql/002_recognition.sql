-- Automatic recognition of bank statements and invoices, and matching of
-- bank payments to the invoices a client uploaded.

create table jobs (
  id          bigserial primary key,
  kind        text not null check (kind in ('recognise')),
  item_id     uuid not null references items(id),
  version_id  uuid not null references versions(id),
  as_kind     text check (as_kind in ('statement', 'invoice')),
  status      text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  attempts    integer not null default 0,
  error       text,
  run_after   timestamptz not null default now(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index jobs_queue_idx on jobs (run_after) where status in ('queued', 'failed');

-- one recognition result per file version
create table extractions (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references companies(id),
  item_id     uuid not null references items(id),
  version_id  uuid not null references versions(id),
  kind        text not null check (kind in ('statement', 'invoice')),
  status      text not null check (status in ('done', 'failed', 'unsupported')),
  method      text not null default '',     -- norma43, camt053, csv, ai
  model       text,
  summary     jsonb not null default '{}',  -- bank, iban, period, balances / invoice fields
  error       text,
  created_at  timestamptz not null default now(),
  unique (version_id, kind)
);
create index extractions_item_idx on extractions (item_id);

create table bank_transactions (
  id                  uuid primary key default gen_random_uuid(),
  extraction_id       uuid not null references extractions(id) on delete cascade,
  company_id          uuid not null references companies(id),
  item_id             uuid not null references items(id),
  line                integer not null,
  booking_date        date,
  value_date          date,
  amount              numeric(16, 2) not null,     -- negative = money out of the account
  currency            text not null default 'EUR',
  counterparty_name   text,
  counterparty_iban   text,
  counterparty_tax_id text,
  purpose             text not null default '',
  invoice_refs        text[] not null default '{}',
  contract_refs       text[] not null default '{}',
  bank_reference      text
);
create index bank_tx_company_idx on bank_transactions (company_id);

create table invoice_data (
  extraction_id     uuid primary key references extractions(id) on delete cascade,
  company_id        uuid not null references companies(id),
  item_id           uuid not null references items(id),
  invoice_number    text,
  issue_date        date,
  due_date          date,
  issuer_name       text,
  issuer_tax_id     text,
  recipient_name    text,
  recipient_tax_id  text,
  currency          text,
  net_amount        numeric(16, 2),
  tax_amount        numeric(16, 2),
  total_amount      numeric(16, 2),
  contract_number   text,
  direction         text not null default 'unknown' check (direction in ('issued', 'received', 'unknown'))
);
create index invoice_data_company_idx on invoice_data (company_id);

create table payment_matches (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references companies(id),
  transaction_id  uuid not null references bank_transactions(id) on delete cascade,
  invoice_item_id uuid not null references items(id),
  score           integer not null,
  reasons         text[] not null default '{}',
  status          text not null default 'suggested' check (status in ('suggested', 'confirmed', 'rejected')),
  decided_by      uuid references users(id),
  decided_at      timestamptz,
  created_at      timestamptz not null default now(),
  unique (transaction_id, invoice_item_id)
);
create index payment_matches_company_idx on payment_matches (company_id);
