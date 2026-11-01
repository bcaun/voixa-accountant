// Self sign-up and subscriptions. A firm that signs up gets a trial; to continue it subscribes
// through Stripe Checkout and manages card and invoices in the Stripe customer portal. Stripe
// tells us about changes through a signed webhook. No card data ever touches this server.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { pool, query, tx } from './db.js';
import { HttpError, sendLoginLink } from './auth.js';
import { firmEvent } from './audit.js';
import { isCountry } from './countries.js';

const DAY = 864e5;
export const billingOn = () => !!(config.stripe.secretKey && config.stripe.priceId);

/** Can this firm's accountants change things? Internal and paying firms always; trials until they end. */
export function firmActive(f) {
  if (!f) return true;
  if (f.plan === 'internal' || f.plan === 'active' || f.plan === 'past_due') return true;
  if (f.plan === 'trial') return !f.trial_ends_at || new Date(f.trial_ends_at) > new Date();
  return false;
}

export async function signUp({ firmName, country, name, email }) {
  if (!config.signup.enabled) throw new HttpError(403, 'Sign-up is closed. Write to hello@pescada.io.');
  email = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Enter a valid email address.');
  if (!firmName) throw new HttpError(400, 'Enter the name of your firm.');
  if (!isCountry(country)) throw new HttpError(400, 'Choose your country.');
  return tx(async (c) => {
    const { rows: [existing] } = await c.query('select * from users where email = $1', [email]);
    if (existing) {
      // same answer as for a new address, so the form does not reveal who uses Pescada
      if (!existing.disabled_at) await sendLoginLink(c, existing);
      return { existing: true };
    }
    const { rows: [f] } = await c.query(
      `insert into firms (name, country, plan, trial_ends_at, billing_email) values ($1, $2, 'trial', now() + make_interval(days => $3), $4) returning *`,
      [firmName, country, config.signup.trialDays, email]);
    const { rows: [u] } = await c.query(
      `insert into users (email, name, role, firm_id, firm_role) values ($1, $2, 'accountant', $3, 'admin') returning *`, [email, name, f.id]);
    await c.query('update firms set signed_up_by = $2 where id = $1', [f.id, u.id]);
    await firmEvent(c, f.id, u, 'signed_up', `${name || email} signed the firm up (${config.signup.trialDays}-day trial)`);
    await sendLoginLink(c, u);
    return { firmId: f.id };
  });
}

/* ---------- Stripe ---------- */

