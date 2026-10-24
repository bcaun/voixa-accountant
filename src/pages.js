// Server-rendered page for the sign-in link (the rest of the UI is public/app.js).
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function authPage({ token, expired }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in · Voixa Exchange</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="/app.css"></head>
<body class="auth"><main class="auth-card card pad">
<img src="/logo.svg" alt="Voixa" class="auth-logo" width="150" height="25">
${expired
    ? `<h1>This link no longer works</h1><p class="sub">Sign-in links work once and expire after a short time. Request a new one.</p><a class="btn primary" href="/">Request a new link</a>`
    : `<h1>Sign in to Voixa Exchange</h1><p class="sub">Continue to your workspace.</p>
<form method="post" action="/auth/verify"><input type="hidden" name="token" value="${esc(token)}"><button class="btn primary" type="submit">Sign in</button></form>`}
</main></body></html>`;
}
