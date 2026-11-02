-- Two plans: Standard (bank files and e-invoices read exactly) and Pro (also PDFs and photos read by AI).
alter table firms add column tier text not null default 'standard' check (tier in ('standard', 'pro'));
-- firms that exist today keep what they have
update firms set tier = 'pro';
