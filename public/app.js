// Pescada web client. Plain modules, no build step.
// The server is the source of truth: every action is a request, and the page
// re-reads the workspace afterwards so what you see is what the log holds.

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const H = 36e5, D = 864e5;
const CATS = { 'Invoice': ['INV', 'sand'], 'Bank statement': ['BNK', 'sky'], 'Contract': ['CTR', 'fog'], 'Receipt': ['RCT', 'sand'], 'Tax return': ['TAX', 'gold'],
  'Financial statements': ['FIN', 'sky'], 'Payroll': ['PAY', 'fog'], 'Other': ['DOC', 'fog'], 'Request': ['REQ', 'gold'] };
const STEPS = { doc: ['Sent', 'Notified', 'Opened', 'Confirmed'], report: ['Sent', 'Notified', 'Opened', 'Approved'], request: ['Requested', 'Notified', 'Seen', 'Fulfilled'] };
const DOC_TYPES = ['Invoice', 'Bank statement', 'Contract', 'Receipt', 'Other'];
const REPORT_TYPES = ['Tax return', 'Financial statements', 'Payroll', 'Other'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const S = { filt: {}, lists: {}, me: null, firm: '', firmInfo: null, countries: [], companies: [], overview: null, ws: null, wsId: null, route: { c: null, i: null }, tab: {}, search: '', shellKey: '', verify: null, seen: new Set() };

/* ---------- formatting ---------- */
// dates show in the open client's country time, or the firm's on the overview
let TZ = 'Europe/Madrid';
const COUNTRY = (code) => S.countries.find((c) => c.code === code) || { code, name: code || '', taxIdLabel: 'Tax ID', taxIdHint: '', presets: [], tz: 'Europe/Madrid' };
const taxLabel = (code) => COUNTRY(code).taxIdLabel;
const cityOfTz = () => TZ.split('/').pop().replace(/_/g, ' ');
const countryOptions = (sel) => S.countries.map((c) => `<option value="${c.code}" ${c.code === sel ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
const fmt = (t) => new Date(t).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: TZ });
const fmtShort = (t) => new Date(t).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: TZ });
const fmtDate = (t) => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: TZ });
const fmtSize = (b) => (b < 1024 ? `${b} B` : b < 1048576 ? `${Math.round(b / 1024)} KB` : `${(b / 1048576).toFixed(1)} MB`);
function dur(ms) { ms = Math.abs(ms); if (ms < H) return `${Math.max(1, Math.round(ms / 6e4))} min`; if (ms < 48 * H) return `${Math.round(ms / H)} h`; return `${Math.round(ms / D)} d`; }
const ago = (t) => `${dur(Date.now() - new Date(t))} ago`;
const periodLabel = (p) => {
  if (!p) return '';
  let m = /^(\d{4})-(\d{2})$/.exec(p); if (m) return `${MONTHS[+m[2] - 1]} ${m[1]}`;
  m = /^(\d{4})-Q(\d)$/.exec(p); if (m) return `Q${m[2]} ${m[1]}`;
  return p;
};
const thisMonth = () => new Date().toISOString().slice(0, 7);
const isoIn = (days) => new Date(Date.now() + days * D).toISOString().slice(0, 10);
const first = (name) => String(name || '').split(' ')[0] || name;

/* ---------- server ---------- */
class ApiError extends Error {}
async function api(path, { method = 'GET', body } = {}) {
  const opt = { method, headers: { 'X-Voixa': '1' } };
  if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  let r;
  try { r = await fetch(`/api${path}`, opt); } catch { throw new ApiError('No connection to the server. Check your internet connection and try again.'); }
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== '/me') { location.reload(); throw new ApiError('Signed out.'); }
  if (!r.ok) throw Object.assign(new ApiError(data.error || 'Something went wrong. Try again.'), { status: r.status, code: data.code });
  return data;
}
function upload(path, form, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', `/api${path}`);
    x.setRequestHeader('X-Voixa', '1');
    x.upload.onprogress = (e) => e.lengthComputable && onProgress && onProgress(e.loaded / e.total);
    x.onload = () => {
      let d = {}; try { d = JSON.parse(x.responseText); } catch {}
      x.status < 300 ? resolve(d) : reject(new ApiError(d.error || 'The upload failed. Try again.'));
    };
    x.onerror = () => reject(new ApiError('The upload was interrupted. Check your connection and try again.'));
    x.send(form);
  });
}

/* ---------- routing ---------- */
function parseRoute() {
  const m = /^#\/c\/([0-9a-f-]{36})(?:\/i\/([0-9a-f-]{36}))?/.exec(location.hash);
  return { c: m ? m[1] : null, i: m && m[2] ? m[2] : null };
}
const go = (c, i) => { location.hash = c ? `#/c/${c}${i ? `/i/${i}` : ''}` : '#/'; };
window.addEventListener('hashchange', () => route());

async function route() {
  S.route = parseRoute();
  if (S.me.role === 'client') {
    if (!S.companies.length) return renderShell();
    if (!S.route.c || !S.companies.some((c) => c.id === S.route.c)) return go(S.companies[0].id);
  }
  await refresh();
}

async function refresh() {
  try {
    if (S.me.role === 'accountant') S.overview = await api('/overview');
    if (S.route.c) {
      if (S.wsId !== S.route.c) { S.ws = null; S.verify = null; }
      const [ws, rec] = await Promise.all([api(`/companies/${S.route.c}${S.allItems?.[S.route.c] ? '?all=1' : ''}`), api(`/companies/${S.route.c}/recognition`)]);
      if (S.log && (S.log.id !== S.route.c || S.log.total !== ws.seq)) S.log = null;
      S.ws = ws; S.rec = rec;
      S.wsId = S.route.c;
      TZ = ws.company.tz || TZ;
      // while files are being read, check back soon
      clearTimeout(S.recTimer);
      if (rec.pending.length) S.recTimer = setTimeout(refresh, 4000);
    } else { S.ws = null; S.wsId = null; if (S.firmInfo) TZ = COUNTRY(S.firmInfo.country).tz; }
  } catch (err) {
    if (err.status === 404) { toast('That workspace is not available to you.'); return go(null); }
    toast(err.message);
  }
  renderData();
}

/* ---------- status ---------- */
const item = (id) => S.ws?.items.find((i) => i.id === id);
const recipientSide = (kind) => (kind === 'doc' ? 'accountant' : 'client');
const isRecipient = (it) => S.me.role === recipientSide(it.kind);

function pill(it) {
  const s = it.status, now = Date.now();
  if (s.state === 'expected') {
    if (!it.due_at) return ['muted', 'Not sent yet'];
    const left = new Date(it.due_at) - now;
    return left < 0 ? ['bad', `Not sent · ${dur(left)} overdue`] : [left < 3 * D ? 'warn' : 'muted', `Not sent yet · due in ${dur(left)}`];
  }
  if (it.kind === 'request') {
    if (s.state === 'done') return ['ok', 'Fulfilled'];
    const left = new Date(it.due_at) - now;
    if (left < 0) return ['bad', `Overdue by ${dur(left)}`];
    return [s.opened_at ? 'opened' : 'sent', `${s.opened_at ? 'Seen' : 'Not seen yet'} · due in ${dur(left)}`];
  }
  if (s.state === 'done') return ['ok', it.kind === 'report' ? 'Approved' : 'Received & confirmed'];
  if (s.changes_requested_at) return ['warn', 'Changes requested'];
  if (s.state === 'opened') return ['opened', it.kind === 'report' ? 'Opened · not approved' : 'Opened · not confirmed'];
  const age = now - new Date(s.version_at);
  return age > 48 * H ? ['bad', `Not opened for ${dur(age)}`] : ['sent', 'Not opened yet'];
}

function deadlineNote(it) {
  const s = it.status;
  if (it.kind !== 'report' || !it.due_at) return '';
  if (!s.sent_at) return '';
  const sent = new Date(s.sent_at), due = new Date(it.due_at);
  return sent <= due ? `<span class="ontime">Sent ${dur(due - sent)} before the ${fmtDate(due)} deadline</span>` : `<span class="late">Sent ${dur(sent - due)} after the ${fmtDate(due)} deadline</span>`;
}

function tracker(it, big) {
  const s = it.status;
  const times = [s.sent_at, s.notified_at, s.opened_at, s.done_at];
  const labels = STEPS[it.kind];
  const tip = (i) => {
    if (i === 1 && s.email_problem) return `Email problem: ${s.email_problem.replace('email_', '')}`;
    if (i === 1 && s.email_delivered_at) return `Email accepted by the recipient’s mail server ${fmt(s.email_delivered_at)}`;
    return `${labels[i]}: ${times[i] ? fmt(times[i]) : 'not yet'}`;
  };
  return `<ol class="trk${big ? ' big' : ''}" aria-label="Progress">${labels.map((l, i) => {
    const cls = [times[i] ? 'on' : '', i === 3 && times[i] ? 'fin' : '', i === 1 && s.email_problem ? 'problem' : ''].join(' ').trim();
    return `<li class="${cls}" title="${esc(tip(i))}"><i></i><span>${l}</span>${big ? `<em>${times[i] ? fmtShort(times[i]) : i === 1 && s.email_problem ? 'failed' : '—'}</em>` : ''}</li>`;
  }).join('')}</ol>`;
}

function row(it, opts = {}) {
  const { compact } = opts;
  const [tone, label] = pill(it);
  const [code, col] = CATS[it.kind === 'request' ? 'Request' : it.category] || CATS.Other;
  const cur = it.versions?.[it.versions.length - 1];
  const bits = [it.ref];
  if (opts.showCompany && it.company_name) bits.push(esc(it.company_name));
  if (cur) bits.push(esc(cur.file_name) + (cur.version > 1 ? ` (v${cur.version})` : ''));
  if (it.period) bits.push(periodLabel(it.period));
  if (it.status.sent_at) bits.push(`${it.kind === 'request' ? 'requested' : 'sent'} ${ago(it.status.sent_at)}`);
  else if (it.due_at) bits.push(`due ${fmtDate(it.due_at)}`);
  const dn = deadlineNote(it); if (dn) bits.push(dn);
  const paid = paymentNote(it.id); if (paid) bits.push(paid);
  const cid = it.company_id || S.route.c;
  return `<button class="row" data-act="item" data-c="${cid}" data-id="${it.id}"><span class="ico ${col}" aria-hidden="true">${code}</span><span class="rm"><span class="rt">${esc(it.title)}</span><span class="rs">${bits.join(' · ')}</span></span>${compact ? '' : tracker(it)}<span class="pill ${tone}">${label}</span></button>`;
}
const list = (items, empty, opts) => (items.length ? `<div class="list${opts?.compact ? ' compact' : ''}">${items.map((i) => (opts?.select
  ? `<div class="sel-row"><input type="checkbox" aria-label="Select ${esc(i.title)}" data-sel="${opts.select}" value="${i.id}" ${S.filt[opts.select]?.picked.has(i.id) ? 'checked' : ''}>${row(i, opts)}</div>`
  : row(i, opts))).join('')}</div>` : `<div class="empty">${empty}</div>`);

/* ---------- filters, selection and bulk actions on a list ---------- */
const STATUS_F = { all: 'All', waiting: 'Waiting', done: 'Done', overdue: 'Overdue' };
function filtState(key) { return (S.filt[key] ||= { q: '', status: 'all', period: '', selecting: false, picked: new Set() }); }
function applyFilter(key, items) {
  const f = filtState(key), q = f.q.trim().toLowerCase(), now = Date.now();
  return items.filter((i) => {
    if (q && ![i.title, i.ref, i.category, i.versions?.[i.versions.length - 1]?.file_name].some((x) => String(x || '').toLowerCase().includes(q))) return false;
    if (f.period && i.period !== f.period && String(i.status.version_at || i.created_at).slice(0, 7) !== f.period) return false;
    const done = i.status.state === 'done';
    if (f.status === 'waiting' && done) return false;
    if (f.status === 'done' && !done) return false;
    if (f.status === 'overdue' && (done || !i.due_at || new Date(i.due_at) > now)) return false;
    return true;
  });
}
/** A list with its toolbar. Typing in the toolbar redraws only the list, so focus stays put. */
function toolList(key, items, empty, opts = {}) {
  const f = filtState(key);
  const periods = [...new Set(items.flatMap((i) => [i.period, String(i.status.version_at || i.created_at || '').slice(0, 7)]).filter((p) => /^\d{4}-\d{2}$/.test(p)))].sort().reverse();
  const canConfirm = items.some((i) => isRecipient(i) && i.kind !== 'request');
  const tools = items.length > 1 || f.q || f.status !== 'all' || f.period ? `<div class="tools" data-key="${key}">
    <input class="input" type="search" placeholder="Filter by name, file or reference" value="${esc(f.q)}" data-filter="q" aria-label="Filter">
    <select class="input" data-filter="status" aria-label="Status">${Object.entries(STATUS_F).map(([k, v]) => `<option value="${k}" ${f.status === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
    <select class="input" data-filter="period" aria-label="Month"><option value="">Any month</option>${periods.map((p) => `<option value="${p}" ${f.period === p ? 'selected' : ''}>${periodLabel(p)}</option>`).join('')}</select>
    <button class="btn small" data-act="sel-toggle" data-key="${key}">${f.selecting ? 'Done selecting' : 'Select'}</button></div>` : '';
  const bulk = f.selecting ? `<div class="bulk" id="bulk-${key}">${bulkBar(key, canConfirm)}</div>` : '';
  S.lists[key] = { items, empty, opts };
  return `${tools}${bulk}<div id="lst-${key}">${list(applyFilter(key, items), f.q || f.status !== 'all' || f.period ? 'Nothing matches the filter.' : empty, { ...opts, select: f.selecting ? key : null })}</div>`;
}
function bulkBar(key, canConfirm) {
  const n = filtState(key).picked.size;
  return `<span>${n} selected</span><button class="btn small" data-act="sel-all" data-key="${key}">Select all shown</button>
    <button class="btn small" data-act="bulk-zip" data-key="${key}" ${n ? '' : 'disabled'}>Download as ZIP</button>
    ${canConfirm ? `<button class="btn small primary" data-act="bulk-confirm" data-key="${key}" ${n ? '' : 'disabled'}>Confirm selected</button>` : ''}`;
}
function redrawList(key) {
  const L = S.lists[key]; if (!L) return;
  const f = filtState(key);
  const box = document.getElementById(`lst-${key}`); if (box) box.innerHTML = list(applyFilter(key, L.items), 'Nothing matches the filter.', { ...L.opts, select: f.selecting ? key : null });
  const bar = document.getElementById(`bulk-${key}`); if (bar) bar.innerHTML = bulkBar(key, L.items.some((i) => isRecipient(i) && i.kind !== 'request'));
}
const newest = (a, b) => new Date(b.status.sent_at || b.created_at) - new Date(a.status.sent_at || a.created_at);

/* ---------- header ---------- */
function renderHeader() {
  const h = $('#hdrRight');
  if (!S.me) { h.innerHTML = ''; return; }
  const switcher = S.me.role === 'client' && S.companies.length > 1
    ? `<select class="input" id="coSwitch" aria-label="Company" style="width:auto">${S.companies.map((c) => `<option value="${c.id}" ${c.id === S.route.c ? 'selected' : ''}>${esc(c.name)}${new Set(S.companies.map((x) => x.firm_name)).size > 1 ? ` (${esc(c.firm_name)})` : ''}</option>`).join('')}</select>` : '';
  const firm = S.me.role === 'accountant' ? `<button class="btn small" data-act="firm-settings" title="Firm settings">${esc(S.firm)} · ${esc(S.firmInfo?.country || '')}</button>` : '';
  h.innerHTML = `${switcher}${firm}<button class="who linkbtn" style="font-size:13px;color:var(--text);text-decoration:none" data-act="account" title="Your account"><i></i>${esc(S.me.name || S.me.email)} · ${S.me.role === 'accountant' ? 'Accountant' : 'Client'}</button><button class="btn small" data-act="logout">Sign out</button>`;
  $('#coSwitch')?.addEventListener('change', (e) => go(e.target.value));
}

/* ---------- sign in ---------- */
function renderLogin(sentTo) {
  $('#hdrRight').innerHTML = '';
  $('#view').innerHTML = `<section class="card pad setup" style="max-width:480px;margin:40px auto">${sentTo
    ? `<h1>Check your inbox</h1><p class="sub" style="margin-top:8px">If ${esc(sentTo)} has access, a sign-in link is on its way. It works once and expires in 30 minutes. Check the spam folder if it does not arrive within a few minutes.</p><p style="margin-top:16px"><button class="btn" data-act="login-again">Use another address</button></p>`
    : `<form id="loginForm" novalidate style="display:grid;gap:14px"><div><h1>Sign in</h1><p class="sub" style="margin-top:6px">Pescada is where you and ${esc(S.firm || 'your accountant')} send documents, and every step is recorded. Enter your email and we will send you a sign-in link.</p></div>
      <div class="field"><label for="li-email">Email</label><input id="li-email" class="input" type="email" autocomplete="email" required></div>
      <p class="err" id="liErr" hidden></p><button class="btn primary" type="submit">Email me a sign-in link</button>
      <p class="sub" style="font-size:14px">New accounting firm? <button type="button" class="linkbtn" style="font-size:14px" data-act="signup">Start a free trial</button></p></form>`}</section>`;
  $('#li-email')?.focus();
}
const SIGNUP_COUNTRIES = [['ES', 'Spain'], ['IT', 'Italy'], ['FR', 'France'], ['DE', 'Germany'], ['PT', 'Portugal']];
function renderSignup(sentTo) {
  $('#hdrRight').innerHTML = '';
  $('#view').innerHTML = `<section class="card pad setup" style="max-width:520px;margin:40px auto">${sentTo
    ? `<h1>Check your inbox</h1><p class="sub" style="margin-top:8px">We sent a sign-in link to ${esc(sentTo)}. Open it to start. It works once and expires in 30 minutes.</p>`
    : `<form id="signupForm" novalidate style="display:grid;gap:14px"><div><h1>Start your free trial</h1><p class="sub" style="margin-top:6px">30 days, no card needed. Set up your firm, invite your clients, and see every document tracked from sent to confirmed.</p></div>
      <div class="field"><label for="su-firm">Firm name</label><input id="su-firm" class="input" autocomplete="organization"></div>
      <div class="grid2"><div class="field"><label for="su-country">Country</label><select id="su-country" class="input">${SIGNUP_COUNTRIES.map(([c, n]) => `<option value="${c}">${n}</option>`).join('')}</select></div>
      <div class="field"><label for="su-name">Your name</label><input id="su-name" class="input" autocomplete="name"></div></div>
      <div class="field"><label for="su-email">Work email</label><input id="su-email" class="input" type="email" autocomplete="email"></div>
      <p class="sub" style="font-size:13px">By starting you accept the <a href="https://pescada.io/terms/" target="_blank" rel="noopener">Terms</a> and the <a href="https://pescada.io/dpa/" target="_blank" rel="noopener">Data Processing Agreement</a>, and have read the <a href="https://pescada.io/privacy/" target="_blank" rel="noopener">Privacy Policy</a>.</p>
      <p class="err" id="suErr" hidden></p><button class="btn primary" type="submit">Start the trial</button>
      <p class="sub" style="font-size:14px">Already using Pescada? <button type="button" class="linkbtn" style="font-size:14px" data-act="login-again">Sign in</button></p></form>`}</section>`;
  $('#su-firm')?.focus();
}

/* ---------- plan and billing ---------- */
function planBanner() {
  const f = S.firmInfo;
  if (!f || S.me?.role !== 'accountant' || f.plan === 'internal' || f.plan === 'active') return '';
  const admin = isAdmin();
  const action = admin ? '<button class="btn small primary" data-act="billing">Subscribe</button>' : '<span class="sub">Ask your firm’s administrator to subscribe.</span>';
  if (!f.active) return `<div class="chain bad" style="margin-bottom:16px"><div><p>Your trial has ended</p><small>Everything is kept and you can read and export it. Subscribe to add clients, send reports and change things again. Your clients can still send documents.</small></div><div class="tbl-actions">${action}</div></div>`;
  if (f.plan === 'past_due') return `<div class="chain bad" style="margin-bottom:16px"><div><p>The last payment did not go through</p><small>Update the card to keep the subscription active.</small></div><div class="tbl-actions">${admin ? '<button class="btn small" data-act="billing">Billing</button>' : ''}</div></div>`;
  if (f.plan === 'trial') return `<div class="chain" style="margin-bottom:16px"><div><p>Free trial: ${f.trialDaysLeft} day${f.trialDaysLeft === 1 ? '' : 's'} left</p><small>Subscribe any time; nothing changes for your clients.</small></div><div class="tbl-actions">${action}</div></div>`;
  return '';
}
async function billingModal() {
  let b;
  try { b = await api('/billing'); } catch (err) { return toast(err.message); }
  const label = { trial: `Free trial${b.trialDaysLeft != null ? `, ${b.trialDaysLeft} days left` : ''}`, active: 'Subscribed', past_due: 'Payment failed', canceled: 'Cancelled', internal: 'Included' }[b.plan];
  openModal(`${modalHead('Subscription')}<div class="modal-b"><p><b>${label}</b></p>
    ${b.onlinePayment ? `<p class="sub">Payment is handled by Stripe. Pescada never sees your card.</p>
      <div class="dr-actions">${b.plan !== 'active' ? '<button class="btn primary" data-act="checkout">Subscribe</button>' : ''}${b.hasCustomer ? '<button class="btn" data-act="portal">Card, invoices and cancellation</button>' : ''}</div>`
    : '<p class="sub">Online payment is not set up yet. Write to <a href="mailto:hello@pescada.io">hello@pescada.io</a> to subscribe.</p>'}</div>`);
}

/* ---------- two-step sign-in ---------- */
function renderMfaCode() {
  $('#hdrRight').innerHTML = `<button class="btn small" data-act="logout">Sign out</button>`;
  $('#view').innerHTML = `<section class="card pad setup" style="max-width:480px;margin:40px auto">
    <form id="mfaForm" novalidate style="display:grid;gap:14px"><div><h1>Enter your code</h1><p class="sub" style="margin-top:6px">Open your authenticator app and enter the 6-digit code for Pescada (${esc(S.me.email)}). Lost your phone? Enter one of your recovery codes instead.</p></div>
    <div class="field"><label for="mfa-code">Code</label><input id="mfa-code" class="input" inputmode="numeric" autocomplete="one-time-code" maxlength="12" style="letter-spacing:.2em;font-family:var(--f-mono)"></div>
    <p class="err" id="mfaErr" hidden></p><button class="btn primary" type="submit">Continue</button></form></section>`;
  $('#mfa-code').focus();
}
function setupBlock(intro) {
  return `<div id="mfaSetup" style="display:grid;gap:14px">${intro}
    <div><button class="btn primary" type="button" data-act="mfa-start">Set up two-step sign-in</button></div></div>`;
}
function renderMfaSetupRequired() {
  $('#hdrRight').innerHTML = `<button class="btn small" data-act="logout">Sign out</button>`;
  $('#view').innerHTML = `<section class="card pad setup" style="max-width:560px;margin:40px auto">${setupBlock(`<div><h1>Set up two-step sign-in</h1><p class="sub" style="margin-top:6px">${esc(S.firm || 'Your firm')} requires a code from an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password…) when accountants sign in. It takes a minute.</p></div>`)}</section>`;
}
async function startMfaSetup() {
  const box = $('#mfaSetup'); if (!box) return;
  try {
    const s = await api('/me/2fa/setup', { method: 'POST', body: {} });
    box.innerHTML = `<p>1. Scan this code with your authenticator app.</p>
      <div style="width:200px;height:200px;background:#fff;padding:8px;border-radius:14px;border:1px solid var(--line)">${s.qr.replace('<svg ', '<svg width="184" height="184" ')}</div>
      <p class="sub" style="font-size:13px">Cannot scan? Enter this key by hand: <span class="mono" style="font-size:13px">${esc(s.secret)}</span></p>
      <form id="mfaEnable" novalidate style="display:grid;gap:12px"><div class="field"><label for="mfa-new">2. Enter the 6-digit code it shows</label><input id="mfa-new" class="input" inputmode="numeric" autocomplete="one-time-code" maxlength="6" style="letter-spacing:.2em;font-family:var(--f-mono)"></div>
      <p class="err" id="mfaNewErr" hidden></p><div><button class="btn primary" type="submit">Turn on</button></div></form>`;
    $('#mfa-new').focus();
  } catch (err) { toast(err.message); }
}
function showRecoveryCodes(codes, done) {
  openModal(`${modalHead('Your recovery codes')}<div class="modal-b"><p>Keep these codes somewhere safe, for example in your password manager. Each one signs you in once if you lose your phone. They are shown only now.</p>
    <pre class="receipt" style="font:500 15px/1.9 var(--f-mono);columns:2">${codes.map(esc).join('\n')}</pre>
    <div class="dr-actions"><button class="btn primary" type="button" data-act="${done ? 'reload' : 'close-modal'}">I have saved them</button></div></div>`);
}

/** First visits: three steps that explain the workspace, until dismissed. */
function tipsCard(c) {
  let seen = false; try { seen = localStorage.getItem(`pescada.tips.${c.id}`) === '1'; } catch { /* private mode */ }
  if (seen) return '';
  return `<div class="card pad tips" id="tips" style="flex-basis:100%"><h3>How this workspace works</h3><ol>
    <li><b>Send documents</b> with the form below${c.inbound_address ? ', or by email to the workspace address' : ''}. Each file is fingerprinted and you see when your accountant opens and confirms it.</li>
    <li><b>Answer requests.</b> When your accountant needs something, it appears under “Needs your attention” with its due date.</li>
    <li><b>Open and approve reports</b> your accountant sends you, or ask for changes. Every step is recorded for both sides.</li></ol>
    <button class="btn small" data-act="tips-done" data-id="${c.id}">Got it</button></div>`;
}

/* ---------- search across workspaces ---------- */
function searchModal(q) {
  openModal(`${modalHead('Search documents')}<div class="modal-b">
    <input id="sq" class="input" type="search" placeholder="Title, file name, invoice number, supplier, client or reference (PX-001-0004)" value="${esc(q)}">
    <div id="sqRes" class="list compact"></div></div>`);
  const i = $('#sq'); i.focus(); i.setSelectionRange(i.value.length, i.value.length);
  if (q) runSearch(q);
}
async function runSearch(q) {
  const box = $('#sqRes'); if (!box) return;
  if (q.trim().length < 2) { box.innerHTML = ''; return; }
  try {
    const r = await api(`/search?q=${encodeURIComponent(q)}`);
    if ($('#sq')?.value !== q) return;
    box.innerHTML = r.results.length ? r.results.map((x) => `<button class="row" data-act="item" data-c="${x.company_id}" data-id="${x.id}" style="grid-template-columns:minmax(0,1fr) auto">
      <span class="rm"><span class="rt">${esc(x.title)}</span><span class="rs">${x.ref} · ${esc(x.company_name)}${x.file_name ? ` · ${esc(x.file_name)}` : ''}${x.invoice_number ? ` · invoice ${esc(x.invoice_number)}` : ''}</span></span>
      <span class="pill ${x.state === 'done' ? 'ok' : 'sent'}">${x.state === 'done' ? 'Done' : 'Open'}</span></button>`).join('') : '<div class="empty">Nothing found.</div>';
  } catch (err) { box.innerHTML = `<div class="empty">${esc(err.message)}</div>`; }
}

/* ---------- photos from the phone become one PDF ---------- */
async function photosToPdf(files) {
  if (!files.length) return;
  const out = $('#dropFiles'); out.textContent = 'Preparing the photos…';
  try {
    const pages = [];
    for (const f of files) {
      const bmp = await createImageBitmap(f);
      const scale = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
      const cv = document.createElement('canvas'); cv.width = Math.round(bmp.width * scale); cv.height = Math.round(bmp.height * scale);
      cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
      const blob = await new Promise((res) => cv.toBlob(res, 'image/jpeg', 0.85));
      pages.push({ w: cv.width, h: cv.height, jpg: new Uint8Array(await blob.arrayBuffer()) });
    }
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '.');
    S.photoPdf = new File([buildPdf(pages)], `Photos ${stamp}.pdf`, { type: 'application/pdf' });
    showPicked();
  } catch (err) { out.textContent = ''; toast(`The photos could not be prepared: ${err.message}`); }
}
/** A minimal PDF: one page per JPEG, the page sized to the photo (A4 width). */
function buildPdf(pages) {
  const enc = new TextEncoder(), chunks = [], offsets = [];
  let len = 0;
  const add = (x) => { const b = typeof x === 'string' ? enc.encode(x) : x; chunks.push(b); len += b.length; };
  const obj = (n, body) => { offsets[n] = len; add(`${n} 0 obj\n`); body(); add('\nendobj\n'); };
  add('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
  const kids = pages.map((_, i) => `${3 + i * 3} 0 R`).join(' ');
  obj(1, () => add('<< /Type /Catalog /Pages 2 0 R >>'));
  obj(2, () => add(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`));
  pages.forEach((p, i) => {
    const n = 3 + i * 3, W = 595, H = Math.round(595 * p.h / p.w);
    const draw = `q ${W} 0 0 ${H} 0 0 cm /Im0 Do Q`;
    obj(n, () => add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << /Im0 ${n + 2} 0 R >> >> /Contents ${n + 1} 0 R >>`));
    obj(n + 1, () => add(`<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`));
    obj(n + 2, () => { add(`<< /Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpg.length} >>\nstream\n`); add(p.jpg); add('\nendstream'); });
  });
  const count = 3 + pages.length * 3, xref = len;
  add(`xref\n0 ${count}\n0000000000 65535 f \n${offsets.slice(1).map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(chunks, { type: 'application/pdf' });
}
function showPicked() {
  const names = [...($('#up-file')?.files || [])].map((f) => f.name);
  if (S.photoPdf) names.push(`${S.photoPdf.name} (${S.photoPdf.size > 1048576 ? `${(S.photoPdf.size / 1048576).toFixed(1)} MB` : `${Math.round(S.photoPdf.size / 1024)} KB`})`);
  $('#dropFiles').textContent = names.join(', ');
}

/* ---------- account ---------- */
async function accountModal() {
  const me = S.me, acc = me.role === 'accountant';
  let sessions = [];
  try { sessions = (await api('/me/sessions')).sessions; } catch { /* shown empty */ }
  const device = (ua) => { const u = String(ua || ''); const os = /iPhone|iPad/.test(u) ? 'iPhone / iPad' : /Android/.test(u) ? 'Android' : /Mac OS/.test(u) ? 'Mac' : /Windows/.test(u) ? 'Windows' : /Linux/.test(u) ? 'Linux' : 'Unknown device';
    const br = /Edg\//.test(u) ? 'Edge' : /Chrome\//.test(u) ? 'Chrome' : /Firefox\//.test(u) ? 'Firefox' : /Safari\//.test(u) ? 'Safari' : ''; return `${br ? `${br} on ` : ''}${os}`; };
  const hours = Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${h === me.digestHour ? 'selected' : ''}>${String(h).padStart(2, '0')}:00</option>`).join('');
  openModal(`${modalHead('Your account')}<div class="modal-b">
    <form id="accForm" novalidate style="display:grid;gap:12px">
      <div class="field"><label for="ac-name">Your name</label><input id="ac-name" class="input" value="${esc(me.name || '')}"></div>
      <div class="grid2"><div class="field"><label for="ac-mode">Email notifications</label><select id="ac-mode" class="input">
        <option value="digest" ${me.notifyMode === 'digest' ? 'selected' : ''}>One daily summary</option><option value="instant" ${me.notifyMode === 'instant' ? 'selected' : ''}>An email for every event</option></select></div>
      <div class="field"><label for="ac-hour">Summary time (${esc(cityOfTz())})</label><select id="ac-hour" class="input">${hours}</select></div></div>
      <p class="sub" style="font-size:13px">Change requests and reminders always arrive at once.</p>
      <p class="err" id="acErr" hidden></p><div><button class="btn primary" type="submit">Save</button></div></form>
    <h3 style="margin-top:8px">Two-step sign-in</h3>
    ${me.mfa?.enabled
    ? `<p>On. You have ${me.mfa.recoveryLeft} unused recovery code${me.mfa.recoveryLeft === 1 ? '' : 's'}.</p>
       <form id="mfaManage" novalidate style="display:grid;gap:10px"><div class="field"><label for="mm-code">Current code from your app</label><input id="mm-code" class="input" inputmode="numeric" maxlength="6" style="font-family:var(--f-mono)"></div>
       <p class="err" id="mmErr" hidden></p><div class="dr-actions"><button class="btn" type="submit" data-do="recovery">New recovery codes</button><button class="btn" type="submit" data-do="disable">Turn off</button></div></form>`
    : setupBlock(`<p>${acc ? 'You see the documents of every client of the firm. A code from an authenticator app at sign-in keeps them safe even if someone gets into your email.' : 'Add a code from an authenticator app to your sign-in.'}</p>`)}
    <h3 style="margin-top:8px">Where you are signed in</h3>
    <div class="people">${sessions.map((x) => `<div class="person"><div><b>${esc(device(x.device))}</b>${x.current ? ' <span class="pill sent" style="margin-left:6px">This device</span>' : ''}<br><span class="sub">Signed in ${fmtDate(x.created_at)} · last active ${ago(x.last_seen_at)}${x.ip ? ` · ${esc(x.ip)}` : ''}</span></div>
      ${x.current ? '' : `<button class="btn small" data-act="session-out" data-id="${x.id}">Sign out</button>`}</div>`).join('')}</div>
    ${sessions.length > 1 ? '<div><button class="btn" data-act="sessions-out">Sign out everywhere else</button></div>' : ''}
  </div>`);
  if (!acc) { $('#ac-mode').closest('.grid2').hidden = true; $('#ac-mode').closest('form').querySelector('.sub').hidden = true; }
}

/* ---------- shell (built once per view, holds forms) ---------- */
function wantShell() {
  if (!S.me) return 'login';
  if (S.me.role === 'client') return S.companies.length ? `client:${S.route.c}` : 'client:none';
  return `acc:${S.route.c || 'all'}`;
}

function renderShell() {
  S.shellKey = wantShell();
  renderHeader();
  const v = $('#view');
  if (S.shellKey === 'client:none') {
    v.innerHTML = `<section class="card pad setup"><h1>No workspace yet</h1><p class="sub">You are signed in, but nobody has given you access to a company workspace. Ask your accountant at ${esc(S.firm)} to add you.</p></section>`;
    return;
  }
  if (S.me.role === 'client') {
    v.innerHTML = `<div class="hello" id="hello"></div>
      <div class="cols">
        <section class="card pad upload" aria-labelledby="upH">
          <form id="upForm" novalidate>
            <div><h2 id="upH">Send documents to ${esc(S.firm)}</h2><p class="sub" style="margin-top:4px">Every file is fingerprinted and tracked until your accountant confirms receipt.</p></div>
            <label class="drop" id="drop" for="up-file"><strong>Drop files here or choose files</strong><span>Invoices, contracts, bank statements, receipts.</span><span class="files" id="dropFiles"></span></label>
            <input type="file" id="up-file" class="sr" multiple>
            <div class="cam-row"><label class="btn" for="up-cam">Take photos with the camera</label><input type="file" id="up-cam" class="sr" accept="image/*" capture="environment" multiple><span class="sub" style="font-size:13px">The photos are sent as one PDF.</span></div>
            <p class="sub" id="emailIn" style="font-size:13px" hidden></p>
            <div class="grid2 type-period">
              <div class="field"><label for="up-cat">Document type</label><select id="up-cat" class="input">${DOC_TYPES.map((x) => `<option>${x}</option>`).join('')}</select></div>
              <div class="field"><label for="up-period">Period</label><input id="up-period" class="input" type="month" value="${thisMonth()}"></div>
            </div>
            <div class="field"><label for="up-req">In response to</label><select id="up-req" class="input"><option value="">No specific request</option></select></div>
            <div class="field"><label for="up-note">Note for your accountant (optional)</label><textarea id="up-note" class="input" rows="2" placeholder="For example: second page is the payment proof"></textarea></div>
            <p class="err" id="upErr" hidden></p><p class="progress" id="upProg" hidden></p>
            <button class="btn primary" type="submit" id="upBtn">Send to accountant</button>
          </form>
        </section>
        <section aria-labelledby="atH"><div class="section-h"><h3 id="atH">Needs your attention</h3></div><div id="attn"></div></section>
      </div>
      <section id="tabsArea"></section>`;
    bindUpload();
  } else {
    v.innerHTML = `<div class="acc"><aside class="rail"><div class="field"><label for="cl-search" id="clCount">Your clients</label><input id="cl-search" class="input" type="search" placeholder="Search by name or number" value="${esc(S.search)}"></div>
      <div class="rail-actions"><button class="btn small" data-act="new-client">Add a client</button><button class="btn small" data-act="search-docs">Search documents</button></div><nav class="rail-list" id="clList" aria-label="Clients"></nav></aside><section id="accMain" style="min-width:0"></section></div>`;
    $('#cl-search').addEventListener('input', (e) => { S.search = e.target.value; renderRail(); });
  }
}

function bindUpload() {
  const drop = $('#drop'), inp = $('#up-file');
  const show = showPicked;
  inp.addEventListener('change', show);
  ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => { if (e.dataTransfer.files.length) { inp.files = e.dataTransfer.files; show(); } });
}

/* ---------- data regions ---------- */
function renderData() {
  if (!S.me) return;
  if (wantShell() !== S.shellKey) renderShell();
  renderHeader();
  if (S.shellKey === 'client:none') return;
  if (S.me.role === 'client') renderClient(); else { renderRail(); renderAcc(); }
  renderDrawer();
}

function tabs(key, defs) {
  const cur = S.tab[key] && defs.some((d) => d.id === S.tab[key]) ? S.tab[key] : defs[0].id;
  return { cur, html: `<div class="tabs" role="tablist">${defs.map((d) => `<button role="tab" data-act="tab" data-key="${key}" data-tab="${d.id}" aria-selected="${d.id === cur}">${d.label}${d.count != null ? `<span class="count">${d.count}</span>` : ''}</button>`).join('')}</div>` };
}

function renderClient() {
  const w = S.ws; if (!w) return;
  const c = w.company;
  $('#hello').innerHTML = `<div><h1>${esc(c.name)}</h1><p class="sub">Client #${c.no}${c.nif ? ` · ${esc(taxLabel(c.country))} ${esc(c.nif)}` : ''}${c.city ? ` · ${esc(c.city)}` : ''} · ${esc(COUNTRY(c.country).name)} · Accountant: ${esc(w.firm)}</p></div>
    <span class="private"><i></i>Private workspace. Other clients of ${esc(w.firm)} cannot see it.</span>${tipsCard(c)}`;
  const ei = $('#emailIn');
  if (ei && c.inbound_address) { ei.hidden = false; ei.innerHTML = `Or email attachments to <b class="mono" style="font-size:13px">${esc(c.inbound_address)}</b> <button type="button" class="linkbtn" data-act="copy" data-text="${esc(c.inbound_address)}">Copy</button> from your own address.`; }
  const docs = w.items.filter((i) => i.kind === 'doc').sort(newest);
  const inbound = w.items.filter((i) => i.kind !== 'doc').sort(newest);
  const attn = inbound.filter((i) => i.status.state !== 'done' && i.status.state !== 'expected')
    .concat(docs.filter((i) => i.status.state === 'sent' && Date.now() - new Date(i.status.version_at) > 48 * H));
  $('#attn').innerHTML = attn.length ? `<div class="list compact">${attn.map((i) => row(i, { compact: true })).join('')}</div>` : `<div class="empty">Nothing is waiting for you. New reports and requests from ${esc(w.firm)} will appear here.</div>`;
  const sel = $('#up-req');
  if (sel) {
    const keep = sel.value;
    const open = inbound.filter((i) => i.kind === 'request' && i.status.state !== 'done');
    sel.innerHTML = `<option value="">No specific request</option>${open.map((i) => `<option value="${i.id}">${esc(i.title)}</option>`).join('')}`;
    if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
  }
  const t = tabs(`c:${c.id}`, [
    { id: 'sent', label: 'Sent to accountant', count: docs.length },
    { id: 'recv', label: 'From accountant', count: inbound.length },
    { id: 'bank', label: 'Bank & invoices', count: S.rec?.transactions.length || null },
    { id: 'recurring', label: 'Recurring deadlines', count: w.obligations.filter((o) => o.active).length },
    { id: 'people', label: 'People', count: w.members.length },
    { id: 'log', label: 'Activity log' }]);
  let body = '';
  if (t.cur === 'sent') body = toolList(`c-sent:${c.id}`, docs, 'You have not sent any documents yet. Use the form above to send the first one.');
  else if (t.cur === 'recv') body = toolList(`c-recv:${c.id}`, inbound, `Reports and requests from ${esc(w.firm)} will appear here.`);
  else if (t.cur === 'bank') body = bankView();
  else if (t.cur === 'recurring') body = recurringView();
  else if (t.cur === 'people') body = peopleView();
  else body = ledgerView();
  $('#tabsArea').innerHTML = t.html + body + (t.cur === 'sent' || t.cur === 'recv' ? olderNote() : '');
}

function countsFor(cid) {
  const open = (S.overview?.open || []).filter((i) => i.company_id === cid);
  const k = { unopened: 0, stale: 0, unconf: 0, waiting: 0, overdue: 0, expected: 0, next: null };
  for (const i of open) {
    if (i.kind === 'doc') {
      if (i.state === 'sent') { k.unopened++; if (Date.now() - new Date(i.version_at) > 48 * H) k.stale++; } else if (i.state === 'opened') k.unconf++;
    } else if (i.state === 'expected') { k.expected++; } else { k.waiting++; if (i.kind === 'request' && new Date(i.due_at) < Date.now()) k.overdue++; }
  }
  k.next = open.filter((i) => i.kind !== 'doc' && i.due_at && new Date(i.due_at) > Date.now()).sort((a, b) => new Date(a.due_at) - new Date(b.due_at))[0];
  return k;
}

function renderRail() {
  const cos = S.overview?.companies || [];
  const q = S.search.trim().toLowerCase();
  const shown = cos.filter((c) => !q || c.name.toLowerCase().includes(q) || String(c.no) === q.replace('#', ''));
  $('#clCount').textContent = `Your clients (${cos.length})`;
  $('#clList').innerHTML = `<button class="cl" data-act="client" data-id="" aria-current="${!S.route.c}"><span class="no">ALL</span><span class="nm"><b>All clients</b><span>Work queue and deadlines</span></span><span></span></button>` +
    shown.map((c) => {
      const k = countsFor(c.id), n = k.unopened + k.overdue;
      return `<button class="cl" data-act="client" data-id="${c.id}" aria-current="${S.route.c === c.id}"><span class="no">#${c.no}</span><span class="nm"><b>${esc(c.name)}</b><span>${c.closed_at ? 'Closed' : `${c.members} ${c.members === 1 ? 'person' : 'people'}`}</span></span>${n ? `<span class="badge ${k.stale || k.overdue ? 'bad' : 'warn'}" title="${k.unopened} not opened, ${k.overdue} overdue">${n}</span>` : '<span></span>'}</button>`;
    }).join('');
}

// overview rows carry the cached status columns, not the full per-item status
const withStatus = (i) => ({ ...i, status: { state: i.state, version: i.version, sent_at: i.sent_at, version_at: i.version_at, opened_at: i.opened_at, done_at: i.done_at } });

function renderAcc() {
  const m = $('#accMain');
  if (!S.route.c) {
    const o = S.overview; if (!o) return;
    const all = o.companies.map((c) => ({ c, k: countsFor(c.id) }));
    const sum = (f) => all.reduce((a, x) => a + x.k[f], 0);
    const mine = o.open.map(withStatus).filter((i) => (i.kind === 'doc' && i.state !== 'done') || i.state === 'expected')
      .sort((a, b) => new Date(a.version_at || a.due_at) - new Date(b.version_at || b.due_at));
    const theirs = o.open.map(withStatus).filter((i) => i.kind !== 'doc' && i.state !== 'expected').sort((a, b) => new Date(a.due_at || 0) - new Date(b.due_at || 0));
    const t = tabs('acc:all', [{ id: 'work', label: 'Work queue' }, { id: 'clients', label: 'Clients' }, ...(isAdmin() ? [{ id: 'ai', label: 'AI reading costs' }] : [])]);
    let body;
    if (!o.companies.length) body = `<div class="empty" style="text-align:left">No clients yet. Use <b>Add a client</b> to create a workspace and invite the people who will send documents.</div>`;
    else if (t.cur === 'work') body = `<div class="stack"><section><div class="section-h"><h3>Waiting for you</h3><span class="note" style="margin:0">Oldest first: documents to open and confirm, and reports you still owe.</span></div>${list(mine, 'Nothing is waiting for you.', { compact: true, showCompany: true })}</section>
      <section><div class="section-h"><h3>Waiting on clients</h3></div>${list(theirs, 'No reports or requests are waiting on clients.', { compact: true, showCompany: true })}</section></div>`;
    else if (t.cur === 'ai') body = aiUsageView();
    else body = `<div class="tbl-wrap"><table><thead><tr><th>No.</th><th>Client</th><th>Not opened by you</th><th>Opened, not confirmed</th><th>Reports you owe</th><th>Waiting on client</th><th>Overdue requests</th><th>Next deadline</th></tr></thead><tbody>${all.map(({ c, k }) =>
      `<tr class="click" data-act="client" data-id="${c.id}"><td class="mono">#${c.no}</td><td><b style="color:var(--ink)">${esc(c.name)}</b><br><span style="color:var(--muted)"><span class="mono">${esc(c.country || '')}</span>${c.nif ? ` · ${esc(taxLabel(c.country))} ${esc(c.nif)}` : ''}</span></td>${[k.unopened, k.unconf, k.expected, k.waiting, k.overdue].map((n) => `<td class="num ${n ? '' : 'zero'}">${n}</td>`).join('')}<td>${k.next ? `${fmtDate(k.next.due_at)}<br><span style="color:var(--muted)">${esc(k.next.title)}</span>` : '<span style="color:var(--muted)">None</span>'}</td></tr>`).join('')}</tbody></table></div>`;
    m.innerHTML = planBanner() + `<div class="ws-h"><div><h1>Good to see you, ${esc(first(S.me.name) || 'there')}</h1><p class="sub" style="margin-top:6px">${esc(S.firm)} · ${o.companies.length} client workspace${o.companies.length === 1 ? '' : 's'}</p></div></div>
      <div class="kpis"><div class="kpi ${sum('stale') ? 'alert' : ''}"><b class="num">${sum('unopened')}</b><span>Documents you have not opened${sum('stale') ? ` · ${sum('stale')} over 48 h` : ''}</span></div>
      <div class="kpi"><b class="num">${sum('unconf')}</b><span>Opened, receipt not confirmed</span></div>
      <div class="kpi"><b class="num">${sum('expected')}</b><span>Reports you still owe</span></div>
      <div class="kpi ${sum('overdue') ? 'alert' : ''}"><b class="num">${sum('overdue')}</b><span>Client requests past due</span></div></div>` + (o.companies.length ? t.html : '') + body;
    return;
  }
  const w = S.ws; if (!w || w.company.id !== S.route.c) { m.innerHTML = '<p class="loading">Loading…</p>'; return; }
  const c = w.company;
  const docs = w.items.filter((i) => i.kind === 'doc').sort(newest);
  const out = w.items.filter((i) => i.kind !== 'doc').sort(newest);
  const t = tabs(`acc:${c.id}`, [
    { id: 'in', label: 'From client', count: docs.length },
    { id: 'out', label: 'Sent to client', count: out.length },
    { id: 'bank', label: 'Bank & invoices', count: S.rec?.transactions.length || null },
    { id: 'recurring', label: 'Recurring deadlines', count: w.obligations.filter((o) => o.active).length },
    { id: 'people', label: 'People', count: w.members.length },
    { id: 'log', label: 'Activity log' }]);
  const body = t.cur === 'in' ? toolList(`a-in:${c.id}`, docs, 'This client has not sent any documents yet.')
    : t.cur === 'out' ? toolList(`a-out:${c.id}`, out, 'You have not sent this client any reports or requests yet.')
      : t.cur === 'bank' ? bankView() : t.cur === 'recurring' ? recurringView() : t.cur === 'people' ? peopleView() : ledgerView();
  const more = t.cur === 'in' || t.cur === 'out' ? olderNote() : '';
  m.innerHTML = `<div class="ws-h"><div><p class="eyebrow">CLIENT #${c.no} · ${esc(COUNTRY(c.country).name.toUpperCase())}${c.nif ? ` · ${esc(taxLabel(c.country).toUpperCase())} ${esc(c.nif)}` : ''}</p><h1>${esc(c.name)}</h1><p class="sub" style="margin-top:6px">${[c.city, `${w.members.length} ${w.members.length === 1 ? 'person' : 'people'} with access`].filter(Boolean).map(esc).join(' · ')}</p></div>
    ${c.closed_at ? '' : `<div class="actions"><button class="btn" data-act="edit-client">Edit details</button><button class="btn" data-act="modal-request">Request a document</button><button class="btn primary" data-act="modal-report">Send a report</button></div>`}</div>`
    + (c.closed_at ? `<div class="chain bad" style="margin-bottom:16px"><div><p>Closed on ${fmtDate(c.closed_at)}. The client no longer has access and nothing can be added.</p>
      <small>You can export everything until ${fmtDate(c.export_until)}. After that the workspace is blocked, and deleted after ${fmtDate(c.purge_after)} when the retention period ends.</small></div>
      <div class="tbl-actions"><a class="btn small" href="/api/companies/${c.id}/export-all">Download everything (ZIP)</a>${isAdmin() ? '<button class="btn small" data-act="reopen-client">Reopen</button>' : ''}</div></div>` : '')
    + t.html + body + more;
}

/* ---------- AI reading costs ---------- */
const usd = (n) => `$${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: n && n < 1 ? 4 : 2 })}`;
const tok = (n) => Number(n || 0).toLocaleString('en-GB');

function aiUsageView() {
  const want = S.aiMonth || new Date().toISOString().slice(0, 7);
  if (!S.aiUsage || S.aiUsage.month !== want) {
    if (!S.aiLoading) {
      S.aiLoading = true;
      api(`/ai-usage?month=${want}`).then((r) => { S.aiUsage = r; }).catch((err) => toast(err.message)).finally(() => { S.aiLoading = false; renderData(); });
    }
    return '<p class="loading">Loading…</p>';
  }
  const r = S.aiUsage;
  const months = [...new Set([new Date().toISOString().slice(0, 7), ...r.months])].sort().reverse();
  const label = (m) => { const [y, mm] = m.split('-'); return `${MONTHS[+mm - 1]} ${y}`; };
  const budget = r.budget_usd ? `<div class="kpi ${r.spent_this_month_usd >= r.budget_usd ? 'alert' : ''}"><b class="num">${Math.round((r.spent_this_month_usd / r.budget_usd) * 100)}%</b><span>of the ${usd(r.budget_usd)} monthly budget used this month. Reading stops when it is reached.</span></div>` : '';
  const rows = r.companies.map((c) => `<tr class="click" data-act="client" data-id="${c.company_id}"><td class="mono">#${c.no}</td><td><b style="color:var(--ink)">${esc(c.name)}</b></td>
    <td class="num">${c.documents}</td><td class="num">${c.calls}${c.unsuccessful ? ` <span class="sub">(${c.unsuccessful} unsuccessful)</span>` : ''}</td><td class="num mono">${tok(c.input_tokens)}</td><td class="num mono">${tok(c.output_tokens)}</td><td class="num mono" style="text-align:right">${usd(c.cost_usd)}</td></tr>`).join('');
  const models = r.models.map((m) => `<tr><td class="mono">${esc(m.model)}</td><td>${m.kind === 'statement' ? 'Bank statements' : 'Invoices'}</td><td class="num">${m.calls}</td><td class="num mono">${tok(m.input_tokens)}</td><td class="num mono">${tok(m.output_tokens)}</td><td class="num mono" style="text-align:right">${usd(m.cost_usd)}</td><td class="num mono" style="text-align:right">${usd(m.cost_usd / m.calls)}</td></tr>`).join('');
  return `<p class="note">Cost of reading PDF and photo statements and invoices with AI, estimated from the tokens each call used and the model's list price. Norma 43, camt.053 and CSV files are read without AI and cost nothing. Anthropic's invoice is the final figure.</p>
    <div class="section-h"><div class="field" style="min-width:200px"><label for="ai-month">Month</label><select id="ai-month" class="input">${months.map((m) => `<option value="${m}" ${m === r.month ? 'selected' : ''}>${label(m)}</option>`).join('')}</select></div>
      <a class="btn small" href="/api/ai-usage.csv?month=${r.month}">Download CSV</a></div>
    <div class="kpis" style="margin-top:12px"><div class="kpi"><b class="num">${usd(r.total.cost_usd)}</b><span>Estimated cost in ${label(r.month)}</span></div>
      <div class="kpi"><b class="num">${r.total.documents}</b><span>Files read with AI</span></div>
      <div class="kpi"><b class="num">${r.total.documents ? usd(r.total.cost_usd / r.total.documents) : '—'}</b><span>Average per file</span></div>${budget}</div>
    ${r.companies.length ? `<div class="tbl-wrap"><table><thead><tr><th>No.</th><th>Client</th><th>Files</th><th>AI calls</th><th>Input tokens</th><th>Output tokens</th><th style="text-align:right">Cost</th></tr></thead><tbody>${rows}
      <tr><td></td><td><b>Total</b></td><td class="num"><b>${r.total.documents}</b></td><td class="num"><b>${r.total.calls}</b></td><td class="num mono"><b>${tok(r.total.input_tokens)}</b></td><td class="num mono"><b>${tok(r.total.output_tokens)}</b></td><td class="num mono" style="text-align:right"><b>${usd(r.total.cost_usd)}</b></td></tr></tbody></table></div>
      <h3 style="margin:22px 0 8px">By model and document type</h3><div class="tbl-wrap"><table><thead><tr><th>Model</th><th>Documents</th><th>Calls</th><th>Input tokens</th><th>Output tokens</th><th style="text-align:right">Cost</th><th style="text-align:right">Per call</th></tr></thead><tbody>${models}</tbody></table></div>`
      : '<div class="empty">No files were read with AI this month.</div>'}`;
}

/* ---------- recognised bank statements and invoices ---------- */
const money = (n, ccy) => (n == null ? '—' : `${Number(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${ccy || ''}`.trim());
const recFor = (itemId) => S.rec?.extractions.find((e) => e.item_id === itemId);
const invoiceFor = (itemId) => S.rec?.invoices.find((i) => i.item_id === itemId);
const matchesForTx = (txId) => (S.rec?.matches || []).filter((m) => m.transaction_id === txId);
const matchesForInvoice = (itemId) => (S.rec?.matches || []).filter((m) => m.invoice_item_id === itemId);
const METHOD = { norma43: 'Norma 43 file', cfonb120: 'CFONB 120 file', mt940: 'MT940 file', camt053: 'camt.053 file', csv: 'CSV export', ai: 'AI reading',
  fatturapa: 'FatturaPA e-invoice', ubl: 'UBL e-invoice (XRechnung / PEPPOL)', cii: 'CII e-invoice', facturx: 'Factur-X / ZUGFeRD data inside the PDF' };

function paymentNote(itemId) {
  const ms = matchesForInvoice(itemId);
  if (ms.some((m) => m.status === 'confirmed')) return '<span class="ontime">Paid</span>';
  if (ms.length) return 'Payment found, not confirmed';
  return '';
}

function refChips(t) {
  return [...t.invoice_refs.map((r) => `<span class="chip ref" title="Invoice number in the payment">INV ${esc(r)}</span>`),
    ...t.contract_refs.map((r) => `<span class="chip ref" title="Contract number in the payment">CTR ${esc(r)}</span>`)].join('');
}

function matchCell(t) {
  const ms = matchesForTx(t.id);
  if (!ms.length) return '<span class="sub">No invoice found</span>';
  return ms.map((m) => {
    const inv = invoiceFor(m.invoice_item_id), it = item(m.invoice_item_id);
    const label = esc(inv?.invoice_number || it?.title || 'Invoice');
    const link = `<a href="#/c/${S.route.c}/i/${m.invoice_item_id}" style="color:var(--blue)">${label}</a>`;
    if (m.status === 'confirmed') return `<div class="match ok">${link} · confirmed</div>`;
    const btns = S.me.role === 'accountant'
      ? `<span class="tbl-actions"><button class="btn small" data-act="match" data-decision="confirm" data-id="${m.id}">Confirm</button><button class="btn small" data-act="match" data-decision="reject" data-id="${m.id}">Not this</button></span>` : '';
    return `<div class="match"><div>${link} · ${m.score}% match</div><div class="sub" style="font-size:12px">${esc(m.reasons.join(', '))}</div>${btns}</div>`;
  }).join('');
}

function txTable(txs) {
  if (!txs.length) return '<div class="empty">No transactions.</div>';
  return `<div class="tbl-wrap"><table class="tx"><thead><tr><th>Date</th><th>Counterparty</th><th>Payment text and references</th><th style="text-align:right">Amount</th><th>Invoice</th></tr></thead><tbody>${txs.map((t) => `<tr>
    <td class="mono num" style="white-space:nowrap">${t.booking_date || '—'}</td>
    <td style="min-width:160px"><b style="color:var(--ink);font-weight:500">${esc(t.counterparty_name || '—')}</b>${t.counterparty_tax_id ? `<div class="mono sub">NIF ${esc(t.counterparty_tax_id)}</div>` : ''}${t.counterparty_iban ? `<div class="mono sub">${esc(t.counterparty_iban)}</div>` : ''}</td>
    <td style="min-width:260px">${esc(t.purpose)}<div class="chips">${refChips(t)}</div></td>
    <td class="num mono amt ${t.amount < 0 ? 'out' : 'in'}">${t.amount > 0 ? '+' : ''}${money(t.amount, t.currency)}</td>
    <td style="min-width:200px">${matchCell(t)}</td></tr>`).join('')}</tbody></table></div>`;
}

function statementSummary(e) {
  const x = e.summary;
  const bits = [x.bank_name, x.iban || x.account_number, x.currency, x.period_start && `${x.period_start} to ${x.period_end}`].filter(Boolean).map(esc);
  const bal = x.opening_balance != null || x.closing_balance != null ? ` · opening ${money(x.opening_balance, x.currency)}, closing ${money(x.closing_balance, x.currency)}` : '';
  const check = x.balance_check ? (x.balance_check === 'ok' ? ' · <span class="ontime">balances add up</span>' : ` · <span class="late">balances ${esc(x.balance_check)}</span>`) : '';
  return `${bits.join(' · ')}${bal}${check}<br>${x.count} transactions: ${money(x.total_in, x.currency)} in, ${money(-x.total_out, x.currency)} out · read from ${METHOD[e.method] || e.method}`;
}

function bankView() {
  const r = S.rec;
  if (!r) return '<p class="loading">Loading…</p>';
  const statements = r.extractions.filter((e) => e.kind === 'statement');
  const f = S.tab.bankFilter || 'all';
  const status = (t) => { const ms = matchesForTx(t.id); return ms.some((m) => m.status === 'confirmed') ? 'confirmed' : ms.length ? 'suggested' : 'none'; };
  const shown = r.transactions.filter((t) => f === 'all' || status(t) === f || (f === 'refs' && (t.invoice_refs.length || t.contract_refs.length)));
  const count = (k) => r.transactions.filter((t) => status(t) === k).length;
  const stItems = statements.map((e) => { const it = item(e.item_id); return `<div class="ob"><span class="ico sky" aria-hidden="true">BNK</span><span class="rm"><span class="rt"><a href="#/c/${S.route.c}/i/${e.item_id}" style="color:inherit">${esc(it?.title || 'Statement')}</a></span><span class="rs">${e.status === 'done' ? statementSummary(e) : esc(e.error || '')}</span></span><span class="pill ${e.status === 'done' ? 'ok' : 'bad'}">${e.status === 'done' ? 'Read' : 'Not read'}</span></div>`; }).join('');
  const invs = r.invoices.length;
  return `<p class="note">Bank statements and invoices are read automatically when they are uploaded. Bank files (Norma 43, CFONB 120, MT940, camt.053, CSV) and e-invoices (FatturaPA, XRechnung / UBL, Factur-X / ZUGFeRD) are read exactly; other PDFs and photos are read by AI, so check important figures against the file. Payments are matched to invoices by invoice number, amount, counterparty and date; ${S.me.role === 'accountant' ? 'you confirm each match' : 'your accountant confirms each match'}.</p>
    ${r.pending.length ? `<div class="chain"><p>Reading ${r.pending.length} file${r.pending.length > 1 ? 's' : ''}…</p></div>` : ''}
    ${S.me.role === 'accountant' ? '<div style="margin-bottom:12px"><button class="btn small" data-act="acc-export">Export for accounting software</button></div>' : ''}
    ${S.features?.bankFeeds ? bankFeedsBlock() : ''}
    <div class="stack" style="gap:10px">${stItems || `<div class="empty">No bank statements read yet. Upload one as “Bank statement”: ${esc(COUNTRY(S.ws?.company.country).bankFormats)}.</div>`}</div>
    <div class="section-h" style="margin-top:22px"><h3>Transactions</h3><div class="presets">
      ${[['all', `All ${r.transactions.length}`], ['none', `No invoice ${count('none')}`], ['suggested', `To confirm ${count('suggested')}`], ['confirmed', `Confirmed ${count('confirmed')}`], ['refs', 'With references']].map(([k, l]) => `<button class="chip${f === k ? ' on' : ''}" data-act="bank-filter" data-f="${k}">${l}</button>`).join('')}
    </div></div>
    <p class="sub" style="margin-bottom:10px">${invs} invoice${invs === 1 ? '' : 's'} read so far are used for matching.</p>
    ${txTable(shown)}`;
}

function usageLine(itemId) {
  const u = (S.rec?.usage || []).find((x) => x.item_id === itemId);
  return u ? `<p class="sub" style="font-size:12px">AI reading: ${u.calls} call${u.calls > 1 ? 's' : ''}, ${tok(u.input_tokens)} input and ${tok(u.output_tokens)} output tokens, about ${usd(u.cost_usd)}.</p>` : '';
}

function recognisedSection(it) {
  if (it.kind !== 'doc' || !S.rec) return '';
  const e = recFor(it.id), pending = S.rec.pending.includes(it.id), acc = S.me.role === 'accountant';
  const rerun = acc ? `<div class="tbl-actions"><button class="btn small" data-act="recognise" data-as="statement">Read as bank statement</button><button class="btn small" data-act="recognise" data-as="invoice">Read as invoice</button></div>` : '';
  if (pending) return `<section class="receipt"><h3>Recognised data</h3><p class="sub">Reading the file…</p></section>`;
  if (!e) return acc ? `<section class="receipt"><h3>Recognised data</h3><p class="sub">This file was not read automatically because it is not marked as a bank statement or an invoice.</p>${rerun}</section>` : '';
  if (e.status !== 'done') return `<section class="receipt"><h3>Recognised data</h3><p class="late">${esc(e.error)}</p>${usageLine(it.id)}${rerun}</section>`;
  if (e.kind === 'statement') {
    const txs = S.rec.transactions.filter((t) => t.item_id === it.id);
    return `<section style="display:grid;gap:10px"><h3>Recognised bank statement</h3><p class="sub" style="font-size:13px">${statementSummary(e)}</p>
      ${txTable(txs.slice(0, 40))}${txs.length > 40 ? `<p class="sub">Showing 40 of ${txs.length}. See all under Bank & invoices.</p>` : ''}${usageLine(it.id)}${rerun}</section>`;
  }
  const d = invoiceFor(it.id) || e.summary;
  const ms = matchesForInvoice(it.id);
  const dir = { issued: 'Sales invoice (issued by this company)', received: 'Purchase invoice (received by this company)', unknown: 'Invoice' }[d.direction] || 'Invoice';
  const rows = [['Type', dir], ['Number', d.invoice_number], ['Issuer', [d.issuer_name, d.issuer_tax_id].filter(Boolean).join(' · ')], ['Recipient', [d.recipient_name, d.recipient_tax_id].filter(Boolean).join(' · ')],
    ['Issued', d.issue_date], ['Due', d.due_date], ['Net', d.net_amount != null ? money(d.net_amount, d.currency) : null], ['Tax', d.tax_amount != null ? money(d.tax_amount, d.currency) : null],
    ['Total', d.total_amount != null ? money(d.total_amount, d.currency) : null], ['Contract', d.contract_number]].filter(([, v]) => v);
  const pays = ms.map((m) => { const t = S.rec.transactions.find((x) => x.id === m.transaction_id); const st = t && item(t.item_id);
    return t ? `<div class="match${m.status === 'confirmed' ? ' ok' : ''}"><div>${money(t.amount, t.currency)} on ${t.booking_date || '—'} · ${esc(t.counterparty_name || '')} · <a href="#/c/${S.route.c}/i/${t.item_id}" style="color:var(--blue)">${esc(st?.ref || 'statement')}</a>, line ${t.line}</div>
      <div class="sub" style="font-size:12px">${m.status === 'confirmed' ? 'Confirmed' : `${m.score}% match: ${esc(m.reasons.join(', '))}`}</div>
      ${m.status === 'suggested' && acc ? `<span class="tbl-actions"><button class="btn small" data-act="match" data-decision="confirm" data-id="${m.id}">Confirm</button><button class="btn small" data-act="match" data-decision="reject" data-id="${m.id}">Not this</button></span>` : ''}</div>` : ''; }).join('');
  return `<section style="display:grid;gap:10px"><h3>Recognised invoice</h3><dl class="meta">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
    <p class="sub" style="font-size:12px">Read from ${METHOD[e.method] || e.method}. Check the figures against the file.</p>${usageLine(it.id)}
    <h3>Payments</h3>${pays || '<p class="sub">No matching payment in the uploaded bank statements yet.</p>'}${rerun}</section>`;
}

/* ---------- recurring deadlines ---------- */
const presets = () => COUNTRY(S.ws?.company.country).presets;

function recurringView() {
  const w = S.ws, acc = S.me.role === 'accountant';
  const rows = w.obligations.map((o) => {
    const [code, col] = CATS[o.kind === 'request' ? 'Request' : o.category] || CATS.Other;
    const upcoming = w.items.filter((i) => i.obligation_id === o.id).sort((a, b) => new Date(b.due_at) - new Date(a.due_at))[0];
    return `<div class="ob${o.active ? '' : ' stopped'}"><span class="ico ${col}" aria-hidden="true">${code}</span><span class="rm"><span class="rt">${esc(o.title)}</span><span class="rs">${esc(o.description)}. Opens ${o.lead_days} days before the deadline.${upcoming ? ` Latest: ${esc(upcoming.title)}, due ${fmtDate(upcoming.due_at)}.` : ''}${o.active ? '' : ' Stopped.'}</span></span>
      ${acc && o.active ? `<button class="btn small" data-act="stop-ob" data-id="${o.id}">Stop</button>` : `<span class="pill ${o.active ? 'ok' : 'muted'}">${o.active ? 'Active' : 'Stopped'}</span>`}</div>`;
  }).join('');
  const form = acc ? `<form class="inline-form" id="obForm" novalidate><h3>Add a recurring deadline</h3>
    <p class="sub" style="font-size:13px">Templates for ${esc(COUNTRY(w.company.country).name)}. Check the dates: they are starting points, and some move with weekends or the company’s situation.</p>
    <div class="presets">${presets().map((p, i) => `<button type="button" class="chip" data-act="preset" data-i="${i}">${esc(p.label)}</button>`).join('')}</div>
    <div class="grid2"><div class="field"><label for="ob-kind">Who delivers</label><select id="ob-kind" class="input"><option value="request">The client uploads a document</option><option value="report">You send a report</option></select></div>
    <div class="field"><label for="ob-title">Title</label><input id="ob-title" class="input" placeholder="e.g. Bank statements"></div></div>
    <div class="grid2"><div class="field"><label for="ob-cat">Type</label><select id="ob-cat" class="input">${[...new Set([...DOC_TYPES, ...REPORT_TYPES])].map((x) => `<option>${x}</option>`).join('')}</select></div>
    <div class="field"><label for="ob-freq">How often</label><select id="ob-freq" class="input"><option value="monthly">Every month</option><option value="quarterly">Every quarter</option><option value="yearly">Every year</option></select></div></div>
    <div class="grid2"><div class="field"><label for="ob-day">Due on day</label><input id="ob-day" class="input" type="number" min="1" max="31" value="5"></div>
    <div class="field"><label for="ob-offset">Due in (monthly and quarterly)</label><select id="ob-offset" class="input"><option value="1">The month after the period</option><option value="2">The second month after</option><option value="3">The third month after</option></select></div></div>
    <div class="grid2"><div class="field"><label for="ob-month">Month (yearly only)</label><select id="ob-month" class="input">${MONTHS.map((x, i) => `<option value="${i + 1}">${x}</option>`).join('')}</select></div>
    <div class="field"><label for="ob-lead">Open it this many days before</label><input id="ob-lead" class="input" type="number" min="0" max="60" value="7"></div></div>
    <div class="field"><label for="ob-note">Instructions for the client (optional)</label><input id="ob-note" class="input"></div>
    <p class="err" id="obErr" hidden></p><div><button class="btn primary" type="submit">Add recurring deadline</button></div></form>` : '';
  return `<p class="note">Recurring deadlines create a request or an expected report automatically before each due date. Reminders go out if nothing arrives.</p>
    <div class="stack" style="gap:12px">${rows || '<div class="empty">No recurring deadlines yet.</div>'}${form}</div>`;
}

/* ---------- people ---------- */
function peopleView() {
  const w = S.ws;
  const people = w.members.map((p) => `<div class="person"><div><b>${esc(p.name || p.email)}</b><br><span class="sub">${esc(p.email)} · since ${fmtDate(p.created_at)}</span></div>
    ${p.id === S.me.id ? '<span class="pill muted">You</span>' : `<button class="btn small" data-act="remove-member" data-id="${p.id}" data-name="${esc(p.name || p.email)}">Remove access</button>`}</div>`).join('');
  return `<p class="note">Everyone listed here can send and receive documents for ${esc(w.company.name)}. They sign in with a link sent to their email. ${S.me.role === 'client' ? `Your accountants at ${esc(w.firm)} also see this workspace.` : ''}
    ${w.company.inbound_address ? `They can also email documents to <b class="mono" style="font-size:13px">${esc(w.company.inbound_address)}</b> <button type="button" class="linkbtn" data-act="copy" data-text="${esc(w.company.inbound_address)}">Copy</button>; only mail from the addresses listed here is accepted.` : ''}</p>
    <div class="people">${people || '<div class="empty">Nobody has access yet. Invite the first person below.</div>'}</div>
    <form class="inline-form" id="memberForm" novalidate style="margin-top:14px"><h3>Invite a person</h3>
      <div class="grid2"><div class="field"><label for="mb-name">Name</label><input id="mb-name" class="input" autocomplete="off"></div>
      <div class="field"><label for="mb-email">Email</label><input id="mb-email" class="input" type="email" autocomplete="off"></div></div>
      <p class="err" id="mbErr" hidden></p><div><button class="btn primary" type="submit">Send invitation</button></div></form>`;
}

/** When the workspace shows only recent and open items, offer the rest. */
const olderNote = () => {
  const x = S.ws?.window;
  return x && x.days && x.shown < x.total ? `<p class="note" style="margin-top:14px">Showing open items and everything from the last ${x.days} days (${x.shown} of ${x.total}). <button class="linkbtn" data-act="all-items">Show all</button></p>` : '';
};

/* ---------- activity log ---------- */
function ledgerView() {
  const w = S.ws, c = w.company;
  if (!S.verify || S.verify.id !== c.id || S.verify.count !== w.seq) {
    S.verify = { id: c.id, count: w.seq, pending: true };
    api(`/companies/${c.id}/verify`).then((r) => { if (S.verify?.id === c.id) { S.verify = { id: c.id, count: w.seq, ...r, checked: r.count }; renderData(); } }).catch(() => {});
  }
  if (!S.log || S.log.id !== c.id) {
    S.log = { id: c.id, events: [], more: false, total: w.seq, loading: true };
    loadLog();
  }
  const v = S.verify;
  const bar = v.pending ? '<div class="chain"><p>Checking the log…</p></div>' : v.ok
    ? `<div class="chain ok"><div><p>Log verified on the server: ${v.checked} entries, chain unbroken</p><small>Every entry matches its SHA-256 hash and points to the entry before it.</small></div></div>`
    : `<div class="chain bad"><div><p>Log check failed</p><small>${esc(v.reason)}. Contact ${esc(w.firm)}.</small></div></div>`;
  const evs = S.log.events;
  return `<div class="section-h"><p class="note" style="margin:0">Every action is written to an append-only log. Each entry carries the hash of the entry before it, so editing or deleting any past entry breaks the chain.</p>
    <div class="tbl-actions"><a class="btn small" href="/api/companies/${c.id}/export.csv">Download CSV</a><a class="btn small" href="/api/companies/${c.id}/report" target="_blank" rel="noopener">Printable report</a></div></div>${bar}
    <div class="tbl-wrap"><table><thead><tr><th>#</th><th>Time (${esc(cityOfTz())})</th><th>Who</th><th>What happened</th><th>Ref</th><th>Entry hash</th></tr></thead><tbody>${evs.map((e) =>
      `<tr${e.item_id ? ` class="click" data-act="item" data-c="${c.id}" data-id="${e.item_id}"` : ''}><td class="mono">${e.seq}</td><td class="mono num" style="white-space:nowrap">${fmt(e.at)}</td><td><span class="actor ${e.actor_type}">${e.actor_type}</span></td><td style="color:var(--ink);min-width:260px">${esc(e.text)}</td><td class="mono" style="white-space:nowrap">${e.ref || ''}</td><td class="mono" style="color:var(--muted)">${e.hash.slice(0, 12)}…</td></tr>`).join('')}</tbody></table></div>
    ${S.log.loading ? '<p class="loading" style="padding:16px 0">Loading…</p>' : S.log.more ? `<div style="text-align:center;margin-top:12px"><button class="btn" data-act="log-more">Show older entries</button></div>` : ''}`;
}
async function loadLog(older) {
  const L = S.log; if (!L) return;
  L.loading = true;
  try {
    const before = older && L.events.length ? `&before=${L.events[L.events.length - 1].seq}` : '';
    const r = await api(`/companies/${L.id}/events?limit=200${before}`);
    if (S.log !== L) return;
    L.events = older ? L.events.concat(r.events) : r.events; L.more = r.more; L.total = r.total;
  } catch (err) { toast(err.message); }
  L.loading = false;
  renderData();
}

const scanLine = (v) => ({
  clean: '<div class="sub" style="font-size:12.5px;color:var(--ok)">Virus scan: clean</div>',
  pending: '<div class="sub" style="font-size:12.5px">Virus scan: waiting for the scanner</div>',
  infected: `<div class="err" style="font-size:12.5px">Blocked: contains malware (${esc(v.scan_signature || '')})</div>`,
}[v.scan_status] || '');

/* ---------- drawer ---------- */
function renderDrawer() {
  const d = $('#drawer'), sc = $('#scrim');
  const it = S.route.i && item(S.route.i);
  if (!it) { d.hidden = true; sc.hidden = true; return; }
  if (it.kind === 'request' && S.me.role === 'client' && !S.seen.has(it.id) && !it.status.opened_at) {
    S.seen.add(it.id);
    api(`/items/${it.id}/seen`, { method: 'POST', body: {} }).then(refresh).catch(() => {});
  }
  const keep = $('#dr-note') ? $('#dr-note').value : '';
  const s = it.status, rec = isRecipient(it), w = S.ws;
  const cur = it.versions[it.versions.length - 1];
  const kindLabel = { doc: 'Document', report: 'Report', request: 'Document request' }[it.kind];
  const doneVerb = it.kind === 'doc' ? 'Confirm receipt' : 'Approve report';
  let acts = '';
  if (cur) acts += `<a class="btn ${rec && !it.opened_by_me ? 'primary' : ''}" href="/api/items/${it.id}/file?v=${cur.version}" target="_blank" rel="noopener" data-act="opened-file">Open document</a><a class="btn" href="/api/items/${it.id}/file?v=${cur.version}&download=1" data-act="opened-file">Download</a>`;
  if (rec && s.state !== 'done') {
    if (it.kind !== 'request' && cur) acts += `<button class="btn ok" data-act="confirm" ${it.opened_by_me ? '' : 'disabled'}>${doneVerb}</button>`;
    if (it.kind === 'report' && cur) acts += `<button class="btn" data-act="changes" ${it.opened_by_me ? '' : 'disabled'}>Ask for changes</button>`;
    if (it.kind === 'request') acts += `<button class="btn primary" data-act="upload-for">Upload the document</button>`;
    if (it.kind !== 'request' && cur && !it.opened_by_me) acts += `<p class="hint">Open the current version first. ${it.kind === 'doc' ? 'Receipt' : 'Approval'} can only be given after you have opened it.</p>`;
  }
  if (!rec) {
    if (s.state === 'expected' && S.me.role === 'accountant') acts += `<button class="btn primary" data-act="send-expected">Attach and send</button>`;
    if (cur) acts += `<button class="btn" data-act="replace">Replace file</button>`;
    if (s.state === 'sent' || s.state === 'opened') acts += `<button class="btn" data-act="remind">Send reminder</button>`;
    const toWho = it.kind === 'doc' ? 'Your accountant' : 'The client';
    if (s.state === 'sent') acts += `<p class="hint">${toWho} has not ${it.kind === 'request' ? 'seen' : 'opened'} this yet.${s.reminders ? ` ${s.reminders} reminder${s.reminders > 1 ? 's' : ''} sent so far.` : ''}</p>`;
    if (s.state === 'opened') acts += `<p class="hint">${toWho} opened it ${ago(s.opened_at)} but has not ${it.kind === 'doc' ? 'confirmed receipt' : it.kind === 'report' ? 'approved it' : 'responded'} yet.</p>`;
  }
  if (s.state === 'done') acts += `<p class="hint" style="color:var(--ok)">${STEPS[it.kind][3]} on ${fmt(s.done_at)}${it.kind !== 'request' ? ` (version ${s.version})` : ''}.</p>`;
  const linked = it.fulfilled_by ? item(it.fulfilled_by) : it.for_request ? item(it.for_request) : null;
  const meta = [
    ['Direction', it.kind === 'doc' ? `${w.company.name} → ${w.firm}` : `${w.firm} → ${w.company.name}`],
    ['Type', it.kind === 'request' ? 'Request' : it.category],
    it.period ? ['Period', periodLabel(it.period)] : null,
    it.due_at ? [it.kind === 'report' ? 'Deadline' : 'Due', fmtDate(it.due_at)] : null,
    it.note ? ['Note', it.note] : null,
  ].filter(Boolean);
  const emails = it.emails.filter((e) => !s.version_at || new Date(e.created_at) >= new Date(s.version_at) - 5000);
  const mailState = { queued: 'queued', sending: 'sending', sent: 'sent', delivered: 'delivered to the mail server', opened: 'opened', bounced: 'bounced', spam_complaint: 'marked as spam', failed: 'failed' };
  const evs = w.events.filter((e) => e.item_id === it.id);
  $('#drawer').innerHTML = `<header class="dr-h"><div style="min-width:0"><p class="eyebrow">${kindLabel.toUpperCase()} · ${it.ref}</p><h2>${esc(it.title)}</h2></div><button class="icon-btn" data-act="close-drawer" aria-label="Close">×</button></header>
  <div class="dr-b">
    ${tracker(it, true)}
    ${deadlineNote(it) ? `<p style="font-size:13px" class="rs">${deadlineNote(it)}</p>` : ''}
    <div class="dr-actions">${acts}</div>
    <dl class="meta">${meta.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}${linked ? `<dt>${it.fulfilled_by ? 'Fulfilled by' : 'Answers request'}</dt><dd><a href="#/c/${w.company.id}/i/${linked.id}" style="color:var(--blue)">${esc(linked.title)}</a></dd>` : ''}</dl>
    ${it.versions.length ? `<section style="display:grid;gap:10px"><h3>Files</h3><ul class="versions">${it.versions.slice().reverse().map((v) => `<li class="${v === cur ? 'cur' : ''}"><div><b style="color:var(--ink)">v${v.version} · ${esc(v.file_name)}</b> · ${fmtSize(v.size)} ${v === cur ? '<span class="pill sent" style="margin-left:6px">Current</span>' : ''}</div>
      <div class="sub">Uploaded ${fmt(v.uploaded_at)}${v.uploaded_by ? ` by ${esc(v.uploaded_by)}` : ''}${v.replace_reason ? `. Reason for replacing: ${esc(v.replace_reason)}` : ''}</div>
      <div class="mono">SHA-256 ${v.sha256}</div>${scanLine(v)}${v !== cur ? `<div><a href="/api/items/${it.id}/file?v=${v.version}" target="_blank" rel="noopener" style="color:var(--blue)" data-act="opened-file">Open version ${v.version}</a></div>` : ''}</li>`).join('')}</ul></section>` : ''}
    ${recognisedSection(it)}
    ${emails.length ? `<section class="mail"><h3>Email notifications</h3>${emails.map((e) => `<div class="${['bounced', 'spam_complaint', 'failed'].includes(e.status) ? 'bad' : e.status === 'delivered' || e.status === 'opened' ? 'ok' : ''}">${esc(e.to_email)}: ${mailState[e.status] || e.status} · ${fmtShort(e.updated_at)}</div>`).join('')}</section>` : ''}
    <section class="receipt"><div class="section-h" style="margin:0"><h3>Tracking report</h3><a class="btn small" href="/api/companies/${w.company.id}/report?item=${it.id}" target="_blank" rel="noopener">Open printable report</a></div>
      <p class="sub" style="font-size:12.5px">A one-page record of this item: every step with its time, file fingerprints and the log verification. Print it or save it as PDF.</p></section>
    <section style="display:grid;gap:8px"><h3><label for="dr-note">Add a note to the record</label></h3><textarea id="dr-note" class="input" rows="2" placeholder="Visible to both sides and logged with a timestamp"></textarea><div><button class="btn small" data-act="comment">Add note</button></div></section>
    <section style="display:grid;gap:12px"><h3>Full history</h3><ol class="tl">${evs.map((e) => `<li class="${e.actor_type}"><i></i><div><div class="tx">${esc(e.text)}</div><div class="tm">${fmt(e.at)} · ${e.actor_type} · #${e.seq} ${e.hash.slice(0, 10)}</div></div></li>`).join('')}</ol></section>
  </div>`;
  $('#dr-note').value = keep;
  d.hidden = false; sc.hidden = false;
}

/* ---------- modals ---------- */
function openModal(html) { const m = $('#modal'); m.innerHTML = `<div class="scrim" data-act="close-modal"></div><div class="modal-box" role="dialog" aria-modal="true">${html}</div>`; m.hidden = false; m.querySelector('input,select,textarea')?.focus(); }
function closeModal() { const m = $('#modal'); m.hidden = true; m.innerHTML = ''; }
const modalHead = (title) => `<div class="modal-h"><h2>${esc(title)}</h2><button class="icon-btn" data-act="close-modal" aria-label="Close">×</button></div>`;
const showErr = (id, msg) => { const e = $(id); if (e) { e.textContent = msg || ''; e.hidden = !msg; } };
function busy(btn, label) { if (!btn) return () => {}; const old = btn.textContent; btn.disabled = true; btn.textContent = label; return () => { btn.disabled = false; btn.textContent = old; }; }

function reportModal(expected) {
  const month = new Date().toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  openModal(`${modalHead(expected ? `Send: ${expected.title}` : `Send a report to ${S.ws.company.name}`)}
  <form class="modal-b" id="rpForm" novalidate>${expected ? `<input type="hidden" id="rp-item" value="${expected.id}"><p class="sub">Deadline ${fmtDate(expected.due_at)}.</p>` : `
    <div class="field"><label for="rp-title">Report title</label><input id="rp-title" class="input" value="Management accounts, ${month}"></div>
    <div class="grid2"><div class="field"><label for="rp-cat">Type</label><select id="rp-cat" class="input">${REPORT_TYPES.map((x) => `<option>${x}</option>`).join('')}</select></div>
    <div class="field"><label for="rp-due">Deadline</label><input id="rp-due" class="input" type="date" value="${isoIn(7)}"></div></div>`}
    <div class="field"><label for="rp-file">File</label><input id="rp-file" class="input" type="file"></div>
    <div class="field"><label for="rp-note">Message (optional)</label><textarea id="rp-note" class="input" rows="2"></textarea></div>
    <p class="err" id="rpErr" hidden></p><p class="progress" id="rpProg" hidden></p>
    <div class="dr-actions"><button class="btn primary" type="submit" id="rpBtn">Send report</button><button class="btn" type="button" data-act="close-modal">Cancel</button></div></form>`);
}
function requestModal() {
  const month = new Date().toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  openModal(`${modalHead(`Request a document from ${S.ws.company.name}`)}
  <form class="modal-b" id="rqForm" novalidate>
    <div class="field"><label for="rq-title">What do you need?</label><input id="rq-title" class="input" value="Bank statement, ${month}"></div>
    <div class="field"><label for="rq-due">Due date</label><input id="rq-due" class="input" type="date" value="${isoIn(5)}"></div>
    <div class="field"><label for="rq-note">Details (optional)</label><textarea id="rq-note" class="input" rows="2">PDF exported from online banking, all pages.</textarea></div>
    <p class="err" id="rqErr" hidden></p>
    <div class="dr-actions"><button class="btn primary" type="submit" id="rqBtn">Send request</button><button class="btn" type="button" data-act="close-modal">Cancel</button></div></form>`);
}
function replaceModal(it) {
  openModal(`${modalHead(`Replace file: ${it.title}`)}
  <form class="modal-b" id="rvForm" novalidate><p class="sub">The current version stays in the record. The other side is notified and has to open and ${it.kind === 'doc' ? 'confirm' : 'approve'} the new version.</p>
    <div class="field"><label for="rv-file">New file</label><input id="rv-file" class="input" type="file"></div>
    <div class="field"><label for="rv-reason">Why are you replacing it?</label><input id="rv-reason" class="input" placeholder="e.g. The first scan was missing page 2"></div>
    <p class="err" id="rvErr" hidden></p><p class="progress" id="rvProg" hidden></p>
    <div class="dr-actions"><button class="btn primary" type="submit" id="rvBtn">Send new version</button><button class="btn" type="button" data-act="close-modal">Cancel</button></div></form>`);
}
function clientModal(edit) {
  const c = edit ? S.ws.company : { country: S.firmInfo?.country || 'ES', name: '', nif: '', city: '' };
  const k = COUNTRY(c.country);
  const invite = edit ? '' : `<h3 style="margin-top:6px">First person to invite (optional)</h3>
    <div class="grid2"><div class="field"><label for="co-cname">Name</label><input id="co-cname" class="input"></div><div class="field"><label for="co-cemail">Email</label><input id="co-cemail" class="input" type="email"></div></div>`;
  openModal(`${modalHead(edit ? 'Client details' : 'Add a client')}
  <form class="modal-b" id="${edit ? 'coEdit' : 'coForm'}" novalidate>
    <div class="field"><label for="co-name">Company name</label><input id="co-name" class="input" value="${esc(c.name)}" placeholder="e.g. Sol y Mar Hospitality SL"></div>
    <div class="grid2"><div class="field"><label for="co-country">Country</label><select id="co-country" class="input">${countryOptions(c.country)}</select></div>
    <div class="field"><label for="co-nif" id="co-nif-l">${esc(k.taxIdLabel)}</label><input id="co-nif" class="input" value="${esc(c.nif)}" placeholder="${esc(k.taxIdHint)}"></div></div>
    <div class="field"><label for="co-city">City</label><input id="co-city" class="input" value="${esc(c.city)}"></div>
    <p class="sub" style="font-size:13px" id="co-hint">${countryHint(k)}</p>
    ${invite}
    <p class="err" id="coErr" hidden></p>
    <div class="dr-actions"><button class="btn primary" type="submit">${edit ? 'Save' : 'Create workspace'}</button><button class="btn" type="button" data-act="close-modal">Cancel</button></div></form>
    ${edit && isAdmin() ? `<div class="modal-b" style="border-top:1px solid var(--line)"><h3>Close this client</h3>
      <p class="sub" style="font-size:13.5px">At the end of the contract: the client’s people lose access at once and are told by email. You can still read and export everything for 30 days, and reopen it in that time. After that the workspace is blocked, and it is deleted once the legal retention period of its documents is over.</p>
      <div><button class="btn" type="button" data-act="close-client">Close this client…</button></div></div>` : ''}`);
}
function bankFeedsBlock() {
  if (!S.bank || S.bank.id !== S.route.c) { S.bank = { id: S.route.c, connections: null }; api(`/companies/${S.route.c}/bank`).then((r) => { if (S.bank?.id === S.route.c) { S.bank.connections = r.connections; renderData(); } }).catch(() => {}); }
  const cs = S.bank.connections;
  const st = { pending: ['warn', 'Waiting for the bank'], linked: ['ok', 'Connected'], expired: ['bad', 'Access ended: connect again'], error: ['bad', 'Not authorised'] };
  return `<section class="inline-form" style="margin-bottom:16px"><h3>Automatic bank statements</h3>
    <p class="sub" style="font-size:13.5px">Connect a bank account once and new movements arrive here by themselves, read and matched like an uploaded statement. Access is read-only, through a licensed open banking provider, and lasts 90 days at a time.</p>
    ${cs == null ? '<p class="loading" style="padding:4px 0">Loading…</p>' : cs.map((c) => `<div class="person"><div><b>${esc(c.institution_name)}</b> <span class="pill ${st[c.status]?.[0] || 'muted'}" style="margin-left:6px">${st[c.status]?.[1] || c.status}</span><br>
      <span class="sub">${c.accounts.map((a) => esc(a.iban || a.currency)).join(', ') || '—'}${c.last_sync_at ? ` · last checked ${ago(c.last_sync_at)}` : ''}${c.expires_at ? ` · access until ${fmtDate(c.expires_at)}` : ''}</span></div>
      <button class="btn small" data-act="bank-remove" data-id="${c.id}">Disconnect</button></div>`).join('')}
    <div><button class="btn small" data-act="bank-connect">Connect a bank account</button></div></section>`;
}
async function bankConnectModal() {
  openModal(`${modalHead('Connect a bank account')}<div class="modal-b"><p class="loading">Loading the banks…</p></div>`);
  try {
    const r = await api(`/companies/${S.route.c}/bank/institutions`);
    $('#modal .modal-b').innerHTML = `<form id="bankForm" novalidate style="display:grid;gap:12px">
      <div class="field"><label for="bk-q">Find your bank</label><input id="bk-q" class="input" type="search" placeholder="Type the bank’s name"></div>
      <div class="field"><label for="bk-id">Bank</label><select id="bk-id" class="input" size="8" style="height:auto;padding:8px">${r.institutions.map((i) => `<option value="${esc(i.id)}">${esc(i.name)}</option>`).join('')}</select></div>
      <p class="sub" style="font-size:13px">You will sign in at your bank to allow read-only access. Pescada never sees your banking password.</p>
      <p class="err" id="bkErr" hidden></p><div class="dr-actions"><button class="btn primary" type="submit">Continue to the bank</button></div></form>`;
    S.banks = r.institutions;
  } catch (err) { $('#modal .modal-b').innerHTML = `<p class="err">${esc(err.message)}</p>`; }
}
function exportModal() {
  const c = S.ws.company, de = c.country === 'DE';
  const y = new Date().getFullYear();
  openModal(`${modalHead('Export for accounting software')}<form class="modal-b" id="expForm" novalidate>
    <div class="field"><label for="ex-kind">What</label><select id="ex-kind" class="input">
      <option value="invoices">Invoice register: every invoice read, with its confirmed payment</option>
      <option value="bank">Bank movements, with the invoice each one pays</option>
      ${de ? '<option value="datev">DATEV booking batch (Buchungsstapel), beta</option>' : ''}</select></div>
    <div class="grid2"><div class="field"><label for="ex-from">From</label><input id="ex-from" class="input" type="date" value="${y}-01-01"></div>
    <div class="field"><label for="ex-to">To</label><input id="ex-to" class="input" type="date" value="${y}-12-31"></div></div>
    ${de ? `<div id="ex-datev" hidden><div class="grid2"><div class="field"><label for="ex-cons">Beraternummer</label><input id="ex-cons" class="input" inputmode="numeric"></div>
      <div class="field"><label for="ex-client">Mandantennummer</label><input id="ex-client" class="input" inputmode="numeric" value="${c.no}"></div></div>
      <div class="grid2"><div class="field"><label for="ex-bank">Bank account (SKR03 1200)</label><input id="ex-bank" class="input" value="1200"></div>
      <div class="field"><label for="ex-len">Account length</label><input id="ex-len" class="input" type="number" min="4" max="8" value="4"></div></div>
      <div class="grid2"><div class="field"><label for="ex-deb">Debtors (money in)</label><input id="ex-deb" class="input" value="10000"></div>
      <div class="field"><label for="ex-cred">Creditors (money out)</label><input id="ex-cred" class="input" value="70000"></div></div>
      <p class="sub" style="font-size:13px">One booking per confirmed payment, bank account against the debtor or creditor account, invoice number as Belegfeld 1. Try it on a test client in DATEV first.</p></div>` : ''}
    <p class="sub" style="font-size:13px">The CSV uses ${esc(COUNTRY(c.country).name)} conventions (semicolons, decimal commas) and opens in a spreadsheet or in the import tool of A3, Sage, TeamSystem, Cegid, PHC and others. The export is recorded in the log.</p>
    <div class="dr-actions"><button class="btn primary" type="submit">Download</button><button class="btn" type="button" data-act="close-modal">Cancel</button></div></form>`);
}
function closeClientModal() {
  const c = S.ws.company;
  openModal(`${modalHead(`Close ${c.name}`)}<form class="modal-b" id="closeForm" novalidate>
    <p>The people of ${esc(c.name)} lose access now. Nothing can be added any more. You can export everything for 30 days.</p>
    <div class="field"><label for="cl-reason">Reason (kept in the log, optional)</label><input id="cl-reason" class="input" placeholder="e.g. Contract ended on 31 December"></div>
    <div class="field"><label for="cl-confirm">Type the client’s name to confirm: <b>${esc(c.name)}</b></label><input id="cl-confirm" class="input" autocomplete="off"></div>
    <p class="err" id="closeErr" hidden></p>
    <div class="dr-actions"><button class="btn primary" type="submit">Close the client</button><button class="btn" type="button" data-act="close-modal">Cancel</button></div></form>`);
}
const countryHint = (k) => `The country sets the tax ID check, the time zone of deadlines (${esc(k.tz.split('/').pop())}), the deadline templates and the formats read exactly: ${esc(k.bankFormats)}.`;

const isAdmin = () => S.me?.role === 'accountant' && S.me.firmRole === 'admin';

async function firmModal(tab) {
  let team = { team: [], admin: false };
  try { team = await api('/firm/team'); } catch (err) { toast(err.message); }
  const admin = team.admin;
  const access = (m) => (m.all_clients ? 'All clients' : `${m.company_ids.length} client${m.company_ids.length === 1 ? '' : 's'}`);
  const members = team.team.map((m) => `<div class="person"><div><b>${esc(m.name || m.email)}</b> ${m.firm_role === 'admin' ? '<span class="pill sent" style="margin-left:6px">Administrator</span>' : ''}${m.disabled_at ? '<span class="pill muted" style="margin-left:6px">Disabled</span>' : ''}
      <br><span class="sub">${esc(m.email)} · ${access(m)} · ${m.mfa ? 'two-step sign-in on' : '<span style="color:var(--bad)">no two-step sign-in</span>'}${m.last_seen_at ? ` · active ${ago(m.last_seen_at)}` : ' · never signed in'}</span></div>
      ${admin && m.id !== team.me ? `<button class="btn small" data-act="member-edit" data-id="${m.id}">Change</button>` : ''}</div>`).join('');
  S.team = team.team;
  const settings = admin ? `<form id="firmForm" novalidate style="display:grid;gap:12px">
    <div class="field"><label for="fm-name">Firm name</label><input id="fm-name" class="input" value="${esc(S.firm)}"></div>
    <div class="field"><label for="fm-country">Country</label><select id="fm-country" class="input">${countryOptions(S.firmInfo?.country)}</select></div>
    <p class="sub" style="font-size:13px">Clients see the firm name in every email. The country is the default for new clients; each client keeps its own country.</p>
    <label style="display:flex;gap:10px;align-items:flex-start"><input type="checkbox" id="fm-mfa" ${S.firmInfo?.require_mfa ? 'checked' : ''} style="margin-top:4px"><span>Require two-step sign-in for every accountant of the firm</span></label>
    <p class="err" id="fmErr" hidden></p><div><button class="btn primary" type="submit">Save</button></div></form>` : '';
  const invite = admin ? `<form id="inviteForm" class="inline-form" novalidate><h3>Invite a colleague</h3>
    <div class="grid2"><div class="field"><label for="iv-name">Name</label><input id="iv-name" class="input"></div><div class="field"><label for="iv-email">Email</label><input id="iv-email" class="input" type="email"></div></div>
    ${memberFields('iv', { firm_role: 'staff', all_clients: true, company_ids: [] })}
    <p class="err" id="ivErr" hidden></p><div><button class="btn primary" type="submit">Send invitation</button></div></form>` : '';
  openModal(`${modalHead(admin ? 'Firm settings and team' : 'Your firm’s team')}<div class="modal-b">${settings}
    <h3 style="margin-top:6px">Team</h3><div class="people">${members}</div>${invite}
    ${admin ? `<div class="dr-actions"><button class="btn small" data-act="firm-log">Firm activity log</button>${S.firmInfo?.plan && S.firmInfo.plan !== 'internal' ? '<button class="btn small" data-act="billing">Subscription</button>' : ''}</div><div id="firmLog"></div>` : ''}</div>`);
  if (tab === 'team') $('#iv-email')?.focus();
}
function memberFields(p, m) {
  const cos = S.overview?.companies || S.companies || [];
  return `<div class="grid2"><div class="field"><label for="${p}-role">Role</label><select id="${p}-role" class="input"><option value="staff" ${m.firm_role === 'staff' ? 'selected' : ''}>Staff</option><option value="admin" ${m.firm_role === 'admin' ? 'selected' : ''}>Administrator</option></select></div>
    <div class="field"><label for="${p}-all">Clients</label><select id="${p}-all" class="input" data-toggle="${p}-cos"><option value="1" ${m.all_clients ? 'selected' : ''}>All clients</option><option value="0" ${m.all_clients ? '' : 'selected'}>Only the clients chosen below</option></select></div></div>
    <div id="${p}-cos" class="presets" ${m.all_clients ? 'hidden' : ''} style="max-height:180px;overflow:auto">${cos.map((c) => `<label class="chip" style="cursor:pointer"><input type="checkbox" value="${c.id}" ${m.company_ids.includes(c.id) ? 'checked' : ''}> #${c.no} ${esc(c.name)}</label>`).join('') || '<span class="sub">No clients yet.</span>'}</div>
    <p class="sub" style="font-size:13px">Administrators manage the firm’s settings, team and AI costs. Staff work with clients.</p>`;
}
const memberValues = (p) => ({ role: $(`#${p}-role`).value, allClients: $(`#${p}-all`).value === '1', companyIds: [...document.querySelectorAll(`#${p}-cos input:checked`)].map((x) => x.value) });
function memberModal(m) {
  openModal(`${modalHead(`Change ${m.name || m.email}`)}<form class="modal-b" id="memberEdit" data-id="${m.id}" novalidate>
    ${memberFields('me', m)}
    <p class="err" id="meErr" hidden></p>
    <div class="dr-actions"><button class="btn primary" type="submit">Save</button>
    <button class="btn" type="button" data-act="member-toggle" data-id="${m.id}" data-off="${m.disabled_at ? '0' : '1'}">${m.disabled_at ? 'Enable the account' : 'Disable the account'}</button>
    <button class="btn" type="button" data-act="firm-settings">Back</button></div></form>`);
}

/* ---------- forms ---------- */
const pct = (el, label) => (p) => { const e = $(el); if (e) { e.hidden = false; e.textContent = `${label} ${Math.round(p * 100)}%`; } };

document.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    if (f.id === 'loginForm') {
      const email = $('#li-email').value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return showErr('#liErr', 'Enter the email address your accountant invited.');
      const done = busy(f.querySelector('button'), 'Sending…');
      try { await api('/auth/request', { method: 'POST', body: { email } }); renderLogin(email); } catch (err) { showErr('#liErr', err.message); done(); }
    }
    if (f.id === 'upForm') {
      const files = [...$('#up-file').files, ...(S.photoPdf ? [S.photoPdf] : [])];
      if (!files.length) return showErr('#upErr', 'Choose at least one file to send.');
      showErr('#upErr', '');
      const form = new FormData();
      form.append('category', $('#up-cat').value); form.append('period', $('#up-period').value);
      form.append('requestId', $('#up-req').value); form.append('note', $('#up-note').value.trim());
      files.forEach((x) => form.append('files', x, x.name));
      const done = busy($('#upBtn'), 'Sending…');
      try {
        const r = await upload(`/companies/${S.route.c}/documents`, form, pct('#upProg', 'Uploading'));
        f.reset(); S.photoPdf = null; $('#up-period').value = thisMonth(); $('#dropFiles').textContent = '';
        S.tab[`c:${S.route.c}`] = 'sent';
        toast(`Sent ${r.sent} file${r.sent > 1 ? 's' : ''}. Your accountant has been notified.`);
        await refresh();
      } catch (err) { showErr('#upErr', err.message); }
      $('#upProg').hidden = true; done();
    }
    if (f.id === 'rpForm') {
      const file = $('#rp-file').files[0];
      if (!file) return showErr('#rpErr', 'Attach the report file.');
      const form = new FormData();
      if ($('#rp-item')) form.append('itemId', $('#rp-item').value);
      else { form.append('title', $('#rp-title').value.trim()); form.append('category', $('#rp-cat').value); form.append('due', $('#rp-due').value); }
      form.append('note', $('#rp-note').value.trim()); form.append('file', file, file.name);
      const done = busy($('#rpBtn'), 'Sending…');
      try { await upload(`/companies/${S.route.c}/reports`, form, pct('#rpProg', 'Uploading')); closeModal(); S.tab[`acc:${S.route.c}`] = 'out'; toast('Report sent. The client has been notified.'); await refresh(); } catch (err) { showErr('#rpErr', err.message); done(); }
    }
    if (f.id === 'rqForm') {
      const done = busy($('#rqBtn'), 'Sending…');
      try { await api(`/companies/${S.route.c}/requests`, { method: 'POST', body: { title: $('#rq-title').value.trim(), due: $('#rq-due').value, note: $('#rq-note').value.trim() } }); closeModal(); S.tab[`acc:${S.route.c}`] = 'out'; toast('Request sent. The client has been notified.'); await refresh(); } catch (err) { showErr('#rqErr', err.message); done(); }
    }
    if (f.id === 'rvForm') {
      const file = $('#rv-file').files[0], reason = $('#rv-reason').value.trim();
      if (!file) return showErr('#rvErr', 'Choose the new file.');
      if (!reason) return showErr('#rvErr', 'Say why you are replacing the file. The reason is kept in the log.');
      const form = new FormData(); form.append('reason', reason); form.append('file', file, file.name);
      const done = busy($('#rvBtn'), 'Sending…');
      try { await upload(`/items/${S.route.i}/versions`, form, pct('#rvProg', 'Uploading')); closeModal(); toast('New version sent. The earlier one is kept.'); await refresh(); } catch (err) { showErr('#rvErr', err.message); done(); }
    }
    if (f.id === 'coForm') {
      const name = $('#co-name').value.trim();
      if (!name) return showErr('#coErr', 'Enter the company name.');
      const r = await api('/companies', { method: 'POST', body: { name, country: $('#co-country').value, nif: $('#co-nif').value.trim(), city: $('#co-city').value.trim(), contactName: $('#co-cname').value.trim(), contactEmail: $('#co-cemail').value.trim() } })
        .catch((err) => { showErr('#coErr', err.message); return null; });
      if (r) { closeModal(); toast('Workspace created.'); go(r.id); }
    }
    if (f.id === 'coEdit') {
      const name = $('#co-name').value.trim();
      if (!name) return showErr('#coErr', 'Enter the company name.');
      const ok = await api(`/companies/${S.route.c}`, { method: 'PATCH', body: { name, country: $('#co-country').value, nif: $('#co-nif').value.trim(), city: $('#co-city').value.trim() } })
        .then(() => true, (err) => { showErr('#coErr', err.message); return false; });
      if (ok) { closeModal(); toast('Client details saved. The change is in the log.'); await refresh(); }
    }
    if (f.id === 'mfaForm') {
      const done = busy(f.querySelector('button'), 'Checking…');
      try { await api('/auth/mfa', { method: 'POST', body: { code: $('#mfa-code').value.trim() } }); location.reload(); } catch (err) { showErr('#mfaErr', err.message); done(); }
      return;
    }
    if (f.id === 'mfaEnable') {
      try { const r = await api('/me/2fa/enable', { method: 'POST', body: { code: $('#mfa-new').value.trim() } }); S.me.mfa = { ...S.me.mfa, enabled: true }; showRecoveryCodes(r.recoveryCodes, true); } catch (err) { showErr('#mfaNewErr', err.message); }
      return;
    }
    if (f.id === 'mfaManage') {
      const what = e.submitter?.dataset.do, code = $('#mm-code').value.trim();
      try {
        if (what === 'disable') { await api('/me/2fa/disable', { method: 'POST', body: { code } }); S.me.mfa.enabled = false; closeModal(); toast('Two-step sign-in is off.'); }
        else { const r = await api('/me/2fa/recovery', { method: 'POST', body: { code } }); showRecoveryCodes(r.recoveryCodes); }
      } catch (err) { showErr('#mmErr', err.message); }
      return;
    }
    if (f.id === 'accForm') {
      const body = { name: $('#ac-name').value.trim() };
      if (S.me.role === 'accountant') Object.assign(body, { notifyMode: $('#ac-mode').value, digestHour: Number($('#ac-hour').value) });
      const ok = await api('/me', { method: 'PATCH', body }).then(() => true, (err) => { showErr('#acErr', err.message); return false; });
      if (ok) { Object.assign(S.me, body); closeModal(); toast('Saved.'); renderHeader(); }
      return;
    }
    if (f.id === 'bankForm') {
      const id = $('#bk-id').value;
      if (!id) return showErr('#bkErr', 'Choose your bank.');
      try { const r = await api(`/companies/${S.route.c}/bank/connect`, { method: 'POST', body: { institutionId: id } }); location.href = r.url; } catch (err) { showErr('#bkErr', err.message); }
      return;
    }
    if (f.id === 'expForm') {
      const p = new URLSearchParams({ kind: $('#ex-kind').value, from: $('#ex-from').value, to: $('#ex-to').value });
      if (p.get('kind') === 'datev') for (const [k, id] of [['consultant', 'ex-cons'], ['client', 'ex-client'], ['bank', 'ex-bank'], ['accountLength', 'ex-len'], ['debtor', 'ex-deb'], ['creditor', 'ex-cred']]) p.set(k, $(`#${id}`).value);
      const a = document.createElement('a'); a.href = `/api/companies/${S.route.c}/accounting-export?${p}`; document.body.append(a); a.click(); a.remove();
      closeModal(); return;
    }
    if (f.id === 'closeForm') {
      const ok = await api(`/companies/${S.route.c}/close`, { method: 'POST', body: { confirm: $('#cl-confirm').value.trim(), reason: $('#cl-reason').value.trim() } })
        .then(() => true, (err) => { showErr('#closeErr', err.message); return false; });
      if (ok) { closeModal(); toast('Client closed. Their access has ended.'); await refresh(); }
      return;
    }
    if (f.id === 'signupForm') {
      const body = { firmName: $('#su-firm').value.trim(), country: $('#su-country').value, name: $('#su-name').value.trim(), email: $('#su-email').value.trim() };
      if (!body.firmName || !body.email) return showErr('#suErr', 'Enter the firm’s name and your email.');
      const done = busy(f.querySelector('button[type=submit]'), 'Starting…');
      try { await api('/signup', { method: 'POST', body }); renderSignup(body.email); } catch (err) { showErr('#suErr', err.message); done(); }
      return;
    }
    if (f.id === 'inviteForm') {
      const body = { name: $('#iv-name').value.trim(), email: $('#iv-email').value.trim(), ...memberValues('iv') };
      const ok = await api('/firm/team', { method: 'POST', body }).then(() => true, (err) => { showErr('#ivErr', err.message); return false; });
      if (ok) { toast(`Invitation sent to ${body.email}.`); firmModal(); }
      return;
    }
    if (f.id === 'memberEdit') {
      const ok = await api(`/firm/team/${f.dataset.id}`, { method: 'PATCH', body: memberValues('me') }).then(() => true, (err) => { showErr('#meErr', err.message); return false; });
      if (ok) { toast('Saved. The change is in the firm’s log.'); firmModal(); }
      return;
    }
    if (f.id === 'firmForm') {
      const name = $('#fm-name').value.trim(), country = $('#fm-country').value;
      const ok = await api('/firm', { method: 'PATCH', body: { name, country, requireMfa: $('#fm-mfa').checked } }).then(() => true, (err) => { showErr('#fmErr', err.message); return false; });
      if (ok) { S.firm = name; S.firmInfo = { ...S.firmInfo, name, country, require_mfa: $('#fm-mfa').checked }; toast('Firm details saved.'); renderShell(); await refresh(); firmModal(); }
    }
    if (f.id === 'memberForm') {
      const email = $('#mb-email').value.trim();
      if (!email) return showErr('#mbErr', 'Enter their email address.');
      await api(`/companies/${S.route.c}/members`, { method: 'POST', body: { email, name: $('#mb-name').value.trim() } });
      toast(`Invitation sent to ${email}.`); await refresh();
    }
    if (f.id === 'obForm') {
      const body = { kind: $('#ob-kind').value, title: $('#ob-title').value.trim(), category: $('#ob-cat').value, frequency: $('#ob-freq').value,
        dueDay: Number($('#ob-day').value), dueMonth: Number($('#ob-month').value), monthOffset: Number($('#ob-offset').value), leadDays: Number($('#ob-lead').value), note: $('#ob-note').value.trim() };
      if (!body.title) return showErr('#obErr', 'Enter a title.');
      await api(`/companies/${S.route.c}/obligations`, { method: 'POST', body });
      toast('Recurring deadline added.'); await refresh();
    }
  } catch (err) {
    const target = { memberForm: '#mbErr', obForm: '#obErr' }[f.id];
    if (target) showErr(target, err.message); else toast(err.message);
  }
});

/* ---------- clicks ---------- */
let toastT;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 3500); }

