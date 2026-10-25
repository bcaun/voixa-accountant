-- Token usage and cost of every call to the AI reader, so spending can be
-- followed per client and per month and compared with Anthropic's invoice.
create table ai_usage (
  id                    bigserial primary key,
  company_id            uuid not null references companies(id),
  item_id               uuid references items(id),
  version_id            uuid references versions(id),
  kind                  text not null,               -- statement | invoice
  model                 text not null,               -- model that answered
  requested_model       text not null,
  outcome               text not null,               -- ok | refused | too_long | bad_output | not_a_match | error
  input_tokens          integer not null default 0,
  output_tokens         integer not null default 0,
  cache_write_tokens    integer not null default 0,
  cache_read_tokens     integer not null default 0,
  cost_usd              numeric(12, 6) not null default 0,
  usage                 jsonb not null default '{}', -- raw usage block from the API, kept for audit
  created_at            timestamptz not null default now()
);
create index ai_usage_company_idx on ai_usage (company_id, created_at);
create index ai_usage_created_idx on ai_usage (created_at);
