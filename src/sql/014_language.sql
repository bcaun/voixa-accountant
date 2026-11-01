-- Each person's language for the app and emails; null = the language of their firm's or company's country.
alter table users add column lang text check (lang in ('en', 'es', 'it', 'fr', 'de', 'pt'));
