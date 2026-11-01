-- Self sign-up waits for the email to be confirmed: nothing is created until the link is opened.
create table signup_requests (
  id          uuid primary key default gen_random_uuid(),
  token_hash  text not null unique,
  firm_name   text not null,
  country     text not null,
  name        text not null default '',
  email       text not null,
  ip          text not null default '',
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz
);
create index signup_requests_created_idx on signup_requests (created_at);
create index signup_requests_ip_idx on signup_requests (ip, created_at);
create index signup_requests_email_idx on signup_requests (email, created_at);
