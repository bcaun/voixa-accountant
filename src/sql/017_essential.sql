-- The basic plan is called Essential.
alter table firms drop constraint if exists firms_tier_check;
update firms set tier = 'essential' where tier = 'standard';
alter table firms alter column tier set default 'essential';
alter table firms add constraint firms_tier_check check (tier in ('essential', 'pro'));