async function stripe(path, params, method = 'POST') {
  const body = new URLSearchParams();
  const add = (k, v) => { if (v == null) return; if (typeof v === 'object') for (const [kk, vv] of Object.entries(v)) add(`${k}[${kk}]`, vv); else body.append(k, String(v)); };
  for (const [k, v] of Object.entries(params || {})) add(k, v);
  const res = await fetch(`${config.stripe.apiBase}/v1/${path}`, {
    method, headers: { Authorization: `Bearer ${config.stripe.secretKey}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: method === 'GET' ? undefined : body,
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(502, `Stripe: ${out.error?.message || res.status}`);
  return out;
}

async function quantityFor(firmId) {
  if (config.stripe.quantity === 'firm') return 1;
  const { rows: [r] } = await query('select count(*)::int as n from companies where firm_id = $1 and closed_at is null', [firmId]);
  return Math.max(1, r.n);
}

/** A Stripe Checkout page for the firm's subscription. */
export async function checkoutUrl(user) {
  if (!billingOn()) throw new HttpError(503, 'Online payment is not set up yet. Write to hello@pescada.io to subscribe.');
  const { rows: [f] } = await query('select * from firms where id = $1', [user.firm_id]);
  const s = await stripe('checkout/sessions', {
    mode: 'subscription', client_reference_id: f.id,
    ...(f.stripe_customer_id ? { customer: f.stripe_customer_id } : { customer_email: f.billing_email || user.email }),
    'line_items[0][price]': config.stripe.priceId, 'line_items[0][quantity]': await quantityFor(f.id),
    success_url: `${config.appUrl}/#/billing/done`, cancel_url: `${config.appUrl}/#/billing`,
    allow_promotion_codes: 'true', billing_address_collection: 'required', 'tax_id_collection[enabled]': 'true',
    metadata: { firm_id: f.id },
  });
  return s.url;
}

/** The Stripe customer portal: card, invoices, cancellation. */
export async function portalUrl(user) {
  const { rows: [f] } = await query('select * from firms where id = $1', [user.firm_id]);
  if (!billingOn() || !f.stripe_customer_id) throw new HttpError(409, 'There is no subscription yet.');
  const s = await stripe('billing_portal/sessions', { customer: f.stripe_customer_id, return_url: `${config.appUrl}/#/billing` });
  return s.url;
}

/** Verify Stripe's signature header: t=timestamp,v1=hex HMAC-SHA256 of "t.payload". */
export function verifyStripeSignature(payload, header, secret = config.stripe.webhookSecret, toleranceSec = 300) {
  if (!secret || !header) return false;
  const parts = Object.fromEntries(String(header).split(',').map((p) => p.split('=')).filter((x) => x.length === 2).map(([k, v]) => [k.trim(), v.trim()]));
  const t = Number(parts.t);
  if (!t || Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
  const want = createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
  const sigs = String(header).split(',').filter((p) => p.trim().startsWith('v1=')).map((p) => p.trim().slice(3));
  return sigs.some((s) => s.length === want.length && timingSafeEqual(Buffer.from(s), Buffer.from(want)));
}

const STATUS = { active: 'active', trialing: 'active', past_due: 'past_due', unpaid: 'past_due', canceled: 'canceled', incomplete_expired: 'canceled', incomplete: 'trial' };

export async function handleStripeEvent(ev) {
  const o = ev.data?.object || {};
  if (ev.type === 'checkout.session.completed') {
    const firmId = o.client_reference_id || o.metadata?.firm_id;
    if (!firmId) return false;
    await tx(async (c) => {
      await c.query(`update firms set plan = 'active', stripe_customer_id = $2, stripe_subscription_id = $3 where id = $1`, [firmId, o.customer, o.subscription]);
      await firmEvent(c, firmId, null, 'subscribed', 'The firm subscribed to Pescada');
    });
    return true;
  }
  if (ev.type.startsWith('customer.subscription.')) {
    const plan = ev.type === 'customer.subscription.deleted' ? 'canceled' : STATUS[o.status] || 'active';
    const { rows: [f] } = await pool.query('update firms set plan = $2, stripe_subscription_id = $3 where stripe_customer_id = $1 returning id', [o.customer, plan, o.id]);
    if (f) await firmEvent({ query }, f.id, null, 'subscription_' + plan, `Subscription status: ${plan}`);
    return !!f;
  }
  if (ev.type === 'invoice.payment_failed') {
    const { rows: [f] } = await pool.query(`update firms set plan = 'past_due' where stripe_customer_id = $1 returning id`, [o.customer]);
    if (f) await firmEvent({ query }, f.id, null, 'payment_failed', 'A subscription payment failed');
    return !!f;
  }
  return false;
}

/** Keep each subscription's quantity equal to the firm's open clients (run daily by the scheduler). */
export async function syncQuantities() {
  if (!billingOn() || config.stripe.quantity !== 'clients') return 0;
  const { rows } = await pool.query(`select id, stripe_subscription_id from firms where plan in ('active', 'past_due') and stripe_subscription_id is not null`);
  let n = 0;
  for (const f of rows) {
    try {
      const sub = await stripe(`subscriptions/${f.stripe_subscription_id}`, null, 'GET');
      const item = sub.items?.data?.[0];
      const q = await quantityFor(f.id);
      if (item && item.quantity !== q) { await stripe(`subscriptions/${f.stripe_subscription_id}`, { 'items[0][id]': item.id, 'items[0][quantity]': q, proration_behavior: 'create_prorations' }); n++; }
    } catch (err) { console.error('billing sync', f.id, err.message); }
  }
  return n;
}

export const trialDaysLeft = (f) => (f?.plan === 'trial' && f.trial_ends_at ? Math.max(0, Math.ceil((new Date(f.trial_ends_at) - Date.now()) / DAY)) : null);
