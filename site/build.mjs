// Builds the static site into site/public. Run: node site/build.mjs
// Pages live in src/pages/*.mjs; each exports an array of { key, lang, path, title, description, body, legal }.
import { readdir, readFile, mkdir, writeFile, copyFile, cp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { company, demoHref } from './src/company.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, 'public');
const SITE = 'https://pescada.io';

const UI = {
  en: {
    product: 'Product', security: 'Security', legal: 'Legal', signin: 'Client sign in', demo: 'Request a demo',
    other: 'ES', otherLabel: 'Español', legalNav: 'Legal', draft: `Draft version ${company.legalVersion}, pending review by our lawyers. The final text may change.`,
    updated: 'Last updated', operated: 'Operated by', singleMember: 'single-member company', footer: 'Tracked document exchange for accounting firms.',
  },
  es: {
    product: 'Producto', security: 'Seguridad', legal: 'Legal', signin: 'Acceso clientes', demo: 'Solicitar una demo',
    other: 'EN', otherLabel: 'English', legalNav: 'Legal', draft: `Versión borrador ${company.legalVersion}, pendiente de revisión por nuestros abogados. El texto final puede cambiar.`,
    updated: 'Última actualización', operated: 'Un servicio de', singleMember: 'sociedad unipersonal', footer: 'Intercambio de documentos con trazabilidad para asesorías y despachos contables.',
  },
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function layout(page, all) {
  const t = UI[page.lang];
  const alt = all.find((p) => p.key === page.key && p.lang !== page.lang);
  const home = all.find((p) => p.key === 'home' && p.lang === page.lang).path;
  const legalPages = all.filter((p) => ORDER.includes(p.key) && p.lang === page.lang).sort((a, b) => ORDER.indexOf(a.key) - ORDER.indexOf(b.key));
  const nav = `<nav class="nav" aria-label="Main">
      <a class="hide-s" href="${home}#product">${t.product}</a>
      <a class="hide-s" href="${all.find((p) => p.key === 'security' && p.lang === page.lang).path}">${t.security}</a>
      <a class="hide-s" href="${legalPages[0].path}">${t.legal}</a>
      <a class="lang" href="${alt.path}" hreflang="${alt.lang}" lang="${alt.lang}" title="${t.otherLabel}">${t.other}</a>
    </nav>
    <div class="actions"><a class="btn quiet small" href="${company.appUrl}">${t.signin}</a><a class="btn primary small" href="${demoHref(page.lang)}">${t.demo}</a></div>`;
  const legalBody = ORDER.includes(page.key) ? `<main class="legal"><div class="wrap">
      <aside aria-label="${t.legalNav}">${legalPages.map((p) => `<a href="${p.path}"${p.key === page.key ? ' aria-current="page"' : ''}>${esc(p.navTitle || p.title)}</a>`).join('')}</aside>
      <article>
        <h1>${esc(page.title)}</h1>
        <p class="meta">${t.updated}: ${company.legalDate} · v${company.legalVersion}</p>
        ${company.legalStatus === 'draft' ? `<p class="draft">${t.draft}</p>` : ''}
        ${page.body}
      </article></div></main>` : `<main>${page.body}</main>`;
  return `<!doctype html>
<html lang="${page.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(page.key === 'home' ? `${company.product} — ${page.title}` : `${page.title} · ${company.product}`)}</title>
<meta name="description" content="${esc(page.description)}">
<link rel="canonical" href="${SITE}${page.path}">
<link rel="alternate" hreflang="${page.lang}" href="${SITE}${page.path}">
<link rel="alternate" hreflang="${alt.lang}" href="${SITE}${alt.path}">
<link rel="alternate" hreflang="x-default" href="${SITE}${all.find((p) => p.key === page.key && p.lang === 'en').path}">
<meta property="og:title" content="${esc(page.title)}">
<meta property="og:description" content="${esc(page.description)}">
<meta property="og:url" content="${SITE}${page.path}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/styles.css">
</head>
<body>
<header class="top"><div class="wrap">
  <a class="brand" href="${home}" aria-label="${company.product}">${LOGO}<span aria-hidden="true">pescada</span></a>
  ${nav}
</div></header>
${legalBody}
<footer><div class="wrap">
  <a class="brand" href="${home}" aria-label="${company.product}">${LOGO}<span aria-hidden="true">pescada</span></a>
  <div class="who">${t.footer}<br>${t.operated} ${esc(company.legalName)}${company.singleMember ? ` (${t.singleMember})` : ''} · ${esc(company.taxId)} · ${esc(company.address)} · <a href="mailto:${company.contactEmail}">${company.contactEmail}</a><small>${esc(company.registry[page.lang])}</small></div>
  <nav aria-label="${t.legalNav}">${legalPages.map((p) => `<a href="${p.path}">${esc(p.navTitle || p.title)}</a>`).join('')}<a href="${alt.path}" hreflang="${alt.lang}" lang="${alt.lang}">${t.otherLabel}</a></nav>
</div></footer>
</body>
</html>
`;
}

const LOGO = (await readFile(path.join(here, 'src/logo.svg'), 'utf8')).trim().replace('<svg ', '<svg aria-hidden="true" focusable="false" ');
// order of the legal pages in menus
const ORDER = ['legal-notice', 'privacy', 'terms', 'dpa', 'subprocessors', 'security'];
const all = [];
for (const f of (await readdir(path.join(here, 'src/pages'))).filter((f) => f.endsWith('.mjs')).sort()) {
  const mod = await import(path.join(here, 'src/pages', f));
  all.push(...mod.pages);
}
// every page needs its counterpart in the other language
for (const p of all) if (!all.some((q) => q.key === p.key && q.lang !== p.lang)) throw new Error(`${p.path} has no translation`);

await rm(out, { recursive: true, force: true });
for (const page of all) {
  const dir = path.join(out, page.path);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'index.html'), layout(page, all));
}
// fonts.css is inlined into the site stylesheet, and shared with the app (public/) so both use the same files
const fontsCss = await readFile(path.join(here, 'src/fonts.css'), 'utf8');
await writeFile(path.join(out, 'styles.css'), fontsCss + '\n' + (await readFile(path.join(here, 'src/styles.css'), 'utf8')).replace('@import url(/fonts.css);\n', ''));
const app = path.join(here, '../public');
await writeFile(path.join(app, 'fonts.css'), fontsCss);
await rm(path.join(app, 'fonts'), { recursive: true, force: true });
await cp(path.join(here, 'src/fonts'), path.join(app, 'fonts'), { recursive: true });
await copyFile(path.join(here, 'src/favicon.svg'), path.join(out, 'favicon.svg'));
await cp(path.join(here, 'src/fonts'), path.join(out, 'fonts'), { recursive: true });
await writeFile(path.join(out, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${SITE}/sitemap.xml\n`);
await writeFile(path.join(out, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${all.map((p) => `  <url><loc>${SITE}${p.path}</loc></url>`).join('\n')}\n</urlset>\n`);
console.log(`built ${all.length} pages into ${path.relative(process.cwd(), out) || out}`);
