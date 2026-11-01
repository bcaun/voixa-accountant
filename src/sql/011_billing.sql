-- Firms that sign up themselves start a trial; with Stripe configured they subscribe through
-- Stripe Checkout. Firms created on the command line are "internal" (no billing).
alter table firms add column plan text not null default 'internal' check (plan in ('internal', 'trial', 'active', 'past_due', 'canceled'));
alter table firms add column trial_ends_at timestamptz;
alter table firms add column stripe_customer_id text;
alter table firms add column stripe_subscription_id text;
alter table firms add column billing_email text;
alter table firms add column signed_up_by uuid references users(id);
create unique index firms_stripe_customer_idx on firms (stripe_customer_id) where stripe_customer_id is not null;
