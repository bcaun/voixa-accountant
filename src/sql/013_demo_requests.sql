-- Demo requests from the website form.
create table demo_requests (
  id          bigserial primary key,
  created_at  timestamptz not null default now(),
  name        text not null,
  firm        text not null,
  email       text not null,
  country     text not null default '',
  clients     text not null default '',
  message     text not null default '',
  lang        text not null default 'en',
  ip          text not null default ''
);
