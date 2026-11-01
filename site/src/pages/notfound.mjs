// The 404 page (Caddy serves it for any path that does not exist).
export const pages = [{
  key: '404', lang: 'en', path: '/404/', title: 'Page not found', description: 'This page does not exist.', noindex: true,
  body: `<section class="section"><div class="wrap" style="max-width:760px"><div class="section-head">
    <p class="mono">404</p><h1>This page slipped away.</h1>
    <p class="lead">The address may be mistyped, or the page has moved. / La dirección no existe. / La pagina non esiste. / Cette page n’existe pas. / Diese Seite gibt es nicht. / Esta página não existe.</p>
    <p class="cta"><a class="btn primary" href="/">Pescada home</a><a class="btn outline" href="/news/">News</a></p></div></div></section>`,
}];
