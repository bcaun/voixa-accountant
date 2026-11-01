-- Closing a client (end of contract, GDPR). Closing ends the client's access at once and
-- starts an export window for the firm (30 days); after it the workspace is blocked (kept
-- only to meet legal duties, visible to no one); once the retention period of its newest
-- file has passed, everything is deleted, log included.

alter table companies add column closed_at timestamptz;
alter table companies add column closed_by uuid references users(id);
alter table companies add column export_until timestamptz;
alter table companies add column blocked_at timestamptz;
alter table companies add column purge_after timestamptz;

-- The log stays append-only, except for the final purge of a closed workspace, which the
-- purge job announces for one company inside its own transaction.
create or replace function events_append_only() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' and current_setting('pescada.purge', true) = old.company_id::text then
    return old;
  end if;
  raise exception 'events is append-only: % is not allowed', tg_op;
end $$;
