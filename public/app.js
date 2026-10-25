// Voixa Exchange web client. Plain modules, no build step.
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

const S = { me: null, firm: '', companies: [], overview: null, ws: null, wsId: null, route: { c: null, i: null }, tab: {}, search: '', shellKey: '', verify: null, seen: new Set() };

/* ---------- formatting ---------- */
const TZ = 'Europe/Madrid';
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
  if (!r.ok) throw Object.assign(new ApiError(data.error || 'Something went wrong. Try again.'), { status: r.status });
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
      const [ws, rec] = await Promise.all([api(`/companies/${S.route.c}`), api(`/companies/${S.route.c}/recognition`)]);
      S.ws = ws; S.rec = rec;
      S.wsId = S.route.c;
      // while files are being read, check back soon
      clearTimeout(S.recTimer);
      if (rec.pending.length) S.recTimer = setTimeout(refresh, 4000);
    } else { S.ws = null; S.wsId = null; }
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
    return [s.opened_at ? 'info' : 'warn', `${s.opened_at ? 'Seen' : 'Not seen yet'} · due in ${dur(left)}`];
  }
  if (s.state === 'done') return ['ok', it.kind === 'report' ? 'Approved' : 'Received & confirmed'];
  if (s.changes_requested_at) return ['warn', 'Changes requested'];
  if (s.state === 'opened') return ['info', it.kind === 'report' ? 'Opened · not approved' : 'Opened · not confirmed'];
  const age = now - new Date(s.version_at);
  return age > 48 * H ? ['bad', `Not opened for ${dur(age)}`] : ['warn', 'Not opened yet'];
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
const list = (items, empty, opts) => (items.length ? `<div class="list${opts?.compact ? ' compact' : ''}">${items.map((i) => row(i, opts)).join('')}</div>` : `<div class="empty">${empty}</div>`);
const newest = (a, b) => new Date(b.status.sent_at || b.created_at) - new Date(a.status.sent_at || a.created_at);

/* ---------- header ---------- */
function renderHeader() {
  const h = $('#hdrRight');
  if (!S.me) { h.innerHTML = ''; return; }
  const switcher = S.me.role === 'client' && S.companies.length > 1
    ? `<select class="input" id="coSwitch" aria-label="Company" style="width:auto">${S.companies.map((c) => `<option value="${c.id}" ${c.id === S.route.c ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>` : '';
  h.innerHTML = `${switcher}<span class="who"><i></i>${esc(S.me.name || S.me.email)} · ${S.me.role === 'accountant' ? 'Accountant' : 'Client'}</span><button class="btn small" data-act="logout">Sign out</button>`;
  $('#coSwitch')?.addEventListener('change', (e) => go(e.target.value));
}

/* ---------- sign in ---------- */
function renderLogin(sentTo) {
  $('#hdrRight').innerHTML = '';
  $('#view').innerHTML = `<section class="card pad setup" style="max-width:480px;margin:40px auto">${sentTo
    ? `<h1>Check your inbox</h1><p class="sub" style="margin-top:8px">If ${esc(sentTo)} has access, a sign-in link is on its way. It works once and expires in 30 minutes. Check the spam folder if it does not arrive within a few minutes.</p><p style="margin-top:16px"><button class="btn" data-act="login-again">Use another address</button></p>`
    : `<form id="loginForm" novalidate style="display:grid;gap:14px"><div><h1>Sign in</h1><p class="sub" style="margin-top:6px">Voixa Exchange is where you and ${esc(S.firm || 'Voixa')} send documents, and every step is recorded. Enter your email and we will send you a sign-in link.</p></div>
      <div class="field"><label for="li-email">Email</label><input id="li-email" class="input" type="email" autocomplete="email" required></div>
      <p class="err" id="liErr" hidden></p><button class="btn primary" type="submit">Email me a sign-in link</button></form>`}</section>`;
  $('#li-email')?.focus();
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
            <div class="grid2">
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
      <button class="btn small" data-act="new-client">Add a client</button><nav class="rail-list" id="clList" aria-label="Clients"></nav></aside><section id="accMain" style="min-width:0"></section></div>`;
    $('#cl-search').addEventListener('input', (e) => { S.search = e.target.value; renderRail(); });
  }
}

