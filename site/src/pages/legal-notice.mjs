import { company as c } from '../company.mjs';

const rows = (list) => `<div class="table"><table><tbody>${list.map(([k, v]) => `<tr><th scope="row">${k}</th><td>${v}</td></tr>`).join('')}</tbody></table></div>`;
const mail = (e) => `<a href="mailto:${e}">${e}</a>`;

export const pages = [
  {
    key: 'legal-notice', lang: 'en', path: '/legal-notice/', navTitle: 'Legal notice',
    title: 'Legal notice',
    description: 'Who provides Pescada: company details under article 10 of the Spanish Information Society Services Act (LSSI-CE).',
    body: `
<p>The website pescada.io and the Pescada portal at app.pescada.io are provided by the company below, as required by article 10 of Spanish Law 34/2002 on Information Society Services and Electronic Commerce (LSSI-CE).</p>
${rows([
  ['Owner', `${c.legalName}${c.singleMember ? ' (single-member company)' : ''}`],
  ['Tax ID (NIF)', c.taxId],
  ['Registered address', `${c.address}, Spain`],
  ['Commercial Registry', c.registry.en],
  ['Email', mail(c.contactEmail)],
  ['Privacy', mail(c.privacyEmail)],
])}
<h2>Use of the website</h2>
<p>This website describes Pescada and publishes its legal terms. Use of the Pescada portal is governed by the <a href="/terms/">Terms of Service</a>; personal data is handled as described in the <a href="/privacy/">Privacy Policy</a>. The website sets no cookies.</p>
<h2>Intellectual property</h2>
<p>The texts, design, logo and software of Pescada belong to ${c.legalName} or are used under licence. You may link to this website, but you may not copy or reuse its content for commercial purposes without our written permission.</p>
<h2>Law and courts</h2>
<p>This notice is governed by Spanish law. Disputes go to the courts of ${c.courtsCity}, unless the law gives a consumer the right to use the courts of their place of residence.</p>`,
  },
  {
    key: 'legal-notice', lang: 'es', path: '/es/aviso-legal/', navTitle: 'Aviso legal',
    title: 'Aviso legal',
    description: 'Quién presta Pescada: datos identificativos conforme al artículo 10 de la LSSI-CE.',
    body: `
<p>El sitio web pescada.io y el portal de Pescada en app.pescada.io son un servicio de la sociedad que se indica a continuación, conforme al artículo 10 de la Ley 34/2002, de Servicios de la Sociedad de la Información y de Comercio Electrónico (LSSI-CE).</p>
${rows([
  ['Titular', `${c.legalName}${c.singleMember ? ' (sociedad unipersonal)' : ''}`],
  ['NIF', c.taxId],
  ['Domicilio social', `${c.address}, España`],
  ['Registro Mercantil', c.registry.es],
  ['Correo electrónico', mail(c.contactEmail)],
  ['Privacidad', mail(c.privacyEmail)],
])}
<h2>Uso del sitio web</h2>
<p>Este sitio web describe Pescada y publica sus condiciones legales. El uso del portal de Pescada se rige por las <a href="/es/terminos/">Condiciones de uso</a>; los datos personales se tratan según la <a href="/es/privacidad/">Política de privacidad</a>. El sitio web no instala cookies.</p>
<h2>Propiedad intelectual</h2>
<p>Los textos, el diseño, el logotipo y el software de Pescada pertenecen a ${c.legalName} o se utilizan con licencia. Puedes enlazar a este sitio web, pero no copiar ni reutilizar su contenido con fines comerciales sin nuestro permiso por escrito.</p>
<h2>Ley aplicable y jurisdicción</h2>
<p>Este aviso se rige por la ley española. Los conflictos se someten a los juzgados y tribunales de ${c.courtsCity}, salvo que la ley reconozca a un consumidor el derecho a acudir a los de su domicilio.</p>`,
  },
];
