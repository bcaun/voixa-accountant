// Server-rendered page for the sign-in link (the rest of the UI is public/app.js).
// Language follows the browser (Accept-Language), falling back to English.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const TEXT = {
  en: { title: 'Sign in', expired: 'This link no longer works', expiredSub: 'Sign-in links work once and expire after a short time. Request a new one.', again: 'Request a new link', heading: 'Sign in to Pescada', sub: 'Continue to your workspace.', button: 'Sign in' },
  es: { title: 'Entrar', expired: 'Este enlace ya no funciona', expiredSub: 'Los enlaces de acceso funcionan una vez y caducan al poco tiempo. Pide uno nuevo.', again: 'Pedir un enlace nuevo', heading: 'Entrar en Pescada', sub: 'Continúa a tu espacio.', button: 'Entrar' },
  it: { title: 'Accedi', expired: 'Questo link non funziona più', expiredSub: 'I link di accesso funzionano una sola volta e scadono dopo poco. Richiedine uno nuovo.', again: 'Richiedi un nuovo link', heading: 'Accedi a Pescada', sub: 'Continua nel tuo spazio.', button: 'Accedi' },
  fr: { title: 'Connexion', expired: 'Ce lien ne fonctionne plus', expiredSub: 'Les liens de connexion fonctionnent une seule fois et expirent rapidement. Demandez-en un nouveau.', again: 'Demander un nouveau lien', heading: 'Connexion à Pescada', sub: 'Accédez à votre espace.', button: 'Se connecter' },
  de: { title: 'Anmelden', expired: 'Dieser Link funktioniert nicht mehr', expiredSub: 'Anmeldelinks funktionieren einmal und laufen nach kurzer Zeit ab. Fordern Sie einen neuen an.', again: 'Neuen Link anfordern', heading: 'Bei Pescada anmelden', sub: 'Weiter zu Ihrem Arbeitsbereich.', button: 'Anmelden' },
  pt: { title: 'Entrar', expired: 'Esta ligação já não funciona', expiredSub: 'As ligações de entrada funcionam uma vez e expiram pouco depois. Peça uma nova.', again: 'Pedir uma nova ligação', heading: 'Entrar no Pescada', sub: 'Continue para o seu espaço.', button: 'Entrar' },
};
export const PAGE_LANGS = Object.keys(TEXT);

export function authPage({ token, expired, lang = 'en' }) {
  const t = TEXT[lang] || TEXT.en;
  return `<!doctype html><html lang="${TEXT[lang] ? lang : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${t.title} · Pescada</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="/fonts.css"><link rel="stylesheet" href="/app.css"></head>
<body class="auth"><main class="auth-card card pad">
<div class="logo auth-logo"><svg viewBox="0 0 64 64" width="38" height="38" aria-hidden="true" focusable="false"><g transform="rotate(-12 32 32)"><path d="M46 32C36 22 26 16 16 13c4 8 9 15 16 19-7 4-12 11-16 19 10-3 20-9 30-19Z" fill="currentColor" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"/></g><circle cx="51" cy="15" r="4.4" fill="#F5B730"/></svg><span class="word">pescada</span></div>
${expired
    ? `<h1>${t.expired}</h1><p class="sub">${t.expiredSub}</p><a class="btn primary" href="/">${t.again}</a>`
    : `<h1>${t.heading}</h1><p class="sub">${t.sub}</p>
<form method="post" action="/auth/verify"><input type="hidden" name="token" value="${esc(token)}"><button class="btn primary" type="submit">${t.button}</button></form>`}
</main></body></html>`;
}
