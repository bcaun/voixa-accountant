import { company } from '../company.mjs';

// Icons from the brand kit: 24 px grid, stroke 1.75, round caps and joins.
const icon = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
export const I = {
  send: icon('<path d="M12 16V4M7 9l5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>'),
  notify: icon('<path d="M6 9a6 6 0 0 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9Z"/><path d="M10 20a2 2 0 0 0 4 0"/>'),
  open: icon('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>'),
  confirm: icon('<circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.8 2.8L16.5 9.5"/>'),
  globe: icon('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>'),
  lock: icon('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'),
  doc: icon('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>'),
  deadline: icon('<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>'),
};
const STEP_KEYS = ['sent', 'notified', 'opened', 'confirmed'];
const STEP_ICONS = [I.send, I.notify, I.open, I.confirm];

export function home(t, lang) {
  return `
<section class="hero"><div class="wrap">
  <div class="hero-text">
    <p class="eyebrow">${t.eyebrow}</p>
    <h1>${t.h1}</h1>
    <p class="lead">${t.lead}</p>
    <div class="cta"><a class="btn primary" href="#demo">${t.demo}</a><a class="btn outline" href="#how">${t.how}</a></div>
    <p class="fine">${t.fine}</p>
  </div>
  <div class="horizon" role="img" aria-label="${t.visualAria}">
    <div class="sun"></div><div class="sea"></div><div class="lagoon"></div><div class="deep"></div>
    <div class="card">${t.rows.map(([name, when, key, label]) => `<div class="doc-row"><div><b>${name}</b><span class="mono">${when}</span></div><span class="status ${key}">${label}</span></div>`).join('')}</div>
  </div>
</div></section>

<section class="section sand"><div class="wrap">
  <div class="section-head"><p class="eyebrow">${t.problemEyebrow}</p><h2>${t.problemTitle}</h2></div>
  <div class="quotes">${t.quotes.map(([q, p, m]) => `<blockquote class="quote"><q>${q}</q><p>${p}</p><span class="mono">→ ${m}</span></blockquote>`).join('')}</div>
</div></section>

<section class="section" id="how"><div class="wrap">
  <div class="section-head"><p class="eyebrow">${t.howEyebrow}</p><h2>${t.howTitle}</h2></div>
  <ol class="steps">${t.steps.map(([title, text], i) => `<li><span class="tile ${STEP_KEYS[i]}">${STEP_ICONS[i]}</span><span class="mono">0${i + 1}</span><h3>${title}</h3><p>${text}</p></li>`).join('')}</ol>
</div></section>

<section class="section" id="product" style="padding-top:0"><div class="wrap">
  <div class="section-head"><p class="eyebrow">${t.productEyebrow}</p><h2>${t.productTitle}</h2></div>
  <div class="features">${t.features.map(([tag, title, text]) => `<div class="feature"><span class="mono">${tag}</span><h3>${title}</h3><p>${text}</p></div>`).join('')}</div>
</div></section>

<section class="section" style="padding-top:0"><div class="wrap split">
  <div class="section-head" style="margin:0"><p class="eyebrow">${t.clientsEyebrow}</p><h2>${t.clientsTitle}</h2><p class="lead">${t.clientsLead}</p></div>
  <ul class="facts">${t.clientFacts.map(([b, s]) => `<li><b>${b}</b><span>${s}</span></li>`).join('')}</ul>
</div></section>

<section class="section deep" id="security"><div class="wrap split">
  <div class="section-head" style="margin:0"><p class="eyebrow">${t.secEyebrow}</p><h2>${t.secTitle}</h2><p class="lead">${t.secLead}</p><p>${t.secLinks}</p></div>
  <div class="cards-deep">${t.secCards.map(([ic, b, s]) => `<div>${I[ic]}<b>${b}</b><span>${s}</span></div>`).join('')}</div>
</div></section>

<section class="demo" id="demo"><div class="wrap">
  <h2>${t.closeTitle}</h2>
  <p class="lead">${t.closeLead}</p>
  ${demoForm(t.form, lang, t.demo)}
  <p class="fine">${t.closeFine}</p>
</div></section>`;
}