async function act(path, body, okMsg) {
  try { await api(path, { method: 'POST', body: body || {} }); if (okMsg) toast(okMsg); await refresh(); } catch (err) { toast(err.message); }
}

document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const a = b.dataset.act;
  const it = S.route.i && item(S.route.i);
  switch (a) {
    case 'item': if (!$('#modal').hidden) closeModal(); go(b.dataset.c, b.dataset.id); break;
    case 'client': go(b.dataset.id || null); break;
    case 'tab': S.tab[b.dataset.key] = b.dataset.tab; renderData(); break;
    case 'log-more': loadLog(true); break;
    case 'all-items': (S.allItems ||= {})[S.route.c] = true; await refresh(); break;
    case 'close-drawer': go(S.route.c); break;
    case 'close-modal': closeModal(); break;
    case 'logout': await api('/auth/logout', { method: 'POST', body: {} }).catch(() => {}); location.hash = ''; location.reload(); break;
    case 'login-again': history.replaceState(null, '', '#/'); renderLogin(); break;
    case 'opened-file': setTimeout(refresh, 1500); break;
    case 'confirm': await act(`/items/${it.id}/confirm`, {}, it.kind === 'report' ? 'Report approved. Your accountant has been notified.' : 'Receipt confirmed. The sender has been notified.'); break;
    case 'changes': {
      const msg = $('#dr-note').value.trim();
      if (!msg) { toast('Write what should change in the note box first.'); $('#dr-note').focus(); break; }
      $('#dr-note').value = ''; await act(`/items/${it.id}/changes`, { message: msg }, 'Change request sent.'); break;
    }
    case 'comment': {
      const msg = $('#dr-note').value.trim();
      if (!msg) { $('#dr-note').focus(); break; }
      $('#dr-note').value = ''; await act(`/items/${it.id}/comments`, { message: msg }, 'Note added to the record.'); break;
    }
    case 'match': await act(`/companies/${S.route.c}/matches/${b.dataset.id}/${b.dataset.decision}`, {}, b.dataset.decision === 'confirm' ? 'Payment confirmed for this invoice.' : 'Marked as not related.'); break;
    case 'recognise': await act(`/items/${it.id}/recognise`, { as: b.dataset.as }, 'Reading the file. Results appear in a few seconds.'); break;
    case 'bank-filter': S.tab.bankFilter = b.dataset.f; renderData(); break;
    case 'remind': await act(`/items/${it.id}/remind`, {}, 'Reminder sent.'); break;
    case 'replace': replaceModal(it); break;
    case 'send-expected': reportModal(it); break;
    case 'upload-for': { const id = it.id; go(S.route.c); setTimeout(() => { const sel = $('#up-req'); if (sel) sel.value = id; $('#upForm')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 50); break; }
    case 'modal-report': reportModal(); break;
    case 'modal-request': requestModal(); break;
    case 'new-client': clientModal(); break;
    case 'edit-client': clientModal(true); break;
    case 'firm-settings': firmModal(); break;
    case 'account': accountModal(); break;
    case 'signup': history.replaceState(null, '', '#/signup'); renderSignup(); break;
    case 'billing': billingModal(); break;
    case 'checkout': case 'portal': try { const r = await api(`/billing/${b.dataset.act}`, { method: 'POST', body: {} }); location.href = r.url; } catch (err) { toast(err.message); } break;
    case 'sel-toggle': { const f = filtState(b.dataset.key); f.selecting = !f.selecting; f.picked.clear(); renderData(); break; }
    case 'sel-all': { const k = b.dataset.key; applyFilter(k, S.lists[k].items).forEach((i) => filtState(k).picked.add(i.id)); redrawList(k); break; }
    case 'bulk-zip': {
      const ids = [...filtState(b.dataset.key).picked];
      const a = document.createElement('a'); a.href = `/api/companies/${S.route.c}/archive?ids=${ids.join(',')}`; a.download = ''; document.body.append(a); a.click(); a.remove();
      toast('Preparing the ZIP. Each file is recorded as downloaded by you.'); setTimeout(refresh, 2500); break;
    }
    case 'bulk-confirm': {
      const k = b.dataset.key, ids = [...filtState(k).picked];
      try {
        const r = await api(`/companies/${S.route.c}/confirm-many`, { method: 'POST', body: { ids } });
        filtState(k).picked.clear();
        toast(r.skipped.length ? `Confirmed ${r.confirmed.length}. ${r.skipped.length} not confirmed: open them first (or download them as ZIP).` : `Confirmed ${r.confirmed.length}. The senders have been notified.`);
        await refresh();
      } catch (err) { toast(err.message); }
      break;
    }
    case 'search-docs': searchModal($('#cl-search')?.value || ''); break;
    case 'tips-done': try { localStorage.setItem(`pescada.tips.${b.dataset.id}`, '1'); } catch { /* private mode */ } $('#tips')?.remove(); break;
    case 'copy': try { await navigator.clipboard.writeText(b.dataset.text); toast('Copied.'); } catch { toast(b.dataset.text); } break;
    case 'close-client': closeClientModal(); break;
    case 'acc-export': exportModal(); break;
    case 'bank-connect': bankConnectModal(); break;
    case 'bank-remove': if (confirm('Disconnect this bank? Statements already fetched stay.')) { try { await api(`/companies/${S.route.c}/bank/${b.dataset.id}`, { method: 'DELETE' }); S.bank = null; toast('Bank disconnected.'); renderData(); } catch (err) { toast(err.message); } } break;
    case 'reopen-client': if (confirm('Reopen this client? Their people can sign in again.')) await act(`/companies/${S.route.c}/reopen`, {}, 'Client reopened.'); break;
    case 'member-edit': memberModal(S.team.find((m) => m.id === b.dataset.id)); break;
    case 'member-toggle': {
      const off = b.dataset.off === '1';
      if (off && !confirm('Disable this account? They are signed out at once and can no longer sign in. Their past actions stay in the logs.')) break;
      try { await api(`/firm/team/${b.dataset.id}`, { method: 'PATCH', body: { disabled: off } }); toast(off ? 'Account disabled.' : 'Account enabled.'); firmModal(); } catch (err) { showErr('#meErr', err.message); }
      break;
    }
    case 'firm-log': {
      try {
        const r = await api('/firm/events');
        $('#firmLog').innerHTML = `<div class="tbl-wrap"><table><thead><tr><th>When</th><th>What happened</th></tr></thead><tbody>${r.events.map((e) => `<tr><td class="mono" style="white-space:nowrap">${fmt(e.at)}</td><td>${esc(e.text)}</td></tr>`).join('') || '<tr><td colspan="2">Nothing yet.</td></tr>'}</tbody></table></div>`;
      } catch (err) { toast(err.message); }
      break;
    }
    case 'mfa-start': startMfaSetup(); break;
    case 'reload': location.reload(); break;
    case 'session-out': try { await api(`/me/sessions/${b.dataset.id}`, { method: 'DELETE' }); toast('Signed out on that device.'); accountModal(); } catch (err) { toast(err.message); } break;
    case 'sessions-out': try { const r = await api('/me/sessions/sign-out-others', { method: 'POST', body: {} }); toast(`Signed out on ${r.signedOut} other device${r.signedOut === 1 ? '' : 's'}.`); accountModal(); } catch (err) { toast(err.message); } break;
    case 'preset': {
      const p = presets()[+b.dataset.i];
      $('#ob-kind').value = p.kind; $('#ob-title').value = p.title; $('#ob-cat').value = p.category; $('#ob-freq').value = p.frequency;
      $('#ob-day').value = p.dueDay; $('#ob-lead').value = p.leadDays; $('#ob-offset').value = p.monthOffset || 1; if (p.dueMonth) $('#ob-month').value = p.dueMonth;
      if (p.note) toast(p.note);
      break;
    }
    case 'stop-ob': if (confirm('Stop this recurring deadline? Items already created stay.')) await act(`/companies/${S.route.c}/obligations/${b.dataset.id}/stop`, {}, 'Recurring deadline stopped.'); break;
    case 'remove-member':
      if (confirm(`Remove access for ${b.dataset.name}? Their past actions stay in the log.`)) {
        try { await api(`/companies/${S.route.c}/members/${b.dataset.id}`, { method: 'DELETE' }); toast('Access removed.'); await refresh(); } catch (err) { toast(err.message); }
      }
      break;
  }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (!$('#modal').hidden) closeModal(); else if (S.route.i) go(S.route.c); } });

