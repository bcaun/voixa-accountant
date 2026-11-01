import { company as c } from '../company.mjs';

const table = (head, rows) => `<div class="table"><table><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((d) => `<td>${d}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;

export const pages = [
  {
    key: 'privacy', lang: 'en', path: '/privacy/', navTitle: 'Privacy Policy',
    title: 'Privacy Policy',
    description: 'How Pescada handles personal data on pescada.io and in the Pescada portal.',
    body: `
<p>This policy covers the website pescada.io and the Pescada portal at app.pescada.io. It explains what personal data we process, why, and what rights you have.</p>

<h2>1. Who we are</h2>
<p>Pescada is provided by ${c.legalName}, tax ID ${c.taxId}, ${c.address} (“Pescada”, “we”). Privacy contact: <a href="mailto:${c.privacyEmail}">${c.privacyEmail}</a>.</p>

<h2>2. Our two roles</h2>
<ul>
  <li><b>Controller.</b> For visitors to this website and for the people at accounting firms that use Pescada or ask us about it, we decide how their data is used.</li>
  <li><b>Processor.</b> For the documents and data inside a firm’s workspaces, including the firm’s clients and their staff, the accounting firm (or its client) is the controller. We process that data only on the firm’s instructions, under our <a href="/dpa/">Data Processing Agreement</a>. If you are a client of an accounting firm, send requests about your documents to your firm; we will help them answer.</li>
</ul>

<h2>3. Data we process as controller</h2>
${table(['Who', 'Data', 'Kept for'], [
  ['Website visitors', 'IP address, browser, pages requested and time, in our web server’s security logs', 'Up to 30 days'],
  ['Users at customer firms', 'Name, work email, firm, role; activity in the portal; billing and contract details', 'While the contract lasts, then 6 years for accounting and evidence purposes'],
  ['People who contact us', 'Name, email, company and what you write to us', '12 months, or longer if it leads to a contract'],
])}
<p>This website sets no cookies and uses no analytics or advertising tools. Fonts are served from our own server. The portal uses one strictly necessary cookie that keeps you signed in for up to 30 days.</p>

<h2>4. Why we use it and on what legal basis</h2>
<ul>
  <li>To provide Pescada to customer firms and their users: performance of a contract (GDPR Art. 6(1)(b)).</li>
  <li>To keep the service secure and to keep the tamper-evident activity log that records who sent, opened and confirmed each document: our legitimate interest and that of our customers (Art. 6(1)(f)).</li>
  <li>To invoice and keep accounting records: legal obligation (Art. 6(1)(c)).</li>
  <li>To answer enquiries and demo requests: steps at your request before a contract, and our legitimate interest (Art. 6(1)(b) and (f)).</li>
</ul>
<p>We do not make decisions that have legal or similarly significant effects on you by automated means alone.</p>

<h2>5. Who receives the data</h2>
<p>We use the service providers listed on our <a href="/subprocessors/">Sub-processors</a> page to host the service, store files, send email and read documents. They act on our instructions under data processing agreements. We disclose data to public authorities only where the law requires it.</p>

<h2>6. Transfers outside the EU</h2>
<p>The service is hosted in Germany and files are stored in the EU. Some providers are based in the United States; those transfers rely on the EU-US Data Privacy Framework where the provider is certified, or on the European Commission’s Standard Contractual Clauses. The details for each provider are on the <a href="/subprocessors/">Sub-processors</a> page.</p>

<h2>7. Your rights</h2>
<p>You can ask for access, rectification, erasure, restriction, portability, and object to processing based on legitimate interest, by writing to <a href="mailto:${c.privacyEmail}">${c.privacyEmail}</a>. We answer within one month. Where the law requires us to keep data (for example accounting records), we will tell you. You can also complain to the Spanish Data Protection Agency (AEPD), <a href="https://www.aepd.es">www.aepd.es</a>.</p>

<h2>8. Changes</h2>
<p>We publish changes on this page with a new date. If a change materially affects how we use the data of customer users, we tell customers by email before it applies.</p>`,
  },
  {
    key: 'privacy', lang: 'es', path: '/es/privacidad/', navTitle: 'Política de privacidad',
    title: 'Política de privacidad',
    description: 'Cómo trata Pescada los datos personales en pescada.io y en el portal de Pescada.',
    body: `
<p>Esta política se aplica al sitio web pescada.io y al portal de Pescada en app.pescada.io. Explica qué datos personales tratamos, para qué y qué derechos tienes.</p>

<h2>1. Quiénes somos</h2>
<p>Pescada es un servicio de ${c.legalName}, NIF ${c.taxId}, ${c.address} («Pescada», «nosotros»). Contacto de privacidad: <a href="mailto:${c.privacyEmail}">${c.privacyEmail}</a>.</p>

<h2>2. Nuestros dos papeles</h2>
<ul>
  <li><b>Responsable del tratamiento.</b> Para los visitantes de este sitio y para las personas de las asesorías que usan Pescada o nos consultan, decidimos cómo se usan sus datos.</li>
  <li><b>Encargado del tratamiento.</b> Para los documentos y datos dentro de los espacios de una asesoría, incluidos sus clientes y el personal de estos, el responsable es la asesoría (o su cliente). Tratamos esos datos solo siguiendo las instrucciones de la asesoría, conforme a nuestro <a href="/es/dpa/">Contrato de encargo del tratamiento</a>. Si eres cliente de una asesoría, dirige las solicitudes sobre tus documentos a tu asesoría; nosotros le ayudaremos a responder.</li>
</ul>

<h2>3. Datos que tratamos como responsables</h2>
${table(['Quién', 'Datos', 'Plazo de conservación'], [
  ['Visitantes del sitio web', 'Dirección IP, navegador, páginas solicitadas y hora, en los registros de seguridad del servidor web', 'Hasta 30 días'],
  ['Usuarios de las asesorías clientes', 'Nombre, correo profesional, asesoría, función; actividad en el portal; datos de facturación y del contrato', 'Mientras dure el contrato y después 6 años a efectos contables y probatorios'],
  ['Personas que nos contactan', 'Nombre, correo, empresa y lo que nos escribas', '12 meses, o más si da lugar a un contrato'],
])}
<p>Este sitio no instala cookies ni usa herramientas de analítica o publicidad. Las fuentes tipográficas se sirven desde nuestro propio servidor. El portal usa una única cookie estrictamente necesaria que mantiene la sesión iniciada hasta 30 días.</p>

<h2>4. Finalidades y bases jurídicas</h2>
<ul>
  <li>Prestar Pescada a las asesorías clientes y a sus usuarios: ejecución de un contrato (art. 6.1.b RGPD).</li>
  <li>Mantener la seguridad del servicio y el registro de actividad a prueba de manipulaciones que recoge quién envió, abrió y confirmó cada documento: interés legítimo nuestro y de nuestros clientes (art. 6.1.f).</li>
  <li>Facturar y llevar la contabilidad: obligación legal (art. 6.1.c).</li>
  <li>Responder consultas y solicitudes de demo: medidas precontractuales a petición tuya e interés legítimo (art. 6.1.b y f).</li>
</ul>
<p>No tomamos decisiones basadas únicamente en tratamientos automatizados que produzcan efectos jurídicos o te afecten significativamente.</p>

<h2>5. Destinatarios</h2>
<p>Utilizamos los proveedores que figuran en la página de <a href="/es/subencargados/">Subencargados</a> para alojar el servicio, guardar archivos, enviar correos y leer documentos. Actúan siguiendo nuestras instrucciones en virtud de contratos de encargo del tratamiento. Solo comunicamos datos a autoridades públicas cuando la ley lo exige.</p>

<h2>6. Transferencias fuera de la UE</h2>
<p>El servicio está alojado en Alemania y los archivos se guardan en la UE. Algunos proveedores tienen sede en Estados Unidos; esas transferencias se basan en el Marco de Privacidad de Datos UE-EE. UU. cuando el proveedor está certificado, o en las Cláusulas Contractuales Tipo de la Comisión Europea. Los detalles de cada proveedor están en la página de <a href="/es/subencargados/">Subencargados</a>.</p>

<h2>7. Tus derechos</h2>
<p>Puedes ejercer los derechos de acceso, rectificación, supresión, limitación, portabilidad y oposición al tratamiento basado en interés legítimo escribiendo a <a href="mailto:${c.privacyEmail}">${c.privacyEmail}</a>. Respondemos en el plazo de un mes. Cuando la ley nos obligue a conservar datos (por ejemplo, registros contables), te lo indicaremos. También puedes reclamar ante la Agencia Española de Protección de Datos (AEPD), <a href="https://www.aepd.es">www.aepd.es</a>.</p>

<h2>8. Cambios</h2>
<p>Publicamos los cambios en esta página con una nueva fecha. Si un cambio afecta de forma relevante al uso de los datos de los usuarios de nuestros clientes, lo comunicamos a los clientes por correo antes de que se aplique.</p>`,
  },
];
