// Server-rendered page for the sign-in link (the rest of the UI is public/app.js).
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function authPage({ token, expired }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in · Pescada</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="/app.css"></head>
<body class="auth"><main class="auth-card card pad">
<div class="logo auth-logo"><svg viewBox="0 0 64 40" width="40" height="25" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M6 20c7-10 19-13 31-9 5 2 9 5 11 9-2 4-6 7-11 9-12 4-24 1-31-9z" stroke="currentColor" stroke-width="4"/><path d="M48 20l6-7m-6 7l6 7" stroke="currentColor" stroke-width="4"/><path d="M17 20l5 5 10-11" stroke="#E0A82E" stroke-width="4"/></svg><span class="word">pescada</span></div>
${expired
    ? `<h1>This link no longer works</h1><p class="sub">Sign-in links work once and expire after a short time. Request a new one.</p><a class="btn primary" href="/">Request a new link</a>`
    : `<h1>Sign in to Pescada</h1><p class="sub">Continue to your workspace.</p>
<form method="post" action="/auth/verify"><input type="hidden" name="token" value="${esc(token)}"><button class="btn primary" type="submit">Sign in</button></form>`}
</main></body></html>`;
}
