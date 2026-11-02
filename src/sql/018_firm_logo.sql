-- Pro firms can show their logo on client emails and in their clients' spaces.
alter table firms add column logo bytea, add column logo_type text, add column logo_key text unique;