/** The demo request form posts to the app (no JavaScript); the visitor lands on the thank-you page. */
export function demoForm(f, lang, button) {
  const countries = [['Spain', f.countries[0]], ['Italy', f.countries[1]], ['France', f.countries[2]], ['Germany', f.countries[3]], ['Portugal', f.countries[4]], ['Other', f.countries[5]]];
  const pre = { es: 'Spain', it: 'Italy', fr: 'France', de: 'Germany', pt: 'Portugal' }[lang];
  return `<form class="demo-form" method="post" action="${company.appUrl}/public/demo">
    <input type="hidden" name="lang" value="${lang}">
    <div class="hp" aria-hidden="true"><label>Website <input name="website" tabindex="-1" autocomplete="off"></label></div>
    <label><span>${f.name}</span><input name="name" required autocomplete="name" maxlength="200"></label>
    <label><span>${f.firm}</span><input name="firm" required autocomplete="organization" maxlength="200"></label>
    <label><span>${f.email}</span><input name="email" type="email" required autocomplete="email" maxlength="200"></label>
    <label><span>${f.country}</span><select name="country">${countries.map(([v, l]) => `<option value="${v}" ${v === pre ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <label><span>${f.clients}</span><select name="clients">${['1–20', '20–50', '50–150', '150+'].map((v) => `<option>${v}</option>`).join('')}</select></label>
    <label class="wide"><span>${f.message}</span><textarea name="message" rows="3" maxlength="3000"></textarea></label>
    <div class="wide"><button class="btn dark" type="submit">${button}</button></div>
    <p class="fine wide">${f.note}</p>
  </form>`;
}

export const en = {
  eyebrow: 'Tracked document exchange for accounting firms',
  h1: 'Every document <span class="catch">caught.</span> Every step on record.',
  lead: 'Pescada is where your clients send invoices, bank statements and contracts, and where you send them reports and filings.',
  demo: 'Request a demo', how: 'See how it works',
  fine: 'Spain · Italy · France · Germany · Portugal · Hosted in the EU · GDPR data processing agreement',
  visualAria: 'Three tracked documents: one confirmed, one opened, one sent',
  rows: [
    ['Invoices — October.pdf', '31.10 · 09:14', 'confirmed', 'Confirmed'],
    ['Modelo 303 — 3T.pdf', '30.10 · 17:52', 'opened', 'Opened'],
    ['Bank statement — Q3.pdf', '30.10 · 11:03', 'sent', 'Sent'],
  ],
  problemEyebrow: 'The problem', problemTitle: 'Three sentences every accountant has heard.',
  quotes: [
    ['I never got it.', 'Pescada shows when the file arrived, when the email reached their inbox and when they opened it.', 'Delivery logged, with time'],
    ['You never sent it.', 'Every upload is fingerprinted and time-stamped in a log nobody can edit. Your client sees the same record.', 'Every upload on record'],
    ['It went to spam.', 'The receiving mail server reports back: delivered, bounced or spam. Anything left unopened gets a reminder.', 'A channel outside the inbox'],
  ],
  howEyebrow: 'How it works', howTitle: 'From upload to confirmed, in four recorded steps.',
  steps: [
    ['Sent', 'The file arrives and is logged with sender and time.'],
    ['Notified', 'The other side is told a document is waiting.'],
    ['Opened', 'The first view is recorded — no more guessing.'],
    ['Confirmed', 'Receipt is acknowledged. The record is closed.'],
  ],
  productEyebrow: 'Product', productTitle: 'Built for how accounting firms actually work, in five countries.',
  features: [
    ['One firm, every client', 'A workspace for each client', 'Each company has its own space and can invite its own staff. Clients never see each other; your team sees them all.'],
    ['Monthly · quarterly · yearly', 'Deadlines that open themselves', 'Templates for each country, from Modelo 303 to F24, CA3, UStVA and the Portuguese VAT return: requests appear ahead of time, with reminders.'],
    ['FatturaPA · XRechnung · Factur-X · bank files', 'Statements and e-invoices read for you', 'E-invoices and bank files are read exactly, or fetched from the bank through open banking; on the Pro plan, PDFs and scans are read by AI too. Counterparty, tax ID, amount and invoice numbers come out of every payment.'],
    ['Suggested, then confirmed', 'Payments matched to invoices', 'Each payment is matched to the invoices the client uploaded, by number, amount, NIF and date. Your team confirms or rejects every match.'],
    ['SHA-256 · CSV · printable report', 'An evidence log you can hand over', 'Every action sits in an append-only, hash-chained log. Export it as CSV, or print a tracking report for one document.'],
    ['Full history', 'Versions, never overwrites', 'Replacing a file keeps the earlier version and the reason, and asks the other side to open and confirm again.'],
  ],
  clientsEyebrow: 'For your clients', clientsTitle: 'Simple enough for clients who hate portals.',
  clientsLead: 'No account to set up and no password to forget. They get a link, drop their files, and see what is still waiting on them.',
  clientFacts: [
    ['Sign in', 'A single-use link by email. Nothing to remember.'],
    ['One place', 'Upload documents, answer requests, approve reports.'],
    ['Private', 'Only their own company’s documents, and the colleagues they invite.'],
    ['Any device', 'Works in the browser on a phone or a laptop.'],
  ],
  secEyebrow: 'Data and security', secTitle: 'Your clients’ papers stay in European waters.',
  secLead: 'Servers in Germany, files in EU-jurisdiction storage locked against deletion for six years, encrypted in transit, backed up daily to a second provider.',
  secLinks: '<a href="/security/">Security details</a> · <a href="/dpa/">Data processing agreement</a> · <a href="/subprocessors/">Sub-processors</a>',
  secCards: [
    ['globe', 'EU data residency', 'Stored and processed in the EU.'],
    ['lock', 'GDPR by design', 'Article 28 processor terms for every firm.'],
    ['doc', 'Full audit trail', 'Every step timestamped, hash-chained, exportable.'],
    ['deadline', 'Built around deadlines', 'Modelo 303, 111, 390 — nothing lands late unseen.'],
  ],
  form: { name: 'Your name', firm: 'Firm', email: 'Work email', country: 'Country', clients: 'Clients', message: 'Anything we should know? (optional)',
    countries: ['Spain', 'Italy', 'France', 'Germany', 'Portugal', 'Another country'], note: 'We use these details only to arrange the demo. See the <a href="/privacy/">Privacy Policy</a>.' },
  closeTitle: 'Stop asking “did you get it?”',
  closeLead: 'A 30-minute walkthrough with your own documents. We set up a workspace for your firm and plan the first month’s deadlines with you.',
  closeFine: `Already working with a firm on Pescada? <a href="${company.appUrl}">Sign in at app.pescada.io</a>`,
};

export const es = {
  eyebrow: 'Intercambio de documentos con trazabilidad para asesorías',
  h1: 'Ningún documento se <span class="catch">escapa.</span> Cada paso, registrado.',
  lead: 'Pescada es donde tus clientes envían facturas, extractos bancarios y contratos, y donde tú les envías informes y declaraciones.',
  demo: 'Solicitar una demo', how: 'Cómo funciona',
  fine: 'España · Italia · Francia · Alemania · Portugal · Alojado en la UE · Contrato de encargo del tratamiento (RGPD)',
  visualAria: 'Tres documentos con trazabilidad: uno confirmado, uno abierto y uno enviado',
  rows: [
    ['Facturas — octubre.pdf', '31.10 · 09:14', 'confirmed', 'Confirmado'],
    ['Modelo 303 — 3T.pdf', '30.10 · 17:52', 'opened', 'Abierto'],
    ['Extracto bancario — T3.pdf', '30.10 · 11:03', 'sent', 'Enviado'],
  ],
  problemEyebrow: 'El problema', problemTitle: 'Tres frases que toda asesoría ha oído.',
  quotes: [
    ['No me ha llegado.', 'Pescada muestra cuándo llegó el archivo, cuándo el aviso llegó a su bandeja de entrada y cuándo lo abrió.', 'Entrega registrada, con su hora'],
    ['No me lo enviaste.', 'Cada archivo se registra con su huella y su hora en un registro que nadie puede modificar. Tu cliente ve lo mismo que tú.', 'Cada envío, registrado'],
    ['Se fue a spam.', 'El servidor de correo del destinatario informa: entregado, rebotado o spam. Lo que queda sin abrir recibe un recordatorio.', 'Un canal fuera del correo'],
  ],
  howEyebrow: 'Cómo funciona', howTitle: 'Del envío a la confirmación, en cuatro pasos registrados.',
  steps: [
    ['Enviado', 'El archivo llega y queda registrado con el remitente y la hora.'],
    ['Notificado', 'La otra parte recibe el aviso de que hay un documento esperando.'],
    ['Abierto', 'La primera apertura queda registrada: se acabaron las suposiciones.'],
    ['Confirmado', 'Se confirma la recepción. El registro queda cerrado.'],
  ],
  productEyebrow: 'Producto', productTitle: 'Hecho para cómo trabajan de verdad las asesorías, en cinco países.',
  features: [
    ['Una asesoría, todos sus clientes', 'Un espacio para cada cliente', 'Cada empresa tiene su propio espacio y puede invitar a su personal. Los clientes nunca se ven entre sí; tu equipo los ve a todos.'],
    ['Mensual · trimestral · anual', 'Plazos que se abren solos', 'Plantillas para cada país, del Modelo 303 al F24, la CA3, la UStVA o el IVA portugués: las solicitudes aparecen con antelación, con recordatorios.'],
    ['FatturaPA · XRechnung · Factur-X · ficheros bancarios', 'Extractos y facturas electrónicas leídos por ti', 'Las facturas electrónicas y los ficheros bancarios se leen de forma exacta, o se reciben del banco por banca abierta; con el plan Pro, la IA lee también los PDF y escaneos. De cada movimiento salen contraparte, NIF, importe y número de factura.'],
    ['Propuesto y luego confirmado', 'Cobros y pagos casados con facturas', 'Cada movimiento se casa con las facturas que subió el cliente por número, importe, NIF y fecha. Tu equipo confirma o rechaza cada propuesta.'],
    ['SHA-256 · CSV · informe imprimible', 'Un registro que sirve como prueba', 'Cada acción queda en un registro encadenado al que solo se pueden añadir entradas. Se exporta en CSV o como informe de un documento.'],
    ['Historial completo', 'Versiones, nunca sobrescrituras', 'Al sustituir un archivo se conserva la versión anterior y el motivo, y se pide a la otra parte que vuelva a abrirlo y confirmarlo.'],
  ],
  clientsEyebrow: 'Para tus clientes', clientsTitle: 'Sencillo incluso para quien odia los portales.',
  clientsLead: 'Sin cuenta que configurar ni contraseña que olvidar. Reciben un enlace, suben sus archivos y ven qué les queda pendiente.',
  clientFacts: [
    ['Acceso', 'Un enlace de un solo uso por correo. Nada que recordar.'],
    ['Un único sitio', 'Subir documentos, responder solicitudes, aprobar informes.'],
    ['Privado', 'Solo los documentos de su empresa y los compañeros que inviten.'],
    ['Cualquier dispositivo', 'Funciona en el navegador del móvil o del portátil.'],
  ],
  secEyebrow: 'Datos y seguridad', secTitle: 'Los papeles de tus clientes no salen de aguas europeas.',
  secLead: 'Servidores en Alemania, archivos en un almacenamiento con jurisdicción UE bloqueado contra borrado durante seis años, cifrado en tránsito y copia diaria en un segundo proveedor.',
  secLinks: '<a href="/es/seguridad/">Seguridad</a> · <a href="/es/dpa/">Encargo del tratamiento</a> · <a href="/es/subencargados/">Subencargados</a>',
  secCards: [
    ['globe', 'Datos en la UE', 'Guardados y tratados en la UE.'],
    ['lock', 'RGPD desde el diseño', 'Contrato del artículo 28 con cada asesoría.'],
    ['doc', 'Trazabilidad completa', 'Cada paso con su hora, encadenado y exportable.'],
    ['deadline', 'Pensado para los plazos', '303, 111, 390: nada llega tarde sin que se vea.'],
  ],
  form: { name: 'Tu nombre', firm: 'Asesoría', email: 'Correo de trabajo', country: 'País', clients: 'Clientes', message: '¿Algo que debamos saber? (opcional)',
    countries: ['España', 'Italia', 'Francia', 'Alemania', 'Portugal', 'Otro país'], note: 'Usamos estos datos solo para organizar la demo. Consulta la <a href="/es/privacidad/">Política de privacidad</a>.' },
  closeTitle: 'Deja de preguntar «¿te ha llegado?»',
  closeLead: 'Una demo de 30 minutos con tus propios documentos. Configuramos un espacio para tu asesoría y preparamos contigo los plazos del primer mes.',
  closeFine: `¿Ya trabajas con una asesoría en Pescada? <a href="${company.appUrl}">Accede en app.pescada.io</a>`,
};

export const pages = [
  {
    key: 'home', lang: 'en', path: '/',
    title: 'Tracked document exchange for accounting firms',
    description: 'Clients send invoices and statements, you send reports and filings. Every file is tracked from sent to confirmed in a log nobody can edit.',
    body: home(en, 'en'),
  },
  {
    key: 'home', lang: 'es', path: '/es/',
    title: 'Intercambio de documentos con trazabilidad para asesorías',
    description: 'Tus clientes envían facturas y extractos; tú envías informes y declaraciones. Cada archivo queda registrado desde el envío hasta la confirmación, en un registro que nadie puede modificar.',
    body: home(es, 'es'),
  },
];
