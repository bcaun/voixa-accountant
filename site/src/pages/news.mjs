// News and press releases. Each post is one file in src/news/ exporting `post`:
// { date: 'YYYY-MM-DD', tag: {en, es}, slug: {en, es}, title: {en, es}, summary: {en, es}, body: {en, es} }.
// To publish: add a file, run `node site/build.mjs`, commit, and deploy.
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { company } from '../company.mjs';

const SITE = 'https://pescada.io';
const dir = fileURLToPath(new URL('../news/', import.meta.url));
const posts = [];
for (const f of (await readdir(dir)).filter((f) => f.endsWith('.mjs'))) posts.push((await import(path.join(dir, f))).post);
posts.sort((a, b) => b.date.localeCompare(a.date));

const T = {
  en: { base: '/news/', title: 'News', lead: 'What is new in Pescada: new countries, new features and announcements for accounting firms.',
    description: 'News and press releases about Pescada, tracked document exchange for accounting firms.', read: 'Read more', back: 'All news',
    press: 'Press contact', rss: 'Subscribe (RSS)', feed: '/news/feed.xml', locale: 'en-GB' },
  es: { base: '/es/noticias/', title: 'Noticias', lead: 'Novedades de Pescada: nuevos países, nuevas funciones y anuncios para asesorías y despachos.',
    description: 'Noticias y notas de prensa sobre Pescada, intercambio de documentos con trazabilidad para asesorías.', read: 'Leer más', back: 'Todas las noticias',
    press: 'Contacto de prensa', rss: 'Suscribirse (RSS)', feed: '/es/noticias/feed.xml', locale: 'es-ES' },
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const day = (d, lang) => new Date(`${d}T12:00:00Z`).toLocaleDateString(T[lang].locale, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const url = (p, lang) => `${T[lang].base}${p.slug[lang]}/`;
const feedLink = (lang) => `\n<link rel="alternate" type="application/rss+xml" title="${esc(`${company.product} — ${T[lang].title}`)}" href="${T[lang].feed}">`;

function index(lang) {
  const t = T[lang];
  const cards = posts.map((p) => `<article class="news-card">
      <p class="news-meta"><time datetime="${p.date}">${day(p.date, lang)}</time>${p.tag ? ` · ${esc(p.tag[lang])}` : ''}</p>
      <h2><a href="${url(p, lang)}">${esc(p.title[lang])}</a></h2>
      <p>${esc(p.summary[lang])}</p>
      <a class="link-arrow" href="${url(p, lang)}">${t.read} →</a>
    </article>`).join('');
  return `<section class="section news"><div class="wrap">
  <div class="section-head"><h1>${t.title}</h1><p class="lead">${t.lead}</p>
    <p class="fine"><a href="${t.feed}">${t.rss}</a> · ${t.press}: <a href="mailto:${company.contactEmail}">${company.contactEmail}</a></p></div>
  <div class="news-list">${cards}</div>
</div></section>`;
}

function article(p, lang) {
  const t = T[lang];
  return `<section class="section news"><div class="wrap">
  <article class="news-article">
    <p class="news-meta"><a href="${t.base}">← ${t.back}</a> · <time datetime="${p.date}">${day(p.date, lang)}</time>${p.tag ? ` · ${esc(p.tag[lang])}` : ''}</p>
    <h1>${esc(p.title[lang])}</h1>
    <p class="lead">${esc(p.summary[lang])}</p>
    <div class="prose">${p.body[lang]}</div>
    <p class="news-press">${t.press}: <a href="mailto:${company.contactEmail}">${company.contactEmail}</a> · ${esc(company.product)}, ${esc(company.legalName)}, ${esc(company.address)}</p>
  </article>
</div></section>`;
}

function rss(lang) {
  const t = T[lang];
  const items = posts.map((p) => `    <item>
      <title>${esc(p.title[lang])}</title>
      <link>${SITE}${url(p, lang)}</link>
      <guid isPermaLink="true">${SITE}${url(p, lang)}</guid>
      <pubDate>${new Date(`${p.date}T09:00:00Z`).toUTCString()}</pubDate>
      <description>${esc(p.summary[lang])}</description>
    </item>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${esc(`${company.product} — ${t.title}`)}</title>
    <link>${SITE}${t.base}</link>
    <atom:link href="${SITE}${t.feed}" rel="self" type="application/rss+xml"/>
    <description>${esc(t.description)}</description>
    <language>${lang}</language>
${items}
  </channel>
</rss>
`;
}

export const pages = [
  ...['en', 'es'].map((lang) => ({ key: 'news', lang, path: T[lang].base, title: T[lang].title, description: T[lang].description, body: index(lang), head: feedLink(lang) })),
  ...posts.flatMap((p) => ['en', 'es'].map((lang) => ({
    key: `news:${p.slug.en}`, lang, path: url(p, lang), title: p.title[lang], description: p.summary[lang], body: article(p, lang),
    type: 'article', head: `${feedLink(lang)}\n<meta property="article:published_time" content="${p.date}">`,
  }))),
];

export const files = ['en', 'es'].map((lang) => ({ path: T[lang].feed.slice(1), content: rss(lang) }));
