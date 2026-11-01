// Builds the static site into site/public. Run: node site/build.mjs
// Pages live in src/pages/*.mjs; each exports an array of { key, lang, path, title, description, body, head?, type? }
// and may export `files` ([{ path, content }]) for extra outputs such as RSS feeds. News posts live in src/news/.
import { readdir, readFile, mkdir, writeFile, copyFile, cp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { company } from './src/company.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, 'public');
const SITE = 'https://pescada.io';

export const LANGS = ['en', 'es', 'it', 'fr', 'de', 'pt'];
const LANG_NAMES = { en: 'English', es: 'Español', it: 'Italiano', fr: 'Français', de: 'Deutsch', pt: 'Português' };
const UI = {
  en: { product: 'Product', security: 'Security', legal: 'Legal', news: 'News', signin: 'Client sign in', demo: 'Request a demo', language: 'Language',
    legalNav: 'Legal', draft: `Draft version ${company.legalVersion}, pending review by our lawyers. The final text may change.`,
    updated: 'Last updated', operated: 'Operated by', singleMember: 'single-member company', footer: 'Tracked document exchange for accounting firms.' },
  es: { product: 'Producto', security: 'Seguridad', legal: 'Legal', news: 'Noticias', signin: 'Acceso clientes', demo: 'Solicitar una demo', language: 'Idioma',
    legalNav: 'Legal', draft: `Versión borrador ${company.legalVersion}, pendiente de revisión por nuestros abogados. El texto final puede cambiar.`,
    updated: 'Última actualización', operated: 'Un servicio de', singleMember: 'sociedad unipersonal', footer: 'Intercambio de documentos con trazabilidad para asesorías y despachos contables.' },
  it: { product: 'Prodotto', security: 'Sicurezza', legal: 'Legale', news: 'Notizie', signin: 'Accesso clienti', demo: 'Richiedi una demo', language: 'Lingua',
    legalNav: 'Legale', updated: 'Ultimo aggiornamento', operated: 'Un servizio di', singleMember: 'società unipersonale', footer: 'Scambio di documenti tracciato per studi contabili.' },
  fr: { product: 'Produit', security: 'Sécurité', legal: 'Juridique', news: 'Actualités', signin: 'Espace clients', demo: 'Demander une démo', language: 'Langue',
    legalNav: 'Juridique', updated: 'Dernière mise à jour', operated: 'Un service de', singleMember: 'société unipersonnelle', footer: 'Échange de documents tracé pour les cabinets comptables.' },
  de: { product: 'Produkt', security: 'Sicherheit', legal: 'Rechtliches', news: 'Neuigkeiten', signin: 'Mandanten-Login', demo: 'Demo anfragen', language: 'Sprache',
    legalNav: 'Rechtliches', updated: 'Zuletzt aktualisiert', operated: 'Ein Angebot der', singleMember: 'Einpersonengesellschaft', footer: 'Nachverfolgbarer Dokumentenaustausch für Steuerkanzleien.' },
  pt: { product: 'Produto', security: 'Segurança', legal: 'Legal', news: 'Notícias', signin: 'Acesso clientes', demo: 'Pedir uma demo', language: 'Idioma',
    legalNav: 'Legal', updated: 'Última atualização', operated: 'Um serviço de', singleMember: 'sociedade unipessoal', footer: 'Troca de documentos com rastreabilidade para gabinetes de contabilidade.' },
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
/** The page with this key in this language, or the English one when it has not been translated. */
const pageIn = (all, key, lang) => all.find((p) => p.key === key && p.lang === lang) || all.find((p) => p.key === key && p.lang === 'en');

function layout(page, all) {
  const t = UI[page.lang];
  const lang = page.lang;
  const versions = LANGS.map((l) => all.find((p) => p.key === page.key && p.lang === l)).filter(Boolean);
  const home = pageIn(all, 'home', lang).path;
  const newsHome = pageIn(all, 'news', lang).path;
  const legalLang = all.some((p) => ORDER.includes(p.key) && p.lang === lang) ? lang : 'en';
  const legalPages = all.filter((p) => ORDER.includes(p.key) && p.lang === legalLang).sort((a, b) => ORDER.indexOf(a.key) - ORDER.indexOf(b.key));
  const langLinks = LANGS.map((l) => {
    const target = all.find((p) => p.key === page.key && p.lang === l) || pageIn(all, 'home', l);
    return `<a href="${target.path}" hreflang="${l}" lang="${l}"${l === lang ? ' aria-current="true"' : ''}>${LANG_NAMES[l]}</a>`;
  }).join('');
  const nav = `<nav class="nav" aria-label="Main">
      <a class="hide-s" href="${home}#product">${t.product}</a>
      <a class="hide-s" href="${pageIn(all, 'security', lang).path}">${t.security}</a>
      <a class="hide-s" href="${newsHome}">${t.news}</a>
      <a class="hide-s" href="${legalPages[0].path}">${t.legal}</a>
      <details class="langs"><summary aria-label="${t.language}">${lang.toUpperCase()}</summary><div>${langLinks}</div></details>
    </nav>
    <div class="actions"><a class="btn quiet small" href="${company.appUrl}">${t.signin}</a><a class="btn primary small" href="${home}#demo">${t.demo}</a></div>`;
  const legalBody = ORDER.includes(page.key) ? `<main class="legal"><div class="wrap">
      <aside aria-label="${t.legalNav}">${legalPages.map((p) => `<a href="${p.path}"${p.key === page.key ? ' aria-current="page"' : ''}>${esc(p.navTitle || p.title)}</a>`).join('')}</aside>
      <article>
        <h1>${esc(page.title)}</h1>
        <p class="meta">${t.updated}: ${company.legalDate} · v${company.legalVersion}</p>
        ${company.legalStatus === 'draft' ? `<p class="draft">${t.draft}</p>` : ''}
        ${page.body}
      </article></div></main>` : `<main>${page.body}</main>`;
  const en = pageIn(all, page.key, 'en');
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(page.key === 'home' ? `${company.product} — ${page.title}` : `${page.title} · ${company.product}`)}</title>
<meta name="description" content="${esc(page.description)}">
${page.noindex ? '<meta name="robots" content="noindex">' : `<link rel="canonical" href="${SITE}${page.path}">
${versions.map((v) => `<link rel="alternate" hreflang="${v.lang}" href="${SITE}${v.path}">`).join('\n')}
<link rel="alternate" hreflang="x-default" href="${SITE}${en.path}">`}
<meta property="og:title" content="${esc(page.title)}">
<meta property="og:description" content="${esc(page.description)}">
<meta property="og:url" content="${SITE}${page.path}">
<meta property="og:image" content="${SITE}/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta property="og:locale" content="${{ en: 'en_GB', es: 'es_ES', it: 'it_IT', fr: 'fr_FR', de: 'de_DE', pt: 'pt_PT' }[lang]}">
<meta property="og:type" content="${page.type || 'website'}">
<meta property="og:site_name" content="${company.product}">${page.head || ''}
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/styles.css?v=${CSS_VERSION}">${company.analyticsToken ? `
<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token": "${esc(company.analyticsToken)}"}'></script>` : ''}
</head>
<body>
<header class="top"><div class="wrap">
  <a class="brand" href="${home}" aria-label="${company.product}">${LOGO}<span aria-hidden="true">pescada</span></a>
  ${nav}
</div></header>
${legalBody}
<footer><div class="wrap">
  <a class="brand" href="${home}" aria-label="${company.product}">${LOGO}<span aria-hidden="true">pescada</span></a>
  <div class="who">${t.footer}<br>${t.operated} ${esc(company.legalName)}${company.singleMember ? ` (${t.singleMember})` : ''} · ${esc(company.taxId)} · ${esc(company.address)} · <a href="mailto:${company.contactEmail}">${company.contactEmail}</a><small>${esc(company.registry[lang] || company.registry.en)}</small></div>
  <nav aria-label="${t.legalNav}"><a href="${newsHome}">${t.news}</a>${legalPages.map((p) => `<a href="${p.path}">${esc(p.navTitle || p.title)}</a>`).join('')}</nav>
  <nav class="foot-langs" aria-label="${t.language}">${langLinks}</nav>
</div></footer>
</body>
</html>
`;
}

// the stylesheet is built first so pages can link it with a content hash: browsers then never use a stale copy
const fontsCss = await readFile(path.join(here, 'src/fonts.css'), 'utf8');
const CSS = fontsCss + '\n' + (await readFile(path.join(here, 'src/styles.css'), 'utf8')).replace('@import url(/fonts.css);\n', '');
const CSS_VERSION = createHash('sha256').update(CSS).digest('hex').slice(0, 10);
const LOGO = (await readFile(path.join(here, 'src/logo.svg'), 'utf8')).trim().replace('<svg ', '<svg aria-hidden="true" focusable="false" ');
// order of the legal pages in menus
const ORDER = ['legal-notice', 'privacy', 'terms', 'dpa', 'subprocessors', 'security'];
const all = [];
const files = [];
for (const f of (await readdir(path.join(here, 'src/pages'))).filter((f) => f.endsWith('.mjs')).sort()) {
  const mod = await import(path.join(here, 'src/pages', f));
  all.push(...mod.pages);
  files.push(...(mod.files || []));
}
// every page needs its counterpart in the other language
for (const p of all) if (!all.some((q) => q.key === p.key && q.lang === 'en')) throw new Error(`${p.path} has no English version`);

await rm(out, { recursive: true, force: true });
for (const page of all) {
  const dir = path.join(out, page.path);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'index.html'), layout(page, all));
}
// fonts.css is inlined into the site stylesheet, and shared with the app (public/) so both use the same files
await writeFile(path.join(out, 'styles.css'), CSS);
const app = path.join(here, '../public');
await writeFile(path.join(app, 'fonts.css'), fontsCss);
await rm(path.join(app, 'fonts'), { recursive: true, force: true });
await cp(path.join(here, 'src/fonts'), path.join(app, 'fonts'), { recursive: true });
await copyFile(path.join(here, 'src/favicon.svg'), path.join(out, 'favicon.svg'));
await cp(path.join(here, 'src/fonts'), path.join(out, 'fonts'), { recursive: true });
for (const f of files) {
  await mkdir(path.dirname(path.join(out, f.path)), { recursive: true });
  await writeFile(path.join(out, f.path), f.content);
}
await writeFile(path.join(out, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${SITE}/sitemap.xml\n`);
await writeFile(path.join(out, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${all.filter((p) => !p.noindex).map((p) => `  <url><loc>${SITE}${p.path}</loc></url>`).join('\n')}\n</urlset>\n`);
await copyFile(path.join(out, '404', 'index.html'), path.join(out, '404.html'));
await copyFile(path.join(here, 'src/og.png'), path.join(out, 'og.png')).catch(() => console.warn('site/src/og.png is missing: run node site/og.mjs'));
console.log(`built ${all.length} pages into ${path.relative(process.cwd(), out) || out}`);
