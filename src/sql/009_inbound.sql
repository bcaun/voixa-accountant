-- Each client workspace gets a private email address (<key>@INBOUND_DOMAIN): attachments sent there
-- by the client's own people become documents, exactly as if they had been uploaded.
alter table companies add column inbound_key text;
update companies set inbound_key = substr(replace(gen_random_uuid()::text, '-', ''), 1, 14) where inbound_key is null;
alter table companies alter column inbound_key set default substr(replace(gen_random_uuid()::text, '-', ''), 1, 14);
alter table companies alter column inbound_key set not null;
create unique index companies_inbound_key_idx on companies (inbound_key);
