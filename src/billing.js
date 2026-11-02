// Self sign-up and subscriptions. A firm that signs up gets a trial; to continue it subscribes
// through Stripe Checkout and manages card and invoices in the Stripe customer portal. Stripe
// tells us about changes through a signed webhook. No card data ever touches this server.
import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import { config } from './config.js';
import { pool, query, tx } from './db.js';
import { HttpError, sendLoginLink } from './auth.js';
import { firmEvent } from './audit.js';
import { isCountry } from './countries.js';
import { isDisposable } from './disposable.js';
import { sha256 } from './ledger.js';
import { queueEmail, renderEmail, sendDirect } from './mailer.js';
import { translator, langFor } from './i18n.js';
import { alert } from './alerts.js';

const DAY = 864e5;
export const billingOn = () => !!(config.stripe.secretKey && config.stripe.priceId);
export const TIERS = ['standard', 'pro'];

/** PDFs and photos are read by AI on the Pro plan, and during the trial so firms can try it. */
export const aiReadingAllowed = (f) => !f || f.tier === 'pro' || f.plan === 'trial';
const tierOfPrice = (priceId) => (priceId && priceId === config.stripe.priceIdPro ? 'pro' : 'standard');

/** Can this firm's accountants change things? Internal and paying firms always; trials until they end. */
export function firmActive(f) {
  if (!f) return true;
  if (f.plan === 'internal' || f.plan === 'active' || f.plan === 'past_due') return true;
  if (f.plan === 'trial') return !f.trial_ends_at || new Date(f.trial_ends_at) > new Date();
  return false;
}

const MIN_FILL_MS = 3000; // people take longer than this to fill in the form
const SIGNUP_LINK_HOURS = 24;

/**
 * Someone asks to sign a firm up. Nothing is created yet: we email a link, and the firm and its
 * first administrator are created only when that link is opened (confirmSignup). Robots that fill
 * the hidden field or submit instantly get the same answer as people and nothing happens.
 */
export async function signUp({ firmName, country, name, email, website, ms, ip = '' }) {
  if (!config.signup.enabled) throw new HttpError(403, 'Sign-up is closed. Write to hello@pescada.io.');
  email = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Enter a valid email address.');
  if (!firmName) throw new HttpError(400, 'Enter the name of your firm.');
  if (!isCountry(country)) throw new HttpError(400, 'Choose your country.');
  if (website || !(Number(ms) >= MIN_FILL_MS)) return { ignored: true };
  if (isDisposable(email)) throw new HttpError(400, 'Use your work email address.');
  return tx(async (c) => {
    await c.query(`delete from signup_requests where created_at < now() - interval '2 days'`);
    const { rows: [n] } = await c.query(
      `select count(*) filter (where ip = $1 and created_at > now() - interval '1 hour')::int as ip,
              count(*) filter (where email = $2 and created_at > now() - interval '1 day')::int as email,
              count(*) filter (where created_at > now() - interval '1 day')::int as day
       from signup_requests`, [ip, email]);
    if (n.ip >= 5) throw new HttpError(429, 'Too many sign-ups from here. Try again later.');
    if (n.email >= 3) return { ignored: true }; // the links already sent still work
    if (n.day >= config.signup.dailyMax) {
      alert('Sign-up limit reached', `${n.day} sign-up requests in the last 24 hours (SIGNUP_DAILY_MAX=${config.signup.dailyMax}). New ones are refused until the count drops. Last attempt: ${firmName} <${email}> from ${ip}.`);
      throw new HttpError(429, 'Sign-up is busy right now. Try again tomorrow, or write to hello@pescada.io.');
    }
    const { rows: [existing] } = await c.query('select * from users where email = $1', [email]);
    if (existing) {
      // same answer as for a new address, so the form does not reveal who uses Pescada
      if (!existing.disabled_at) await sendLoginLink(c, existing);
      await c.query(`insert into signup_requests (token_hash, firm_name, country, name, email, ip, expires_at, used_at) values ($1,$2,$3,$4,$5,$6, now(), now())`,
        [sha256(randomBytes(32).toString('base64url')), firmName, country, name || '', email, ip]);
      return { existing: true };
    }
    const token = randomBytes(32).toString('base64url');
    await c.query(`insert into signup_requests (token_hash, firm_name, country, name, email, ip, expires_at) values ($1,$2,$3,$4,$5,$6, now() + make_interval(hours => $7))`,
      [sha256(token), firmName, country, name || '', email, ip, SIGNUP_LINK_HOURS]);
    const t = translator(langFor(null, country));
    const heading = t('Confirm your email to start with Pescada');
    const { html, text } = renderEmail({
      heading,
      lines: [t('Use the button below to create the {firm} space on Pescada and sign in. The link works once and expires in 24 hours.', { firm: firmName }),
        t('If you did not ask for this, ignore this email.')],
      button: { label: t('Confirm and sign in'), url: `${config.appUrl}/auth/verify?token=${token}` },
      footer: t('Pescada. Documents you exchange there, and every action on them, are recorded in your workspace log.'),
    });
    await queueEmail(c, { toEmail: email, kind: 'signup', subject: heading, html, text });
    return { requested: true };
  });
}