function bindUpload() {
  const drop = $('#drop'), inp = $('#up-file');
  const show = () => { $('#dropFiles').textContent = [...inp.files].map((f) => f.name).join(', '); };
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
  $('#hello').innerHTML = `<div><h1>${esc(c.name)}</h1><p class="sub">Client #${c.no}${c.nif ? ` · NIF ${esc(c.nif)}` : ''}${c.city ? ` · ${esc(c.city)}` : ''} · Accountant: ${esc(w.firm)}</p></div>
    <span class="private"><i></i>Private workspace. Other clients of ${esc(w.firm)} cannot see it.</span>`;
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
  if (t.cur === 'sent') body = list(docs, 'You have not sent any documents yet. Use the form above to send the first one.');
  else if (t.cur === 'recv') body = list(inbound, `Reports and requests from ${esc(w.firm)} will appear here.`);
  else if (t.cur === 'bank') body = bankView();
  else if (t.cur === 'recurring') body = recurringView();
  else if (t.cur === 'people') body = peopleView();
  else body = ledgerView();
  $('#tabsArea').innerHTML = t.html + body;
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
      return `<button class="cl" data-act="client" data-id="${c.id}" aria-current="${S.route.c === c.id}"><span class="no">#${c.no}</span><span class="nm"><b>${esc(c.name)}</b><span>${c.members} ${c.members === 1 ? 'person' : 'people'}</span></span>${n ? `<span class="badge ${k.stale || k.overdue ? 'bad' : 'warn'}" title="${k.unopened} not opened, ${k.overdue} overdue">${n}</span>` : '<span></span>'}</button>`;
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
    const t = tabs('acc:all', [{ id: 'work', label: 'Work queue' }, { id: 'clients', label: 'Clients' }]);
    let body;
    if (!o.companies.length) body = `<div class="empty" style="text-align:left">No clients yet. Use <b>Add a client</b> to create a workspace and invite the people who will send documents.</div>`;
    else if (t.cur === 'work') body = `<div class="stack"><section><div class="section-h"><h3>Waiting for you</h3><span class="note" style="margin:0">Oldest first: documents to open and confirm, and reports you still owe.</span></div>${list(mine, 'Nothing is waiting for you.', { compact: true, showCompany: true })}</section>
      <section><div class="section-h"><h3>Waiting on clients</h3></div>${list(theirs, 'No reports or requests are waiting on clients.', { compact: true, showCompany: true })}</section></div>`;
    else body = `<div class="tbl-wrap"><table><thead><tr><th>No.</th><th>Client</th><th>Not opened by you</th><th>Opened, not confirmed</th><th>Reports you owe</th><th>Waiting on client</th><th>Overdue requests</th><th>Next deadline</th></tr></thead><tbody>${all.map(({ c, k }) =>
      `<tr class="click" data-act="client" data-id="${c.id}"><td class="mono">#${c.no}</td><td><b style="color:var(--ink)">${esc(c.name)}</b><br><span style="color:var(--muted)">${c.nif ? `NIF ${esc(c.nif)}` : ''}</span></td>${[k.unopened, k.unconf, k.expected, k.waiting, k.overdue].map((n) => `<td class="num ${n ? '' : 'zero'}">${n}</td>`).join('')}<td>${k.next ? `${fmtDate(k.next.due_at)}<br><span style="color:var(--muted)">${esc(k.next.title)}</span>` : '<span style="color:var(--muted)">None</span>'}</td></tr>`).join('')}</tbody></table></div>`;
    m.innerHTML = `<div class="ws-h"><div><h1>Good to see you, ${esc(first(S.me.name) || 'there')}</h1><p class="sub" style="margin-top:6px">${esc(S.firm)} · ${o.companies.length} client workspace${o.companies.length === 1 ? '' : 's'}</p></div></div>
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
  const body = t.cur === 'in' ? list(docs, 'This client has not sent any documents yet.')
    : t.cur === 'out' ? list(out, 'You have not sent this client any reports or requests yet.')
      : t.cur === 'bank' ? bankView() : t.cur === 'recurring' ? recurringView() : t.cur === 'people' ? peopleView() : ledgerView();
  m.innerHTML = `<div class="ws-h"><div><p class="eyebrow">CLIENT #${c.no}${c.nif ? ` · NIF ${esc(c.nif)}` : ''}</p><h1>${esc(c.name)}</h1><p class="sub" style="margin-top:6px">${[c.city, `${w.members.length} ${w.members.length === 1 ? 'person' : 'people'} with access`].filter(Boolean).map(esc).join(' · ')}</p></div>
    <div class="actions"><button class="btn" data-act="modal-request">Request a document</button><button class="btn primary" data-act="modal-report">Send a report</button></div></div>` + t.html + body;
}

/* ---------- recognised bank statements and invoices ---------- */
const money = (n, ccy) => (n == null ? '—' : `${Number(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${ccy || ''}`.trim());
const recFor = (itemId) => S.rec?.extractions.find((e) => e.item_id === itemId);
const invoiceFor = (itemId) => S.rec?.invoices.find((i) => i.item_id === itemId);
const matchesForTx = (txId) => (S.rec?.matches || []).filter((m) => m.transaction_id === txId);
const matchesForInvoice = (itemId) => (S.rec?.matches || []).filter((m) => m.invoice_item_id === itemId);
const METHOD = { norma43: 'Norma 43 file', camt053: 'camt.053 file', csv: 'CSV export', ai: 'AI reading' };

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
  return `<p class="note">Bank statements and invoices are read automatically when they are uploaded. Norma 43, camt.053 and CSV files are read exactly; PDFs and photos are read by AI, so check important figures against the file. Payments are matched to invoices by invoice number, amount, counterparty and date; ${S.me.role === 'accountant' ? 'you confirm each match' : 'your accountant confirms each match'}.</p>
    ${r.pending.length ? `<div class="chain"><p>Reading ${r.pending.length} file${r.pending.length > 1 ? 's' : ''}…</p></div>` : ''}
    <div class="stack" style="gap:10px">${stItems || '<div class="empty">No bank statements read yet. Upload one as “Bank statement”: Norma 43 (AEB 43), camt.053, CSV or PDF.</div>'}</div>
    <div class="section-h" style="margin-top:22px"><h3>Transactions</h3><div class="presets">
      ${[['all', `All ${r.transactions.length}`], ['none', `No invoice ${count('none')}`], ['suggested', `To confirm ${count('suggested')}`], ['confirmed', `Confirmed ${count('confirmed')}`], ['refs', 'With references']].map(([k, l]) => `<button class="chip${f === k ? ' on' : ''}" data-act="bank-filter" data-f="${k}">${l}</button>`).join('')}
    </div></div>
    <p class="sub" style="margin-bottom:10px">${invs} invoice${invs === 1 ? '' : 's'} read so far are used for matching.</p>
    ${txTable(shown)}`;
}

function recognisedSection(it) {
  if (it.kind !== 'doc' || !S.rec) return '';
  const e = recFor(it.id), pending = S.rec.pending.includes(it.id), acc = S.me.role === 'accountant';
  const rerun = acc ? `<div class="tbl-actions"><button class="btn small" data-act="recognise" data-as="statement">Read as bank statement</button><button class="btn small" data-act="recognise" data-as="invoice">Read as invoice</button></div>` : '';
  if (pending) return `<section class="receipt"><h3>Recognised data</h3><p class="sub">Reading the file…</p></section>`;
  if (!e) return acc ? `<section class="receipt"><h3>Recognised data</h3><p class="sub">This file was not read automatically because it is not marked as a bank statement or an invoice.</p>${rerun}</section>` : '';
  if (e.status !== 'done') return `<section class="receipt"><h3>Recognised data</h3><p class="late">${esc(e.error)}</p>${rerun}</section>`;
  if (e.kind === 'statement') {
    const txs = S.rec.transactions.filter((t) => t.item_id === it.id);
    return `<section style="display:grid;gap:10px"><h3>Recognised bank statement</h3><p class="sub" style="font-size:13px">${statementSummary(e)}</p>
      ${txTable(txs.slice(0, 40))}${txs.length > 40 ? `<p class="sub">Showing 40 of ${txs.length}. See all under Bank & invoices.</p>` : ''}${rerun}</section>`;
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
    <p class="sub" style="font-size:12px">Read from ${METHOD[e.method] || e.method}. Check the figures against the file.</p>
    <h3>Payments</h3>${pays || '<p class="sub">No matching payment in the uploaded bank statements yet.</p>'}${rerun}</section>`;
}

/* ---------- recurring deadlines ---------- */
const PRESETS = [
  { label: 'Bank statements, monthly by the 5th', kind: 'request', title: 'Bank statements', category: 'Bank statement', frequency: 'monthly', dueDay: 5, leadDays: 7 },
  { label: 'Sales and purchase invoices, monthly by the 5th', kind: 'request', title: 'Sales and purchase invoices', category: 'Invoice', frequency: 'monthly', dueDay: 5, leadDays: 7 },
  { label: 'VAT return (Modelo 303), quarterly by the 20th', kind: 'report', title: 'VAT return (Modelo 303)', category: 'Tax return', frequency: 'quarterly', dueDay: 20, leadDays: 10 },
  { label: 'Withholding tax (Modelo 111), quarterly by the 20th', kind: 'report', title: 'Withholding tax (Modelo 111)', category: 'Tax return', frequency: 'quarterly', dueDay: 20, leadDays: 10 },
  { label: 'Annual VAT summary (Modelo 390), 30 January', kind: 'report', title: 'Annual VAT summary (Modelo 390)', category: 'Tax return', frequency: 'yearly', dueDay: 30, dueMonth: 1, leadDays: 14 },
];

function recurringView() {
  const w = S.ws, acc = S.me.role === 'accountant';
  const rows = w.obligations.map((o) => {
    const [code, col] = CATS[o.kind === 'request' ? 'Request' : o.category] || CATS.Other;
    const upcoming = w.items.filter((i) => i.obligation_id === o.id).sort((a, b) => new Date(b.due_at) - new Date(a.due_at))[0];
    return `<div class="ob${o.active ? '' : ' stopped'}"><span class="ico ${col}" aria-hidden="true">${code}</span><span class="rm"><span class="rt">${esc(o.title)}</span><span class="rs">${esc(o.description)}. Opens ${o.lead_days} days before the deadline.${upcoming ? ` Latest: ${esc(upcoming.title)}, due ${fmtDate(upcoming.due_at)}.` : ''}${o.active ? '' : ' Stopped.'}</span></span>
      ${acc && o.active ? `<button class="btn small" data-act="stop-ob" data-id="${o.id}">Stop</button>` : `<span class="pill ${o.active ? 'ok' : 'muted'}">${o.active ? 'Active' : 'Stopped'}</span>`}</div>`;
  }).join('');
  const form = acc ? `<form class="inline-form" id="obForm" novalidate><h3>Add a recurring deadline</h3>
    <div class="presets">${PRESETS.map((p, i) => `<button type="button" class="chip" data-act="preset" data-i="${i}">${esc(p.label)}</button>`).join('')}</div>
    <div class="grid2"><div class="field"><label for="ob-kind">Who delivers</label><select id="ob-kind" class="input"><option value="request">The client uploads a document</option><option value="report">You send a report</option></select></div>
    <div class="field"><label for="ob-title">Title</label><input id="ob-title" class="input" placeholder="e.g. Bank statements"></div></div>
    <div class="grid2"><div class="field"><label for="ob-cat">Type</label><select id="ob-cat" class="input">${[...new Set([...DOC_TYPES, ...REPORT_TYPES])].map((x) => `<option>${x}</option>`).join('')}</select></div>
    <div class="field"><label for="ob-freq">How often</label><select id="ob-freq" class="input"><option value="monthly">Every month</option><option value="quarterly">Every quarter (Jan, Apr, Jul, Oct)</option><option value="yearly">Every year</option></select></div></div>
    <div class="grid2"><div class="field"><label for="ob-day">Due on day</label><input id="ob-day" class="input" type="number" min="1" max="31" value="5"></div>
    <div class="field"><label for="ob-month">Month (yearly only)</label><select id="ob-month" class="input">${MONTHS.map((x, i) => `<option value="${i + 1}">${x}</option>`).join('')}</select></div></div>
    <div class="grid2"><div class="field"><label for="ob-lead">Open it this many days before</label><input id="ob-lead" class="input" type="number" min="0" max="60" value="7"></div>
    <div class="field"><label for="ob-note">Instructions for the client (optional)</label><input id="ob-note" class="input"></div></div>
    <p class="err" id="obErr" hidden></p><div><button class="btn primary" type="submit">Add recurring deadline</button></div></form>` : '';
  return `<p class="note">Recurring deadlines create a request or an expected report automatically before each due date. Reminders go out if nothing arrives.</p>
    <div class="stack" style="gap:12px">${rows || '<div class="empty">No recurring deadlines yet.</div>'}${form}</div>`;
}

/* ---------- people ---------- */
function peopleView() {
  const w = S.ws;
  const people = w.members.map((p) => `<div class="person"><div><b>${esc(p.name || p.email)}</b><br><span class="sub">${esc(p.email)} · since ${fmtDate(p.created_at)}</span></div>
    ${p.id === S.me.id ? '<span class="pill muted">You</span>' : `<button class="btn small" data-act="remove-member" data-id="${p.id}" data-name="${esc(p.name || p.email)}">Remove access</button>`}</div>`).join('');
  return `<p class="note">Everyone listed here can send and receive documents for ${esc(w.company.name)}. They sign in with a link sent to their email. ${S.me.role === 'client' ? `Your accountants at ${esc(w.firm)} also see this workspace.` : ''}</p>
    <div class="people">${people || '<div class="empty">Nobody has access yet. Invite the first person below.</div>'}</div>
    <form class="inline-form" id="memberForm" novalidate style="margin-top:14px"><h3>Invite a person</h3>
      <div class="grid2"><div class="field"><label for="mb-name">Name</label><input id="mb-name" class="input" autocomplete="off"></div>
      <div class="field"><label for="mb-email">Email</label><input id="mb-email" class="input" type="email" autocomplete="off"></div></div>
      <p class="err" id="mbErr" hidden></p><div><button class="btn primary" type="submit">Send invitation</button></div></form>`;
}

/* ---------- activity log ---------- */
function ledgerView() {
  const w = S.ws, c = w.company;
  if (!S.verify || S.verify.id !== c.id || S.verify.count !== w.events.length) {
    S.verify = { id: c.id, count: w.events.length, pending: true };
    api(`/companies/${c.id}/verify`).then((r) => { if (S.verify?.id === c.id) { S.verify = { id: c.id, count: w.events.length, ...r, checked: r.count }; renderData(); } }).catch(() => {});
  }
  const v = S.verify;
  const bar = v.pending ? '<div class="chain"><p>Checking the log…</p></div>' : v.ok
    ? `<div class="chain ok"><div><p>Log verified on the server: ${v.checked} entries, chain unbroken</p><small>Every entry matches its SHA-256 hash and points to the entry before it.</small></div></div>`
    : `<div class="chain bad"><div><p>Log check failed</p><small>${esc(v.reason)}. Contact ${esc(w.firm)}.</small></div></div>`;
  const evs = w.events.slice().reverse();
  const refs = Object.fromEntries(w.items.map((i) => [i.id, i.ref]));
  return `<div class="section-h"><p class="note" style="margin:0">Every action is written to an append-only log. Each entry carries the hash of the entry before it, so editing or deleting any past entry breaks the chain.</p>
    <div class="tbl-actions"><a class="btn small" href="/api/companies/${c.id}/export.csv">Download CSV</a><a class="btn small" href="/api/companies/${c.id}/report" target="_blank" rel="noopener">Printable report</a></div></div>${bar}
    <div class="tbl-wrap"><table><thead><tr><th>#</th><th>Time (Madrid)</th><th>Who</th><th>What happened</th><th>Ref</th><th>Entry hash</th></tr></thead><tbody>${evs.map((e) =>
      `<tr${e.item_id ? ` class="click" data-act="item" data-c="${c.id}" data-id="${e.item_id}"` : ''}><td class="mono">${e.seq}</td><td class="mono num" style="white-space:nowrap">${fmt(e.at)}</td><td><span class="actor ${e.actor_type}">${e.actor_type}</span></td><td style="color:var(--ink);min-width:260px">${esc(e.text)}</td><td class="mono" style="white-space:nowrap">${refs[e.item_id] || ''}</td><td class="mono" style="color:var(--muted)">${e.hash.slice(0, 12)}…</td></tr>`).join('')}</tbody></table></div>`;
}

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
    ${it.versions.length ? `<section style="display:grid;gap:10px"><h3>Files</h3><ul class="versions">${it.versions.slice().reverse().map((v) => `<li class="${v === cur ? 'cur' : ''}"><div><b style="color:var(--ink)">v${v.version} · ${esc(v.file_name)}</b> · ${fmtSize(v.size)} ${v === cur ? '<span class="pill info" style="margin-left:6px">Current</span>' : ''}</div>
      <div class="sub">Uploaded ${fmt(v.uploaded_at)}${v.uploaded_by ? ` by ${esc(v.uploaded_by)}` : ''}${v.replace_reason ? `. Reason for replacing: ${esc(v.replace_reason)}` : ''}</div>
      <div class="mono">SHA-256 ${v.sha256}</div>${v !== cur ? `<div><a href="/api/items/${it.id}/file?v=${v.version}" target="_blank" rel="noopener" style="color:var(--blue)" data-act="opened-file">Open version ${v.version}</a></div>` : ''}</li>`).join('')}</ul></section>` : ''}
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
function clientModal() {
  openModal(`${modalHead('Add a client')}
  <form class="modal-b" id="coForm" novalidate>
    <div class="field"><label for="co-name">Company name</label><input id="co-name" class="input" placeholder="e.g. Sol y Mar Hospitality SL"></div>
    <div class="grid2"><div class="field"><label for="co-nif">NIF</label><input id="co-nif" class="input" placeholder="B12345678"></div><div class="field"><label for="co-city">City</label><input id="co-city" class="input"></div></div>
    <h3 style="margin-top:6px">First person to invite (optional)</h3>
    <div class="grid2"><div class="field"><label for="co-cname">Name</label><input id="co-cname" class="input"></div><div class="field"><label for="co-cemail">Email</label><input id="co-cemail" class="input" type="email"></div></div>
    <p class="err" id="coErr" hidden></p>
    <div class="dr-actions"><button class="btn primary" type="submit">Create workspace</button><button class="btn" type="button" data-act="close-modal">Cancel</button></div></form>`);
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
      const files = [...$('#up-file').files];
      if (!files.length) return showErr('#upErr', 'Choose at least one file to send.');
      showErr('#upErr', '');
      const form = new FormData();
      form.append('category', $('#up-cat').value); form.append('period', $('#up-period').value);
      form.append('requestId', $('#up-req').value); form.append('note', $('#up-note').value.trim());
      files.forEach((x) => form.append('files', x, x.name));
      const done = busy($('#upBtn'), 'Sending…');
      try {
        const r = await upload(`/companies/${S.route.c}/documents`, form, pct('#upProg', 'Uploading'));
        f.reset(); $('#up-period').value = thisMonth(); $('#dropFiles').textContent = '';
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
      const r = await api('/companies', { method: 'POST', body: { name, nif: $('#co-nif').value.trim(), city: $('#co-city').value.trim(), contactName: $('#co-cname').value.trim(), contactEmail: $('#co-cemail').value.trim() } })
        .catch((err) => { showErr('#coErr', err.message); return null; });
      if (r) { closeModal(); toast('Workspace created.'); go(r.id); }
    }
    if (f.id === 'memberForm') {
      const email = $('#mb-email').value.trim();
      if (!email) return showErr('#mbErr', 'Enter their email address.');
      await api(`/companies/${S.route.c}/members`, { method: 'POST', body: { email, name: $('#mb-name').value.trim() } });
      toast(`Invitation sent to ${email}.`); await refresh();
    }
    if (f.id === 'obForm') {
      const body = { kind: $('#ob-kind').value, title: $('#ob-title').value.trim(), category: $('#ob-cat').value, frequency: $('#ob-freq').value,
        dueDay: Number($('#ob-day').value), dueMonth: Number($('#ob-month').value), leadDays: Number($('#ob-lead').value), note: $('#ob-note').value.trim() };
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
    case 'item': go(b.dataset.c, b.dataset.id); break;
    case 'client': go(b.dataset.id || null); break;
    case 'tab': S.tab[b.dataset.key] = b.dataset.tab; renderData(); break;
    case 'close-drawer': go(S.route.c); break;
    case 'close-modal': closeModal(); break;
    case 'logout': await api('/auth/logout', { method: 'POST', body: {} }).catch(() => {}); location.hash = ''; location.reload(); break;
    case 'login-again': renderLogin(); break;
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
    case 'preset': {
      const p = PRESETS[+b.dataset.i];
      $('#ob-kind').value = p.kind; $('#ob-title').value = p.title; $('#ob-cat').value = p.category; $('#ob-freq').value = p.frequency;
      $('#ob-day').value = p.dueDay; $('#ob-lead').value = p.leadDays; if (p.dueMonth) $('#ob-month').value = p.dueMonth; break;
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
window.addEventListener('focus', () => S.me && refresh());
setInterval(() => { if (S.me && document.visibilityState === 'visible' && $('#modal').hidden) refresh(); }, 30000);

/* ---------- start ---------- */
(async () => {
  try {
    const me = await api('/me');
    S.me = me.user; S.firm = me.firm; S.companies = me.companies;
    renderShell();
    await route();
  } catch (err) {
    if (err.status === 401) renderLogin(); else $('#view').innerHTML = `<p class="loading">${esc(err.message)}</p>`;
  }
})();
