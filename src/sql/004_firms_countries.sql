-- Several accounting firms on one server, each with its own country, accountants and clients.
-- Accountants belong to one firm and see only that firm's clients. Each client company has a
-- country of its own (by default the firm's), which sets its tax ID format, deadline time zone,
-- deadline templates and how documents are read.
--
-- Existing data moves into one firm named after FIRM_NAME (passed in by migrate.js), in Spain.

create table firms (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  country     text not null default 'ES' check (country in ('ES', 'IT', 'FR', 'DE', 'PT')),
  company_seq integer not null default 0,
  created_at  timestamptz not null default now()
);

do $$
declare f uuid;
begin
  if exists (select 1 from users where role = 'accountant') or exists (select 1 from companies) then
    insert into firms (name, country)
    values (coalesce(nullif(current_setting('pescada.firm_name', true), ''), 'Accounting firm'), 'ES') returning id into f;
    update firms set company_seq = coalesce((select max(no) from companies), 0) where id = f;
  end if;
end $$;

alter table users add column firm_id uuid references firms(id);
update users set firm_id = (select id from firms order by created_at limit 1) where role = 'accountant';
alter table users add constraint accountant_has_firm check (role <> 'accountant' or firm_id is not null);

alter table companies add column firm_id uuid references firms(id);
alter table companies add column country text not null default 'ES' check (country in ('ES', 'IT', 'FR', 'DE', 'PT'));
update companies set firm_id = (select id from firms order by created_at limit 1);
alter table companies alter column firm_id set not null;
create index companies_firm_idx on companies (firm_id, no);

-- client numbers (#1, #2, …) now count per firm
alter table companies drop constraint companies_no_key;
alter table companies alter column no drop default;
alter table companies add constraint companies_firm_no_key unique (firm_id, no);
drop sequence company_no_seq;

-- quarterly and monthly deadlines can fall one, two or three months after the period ends
-- (Italy, Portugal: the 20th of the second month after the quarter)
alter table obligations add column month_offset integer not null default 1 check (month_offset between 1 and 3);
