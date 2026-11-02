-- Tags to group clients ("monthly VAT", "restaurants"), and a private calendar feed per person.
alter table companies add column tags text[] not null default '{}';
create index companies_tags_idx on companies using gin (tags);
alter table users add column calendar_token text unique;