// keep the view current: other people act in the same workspace
document.addEventListener('input', (e) => {
  const key = e.target.closest?.('.tools')?.dataset.key;
  if (key && e.target.dataset.filter) { filtState(key)[e.target.dataset.filter] = e.target.value; redrawList(key); }
  if (e.target.id === 'bk-q') { const q = e.target.value.toLowerCase(); $('#bk-id').innerHTML = (S.banks || []).filter((i) => i.name.toLowerCase().includes(q)).map((i) => `<option value="${esc(i.id)}">${esc(i.name)}</option>`).join(''); }
  if (e.target.id === 'sq') { clearTimeout(S.sqT); S.sqT = setTimeout(() => runSearch(e.target.value), 250); }
});
document.addEventListener('change', (e) => {
  if (e.target.dataset?.sel) { const f = filtState(e.target.dataset.sel); if (e.target.checked) f.picked.add(e.target.value); else f.picked.delete(e.target.value); redrawList(e.target.dataset.sel); return; }
  if (e.target.id === 'up-cam') { photosToPdf([...e.target.files]); return; }
  if (e.target.id === 'ai-month') { S.aiMonth = e.target.value; S.aiUsage = null; renderData(); }
  if (e.target.id === 'ex-kind') { const d = $('#ex-datev'); if (d) d.hidden = e.target.value !== 'datev'; }
  if (e.target.dataset?.toggle) { const box = $(`#${e.target.dataset.toggle}`); if (box) box.hidden = e.target.value === '1'; }
  if (e.target.id === 'co-country') {
    const k = COUNTRY(e.target.value);
    $('#co-nif-l').textContent = k.taxIdLabel; $('#co-nif').placeholder = k.taxIdHint; $('#co-hint').innerHTML = countryHint(k);
  }
});
window.addEventListener('focus', () => S.me && refresh());
// poll a cheap change marker and reload only when something happened
async function poll() {
  if (!S.me || document.visibilityState !== 'visible' || !$('#modal').hidden) return;
  try {
    if (S.route.c && S.ws) {
      const ch = await api(`/companies/${S.route.c}/changes`);
      if (ch.seq !== S.ws.seq || ch.pending) await refresh();
    } else if (S.me.role === 'accountant') {
      const ch = await api('/overview/changes');
      if (ch.seq !== S.ovSeq) { S.ovSeq = ch.seq; await refresh(); }
    } else await refresh();
  } catch { /* offline for a moment: try again next time */ }
}
setInterval(poll, 20000);

/* ---------- start ---------- */
(async () => {
  try {
    const me = await api('/me');
    S.me = me.user; S.firm = me.firm; S.companies = me.companies; S.firmInfo = me.firmInfo; S.countries = me.countries || []; S.features = me.features || {};
    if (/[?&]bank=ok/.test(location.hash)) setTimeout(() => toast('Bank connected. Its movements are being fetched.'), 800);
    if (/[?&]bank=failed/.test(location.hash)) setTimeout(() => toast('The bank did not grant access. You can try again.'), 800);
    if (me.user.mfa?.pending) return renderMfaCode();
    if (me.user.mfa?.setupRequired) return renderMfaSetupRequired();
    if (location.hash.startsWith('#/billing')) { if (location.hash === '#/billing/done') toast('Thank you. Your subscription is being activated.'); history.replaceState(null, '', '#/'); }
    if (S.firmInfo) TZ = COUNTRY(S.firmInfo.country).tz;
    renderShell();
    await route();
  } catch (err) {
    if (err.status === 401) { if (location.hash.startsWith('#/signup')) renderSignup(); else renderLogin(); } else $('#view').innerHTML = `<p class="loading">${esc(err.message)}</p>`;
  }
})();