/** The sign-up link was opened: create the trial firm and its administrator. Returns the user, or null. */
export async function confirmSignup(token) {
  const out = await tx(async (c) => {
    const { rows: [r] } = await c.query(
      `update signup_requests set used_at = now() where token_hash = $1 and used_at is null and expires_at > now() returning *`, [sha256(String(token || ''))]);
    if (!r) return null;
    const { rows: [existing] } = await c.query('select * from users where email = $1', [r.email]);
    if (existing) return existing.disabled_at ? null : { user: existing }; // signed up twice: just sign in
    const { rows: [f] } = await c.query(
      `insert into firms (name, country, plan, trial_ends_at, billing_email) values ($1, $2, 'trial', now() + make_interval(days => $3), $4) returning *`,
      [r.firm_name, r.country, config.signup.trialDays, r.email]);
    const { rows: [u] } = await c.query(
      `insert into users (email, name, role, firm_id, firm_role) values ($1, $2, 'accountant', $3, 'admin') returning *`, [r.email, r.name, f.id]);
    await c.query('update firms set signed_up_by = $2 where id = $1', [f.id, u.id]);
    await firmEvent(c, f.id, u, 'signed_up', `${r.name || r.email} signed the firm up (${config.signup.trialDays}-day trial)`);
    return { user: u, request: r };
  });
  if (out?.request) {
    const r = out.request;
    sendDirect(config.signup.notifyEmail, `New firm signed up: ${r.firm_name} (${r.country})`,
      `Firm: ${r.firm_name}\nCountry: ${r.country}\nName: ${r.name}\nEmail: ${r.email}\nIP: ${r.ip}\nTrial: ${config.signup.trialDays} days`).catch((err) => console.error('signup mail', err.message));
  }
  return out?.user || null;
}

/** Trial firms can have a limited number of clients. */
export async function checkTrialClients(c, firm) {
  if (firm?.plan !== 'trial') return;
  const { rows: [n] } = await c.query('select count(*)::int as n from companies where firm_id = $1 and closed_at is null', [firm.id]);
  if (n.n >= config.signup.trialMaxClients) {
    throw Object.assign(new HttpError(403, `During the trial a firm can have up to ${config.signup.trialMaxClients} clients. Subscribe to add more, or write to hello@pescada.io.`), { code: 'trial_limit' });
  }
}

/** Trial firms can send a limited number of invitations a day, so a fake firm cannot use Pescada to send spam. */
export async function checkTrialInvites(c, firmId) {
  if (!firmId) return;
  const { rows: [f] } = await c.query('select plan from firms where id = $1', [firmId]);
  if (f?.plan !== 'trial') return;
  const { rows: [n] } = await c.query(
    `select count(*)::int as n from email_messages m
     where m.kind = 'invite' and m.created_at > now() - interval '1 day'
       and (m.company_id in (select id from companies where firm_id = $1) or m.to_user_id in (select id from users where firm_id = $1))`, [firmId]);
  if (n.n >= config.signup.trialMaxInvites) {
    alert('Trial invitation limit reached', `Firm ${firmId} reached ${n.n} invitations in 24 hours during its trial.`);
    throw Object.assign(new HttpError(429, `During the trial a firm can send up to ${config.signup.trialMaxInvites} invitations a day. Try again tomorrow, or write to hello@pescada.io.`), { code: 'trial_limit' });
  }
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
export async function checkoutUrl(user, tier = 'standard') {
  if (!billingOn()) throw new HttpError(503, 'Online payment is not set up yet. Write to hello@pescada.io to subscribe.');
  if (!TIERS.includes(tier)) throw new HttpError(400, 'Choose a plan.');
  const price = tier === 'pro' ? config.stripe.priceIdPro : config.stripe.priceId;
  if (!price) throw new HttpError(503, 'The Pro plan cannot be bought online yet. Write to hello@pescada.io.');
  const { rows: [f] } = await query('select * from firms where id = $1', [user.firm_id]);
  const s = await stripe('checkout/sessions', {
    mode: 'subscription', client_reference_id: f.id,
    ...(f.stripe_customer_id ? { customer: f.stripe_customer_id } : { customer_email: f.billing_email || user.email }),
    'line_items[0][price]': price, 'line_items[0][quantity]': await quantityFor(f.id),
    success_url: `${config.appUrl}/#/billing/done`, cancel_url: `${config.appUrl}/#/billing`,
    allow_promotion_codes: 'true', billing_address_collection: 'required', 'tax_id_collection[enabled]': 'true',
    metadata: { firm_id: f.id, tier }, 'subscription_data[metadata][tier]': tier,
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
      const tier = TIERS.includes(o.metadata?.tier) ? o.metadata.tier : 'standard';
      await c.query(`update firms set plan = 'active', tier = $4, stripe_customer_id = $2, stripe_subscription_id = $3 where id = $1`, [firmId, o.customer, o.subscription, tier]);
      await firmEvent(c, firmId, null, 'subscribed', `The firm subscribed to Pescada ${tier === 'pro' ? 'Pro' : 'Standard'}`);
    });
    return true;
  }
  if (ev.type.startsWith('customer.subscription.')) {
    const plan = ev.type === 'customer.subscription.deleted' ? 'canceled' : STATUS[o.status] || 'active';
    // the plan follows the subscription's price, so switching in the Stripe portal switches the tier
    const price = o.items?.data?.[0]?.price?.id;
    const { rows: [f] } = await pool.query(
      `update firms set plan = $2, stripe_subscription_id = $3, tier = coalesce($4, tier) where stripe_customer_id = $1 returning id, tier`,
      [o.customer, plan, o.id, price ? tierOfPrice(price) : null]);
    if (f) await firmEvent({ query }, f.id, null, 'subscription_' + plan, `Subscription status: ${plan}, plan ${f.tier === 'pro' ? 'Pro' : 'Standard'}`);
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
