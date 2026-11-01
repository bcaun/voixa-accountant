-- The firm's team: administrators manage settings and people; staff do the work. An accountant
-- either sees every client of the firm or only the clients assigned to them.

alter table users add column firm_role text check (firm_role in ('admin', 'staff'));
update users set firm_role = 'admin' where role = 'accountant';
alter table users add constraint accountant_has_role check (role <> 'accountant' or firm_role is not null);
alter table users add column all_clients boolean not null default true;

create table company_assignments (
  company_id  uuid not null references companies(id),
  user_id     uuid not null references users(id),
  created_at  timestamptz not null default now(),
  primary key (company_id, user_id)
);
create index company_assignments_user_idx on company_assignments (user_id);

-- Can this accountant see this client? Same firm, account active, and all clients or assigned.
create function accountant_sees(cid uuid, uid uuid) returns boolean language sql stable as $$
  select exists (
    select 1 from users u join companies c on c.firm_id = u.firm_id
    where u.id = uid and c.id = cid and u.role = 'accountant' and u.disabled_at is null
      and (u.all_clients or exists (select 1 from company_assignments a where a.company_id = c.id and a.user_id = u.id)));
$$;

-- accountants created without a role (command line, older code) are administrators
create function default_firm_role() returns trigger language plpgsql as $$
begin
  if new.role = 'accountant' and new.firm_role is null then new.firm_role := 'admin'; end if;
  return new;
end $$;
create trigger users_default_firm_role before insert or update on users for each row execute function default_firm_role();
