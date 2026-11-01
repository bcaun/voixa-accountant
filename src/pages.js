// Server-rendered page for the sign-in link (the rest of the UI is public/app.js).
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function authPage({ token, expired }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in · Pescada</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="/fonts.css"><link rel="stylesheet" href="/app.css"></head>
<body class="auth"><main class="auth-card card pad">
<div class="logo auth-logo"><svg viewBox="0 0 64 64" width="38" height="38" aria-hidden="true" focusable="false"><g transform="rotate(-12 32 32)"><path d="M46 32C36 22 26 16 16 13c4 8 9 15 16 19-7 4-12 11-16 19 10-3 20-9 30-19Z" fill="currentColor" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"/></g><circle cx="51" cy="15" r="4.4" fill="#F5B730"/></svg><span class="word">pescada</span></div>
${expired
    ? `<h1>This link no longer works</h1><p class="sub">Sign-in links work once and expire after a short time. Request a new one.</p><a class="btn primary" href="/">Request a new link</a>`
    : `<h1>Sign in to Pescada</h1><p class="sub">Continue to your workspace.</p>
<form method="post" action="/auth/verify"><input type="hidden" name="token" value="${esc(token)}"><button class="btn primary" type="submit">Sign in</button></form>`}
</main></body></html>`;
}
