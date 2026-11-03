import { company as c } from '../company.mjs';

const table = (head, rows) => `<div class="table"><table><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((d) => `<td>${d}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;

export const pages = [
  {
    key: 'subprocessors', lang: 'en', path: '/subprocessors/', navTitle: 'Sub-processors',
    title: 'Sub-processors',
    description: 'The providers that process personal data for Pescada, where, and under which safeguards.',
    body: `
<p>Pescada uses these providers to run the service. This list is Annex 1 of our <a href="/dpa/">Data Processing Agreement</a>.</p>
${table(['Provider', 'What for', 'Data', 'Where', 'Safeguard'], [
  ['Hostinger International Ltd', 'Server that runs the portal and its database', 'All portal data', 'Germany', 'Within the EU'],
  ['Cloudflare, Inc.', 'DNS; storage of documents and database backups', 'Documents, database backups', 'Storage in the EU jurisdiction', 'Data stored in the EU; Data Privacy Framework and Standard Contractual Clauses for any access from the US'],
  ['ActiveCampaign, LLC (Postmark)', 'Notification and sign-in emails', 'Name, email address, email subject and text', 'United States', 'Data Privacy Framework and/or Standard Contractual Clauses'],
  ['Anthropic, PBC', 'Reading PDF and image documents (Claude API)', 'Content of the invoices and statements sent for reading', 'United States', 'Standard Contractual Clauses; not used to train models'],
])}
<h2>Announced: from 1 December 2026</h2>
<p>Two providers are added for features that customers can choose to use. They process data only when the feature is used.</p>
${table(['Provider', 'What for', 'Data', 'Where', 'Safeguard'], [
  ['Enable Banking Oy', 'Fetching bank statements through open banking, when a client connects a bank account', 'Account details and movements of the connected account', 'Finland (EU)', 'Account information service provider authorised by the Finnish Financial Supervisory Authority; within the EU'],
  ['Stripe Payments Europe, Ltd.', 'Payment of the Pescada subscription by firms that subscribe online', 'Firm’s billing contact, billing address and tax ID; card data goes to Stripe directly, never to Pescada', 'Ireland (EU), with transfers to the United States', 'Data Privacy Framework and Standard Contractual Clauses'],
])}
<p>Bank files in Norma 43, camt.053 and CSV format are read on our own server and are never sent to Anthropic. A customer can ask us to switch AI reading off for its account.</p>
<h2>Changes to this list</h2>
<p>We announce new or replaced sub-processors at least 30 days in advance by email to customers. To be told about changes, write to <a href="mailto:${c.privacyEmail}">${c.privacyEmail}</a>.</p>`,
  },
  {
    key: 'subprocessors', lang: 'es', path: '/es/subencargados/', navTitle: 'Subencargados',
    title: 'Subencargados del tratamiento',
    description: 'Los proveedores que tratan datos personales para Pescada, dónde y con qué garantías.',
    body: `
<p>Pescada utiliza estos proveedores para prestar el servicio. Esta lista es el Anexo 1 de nuestro <a href="/es/dpa/">Contrato de encargo del tratamiento</a>.</p>
${table(['Proveedor', 'Para qué', 'Datos', 'Dónde', 'Garantía'], [
  ['Hostinger International Ltd', 'Servidor del portal y su base de datos', 'Todos los datos del portal', 'Alemania', 'Dentro de la UE'],
  ['Cloudflare, Inc.', 'DNS; almacenamiento de documentos y copias de la base de datos', 'Documentos, copias de la base de datos', 'Almacenamiento con jurisdicción UE', 'Datos guardados en la UE; Marco de Privacidad de Datos y Cláusulas Contractuales Tipo para cualquier acceso desde EE. UU.'],
  ['ActiveCampaign, LLC (Postmark)', 'Correos de aviso y de acceso', 'Nombre, correo electrónico, asunto y texto del correo', 'Estados Unidos', 'Marco de Privacidad de Datos y/o Cláusulas Contractuales Tipo'],
  ['Anthropic, PBC', 'Lectura de documentos PDF e imágenes (API de Claude)', 'Contenido de las facturas y extractos enviados para su lectura', 'Estados Unidos', 'Cláusulas Contractuales Tipo; no se usan para entrenar modelos'],
])}
<h2>Anunciados: a partir del 1 de diciembre de 2026</h2>
<p>Se añaden dos proveedores para funciones que cada cliente decide usar. Solo tratan datos cuando se usa la función.</p>
${table(['Proveedor', 'Para qué', 'Datos', 'Dónde', 'Garantía'], [
  ['Enable Banking Oy', 'Obtención de extractos por banca abierta, cuando un cliente conecta una cuenta', 'Datos y movimientos de la cuenta conectada', 'Finlandia (UE)', 'Proveedor de servicios de información sobre cuentas autorizado por la autoridad financiera de Finlandia; dentro de la UE'],
  ['Stripe Payments Europe, Ltd.', 'Pago de la suscripción a Pescada por las asesorías que se suscriben en línea', 'Contacto, dirección y NIF de facturación de la asesoría; los datos de la tarjeta van directamente a Stripe, nunca a Pescada', 'Irlanda (UE), con transferencias a EE. UU.', 'Marco de Privacidad de Datos y Cláusulas Contractuales Tipo'],
])}
<p>Los ficheros bancarios en formato Norma 43, camt.053 y CSV se leen en nuestro propio servidor y nunca se envían a Anthropic. Un cliente puede pedirnos que desactivemos la lectura con IA en su cuenta.</p>
<h2>Cambios en esta lista</h2>
<p>Anunciamos los subencargados nuevos o sustituidos con al menos 30 días de antelación por correo a nuestros clientes. Para recibir estos avisos, escribe a <a href="mailto:${c.privacyEmail}">${c.privacyEmail}</a>.</p>`,
  },
];
