import { company } from '../company.mjs';

const demo = (lang) => `mailto:${company.contactEmail}?subject=${encodeURIComponent(lang === 'es' ? 'Demo de Pescada' : 'Pescada demo')}`;

function ledger(t) {
  return `<div class="ledger" role="img" aria-label="${t.aria}">
    <div class="doc"><b>${t.doc}</b><span class="ref">PX-001-0004 · v1</span></div>
    <ol class="steps">
      <li><i></i>${t.s[0]}<em>12 Oct<br>09:14</em></li>
      <li><i></i>${t.s[1]}<em>12 Oct<br>09:14</em></li>
      <li><i></i>${t.s[2]}<em>12 Oct<br>10:02</em></li>
      <li><i></i>${t.s[3]}<em>12 Oct<br>10:03</em></li>
    </ol>
    <ul class="log">
      ${t.log.map(([time, who, what, hash]) => `<li><span class="t">${time}</span><span><span class="who">${who}</span> ${what}</span><span class="h">#${hash}</span></li>`).join('')}
    </ul>
    <p class="verified">✓ ${t.verified}</p>
  </div>`;
}

const en = {
  ledger: {
    aria: 'Example of a tracked document: sent, notified, opened and confirmed, each with its time',
    doc: 'Supplier invoice F-2026-08812',
    s: ['Sent', 'Notified', 'Opened', 'Confirmed'],
    log: [
      ['09:14', 'Daniel', 'uploaded Makro_F-2026-08812.pdf', '3fa9c2'],
      ['09:14', 'Mail server', 'accepted the notification to Elena', '8b01d4'],
      ['10:02', 'Elena', 'opened the document', 'c41e77'],
      ['10:03', 'Elena', 'confirmed receipt', '1d9a50'],
    ],
    verified: 'Log verified: 1,284 entries, chain unbroken',
  },
};
const es = {
  ledger: {
    aria: 'Ejemplo de documento con trazabilidad: enviado, notificado, abierto y confirmado, cada paso con su hora',
    doc: 'Factura de proveedor F-2026-08812',
    s: ['Enviado', 'Notificado', 'Abierto', 'Confirmado'],
    log: [
      ['09:14', 'Daniel', 'subió Makro_F-2026-08812.pdf', '3fa9c2'],
      ['09:14', 'Servidor de correo', 'aceptó el aviso a Elena', '8b01d4'],
      ['10:02', 'Elena', 'abrió el documento', 'c41e77'],
      ['10:03', 'Elena', 'confirmó la recepción', '1d9a50'],
    ],
    verified: 'Registro verificado: 1.284 entradas, cadena intacta',
  },
};

export const pages = [
  {
    key: 'home', lang: 'en', path: '/',
    title: 'Tracked document exchange for accounting firms',
    description: 'Clients send invoices and statements, you send reports and filings. Every file is tracked from sent to confirmed in a log nobody can edit.',
    body: `
<section class="hero"><div class="wrap">
  <div>
    <p class="eyebrow">For accounting firms in Spain</p>
    <h1 style="margin-top:18px">Every document <em>caught</em>. Every step on record.</h1>
    <p class="lead">Pescada is where your clients send invoices, bank statements and contracts, and where you send them reports and filings. Each file is tracked from sent to confirmed, so nobody can say they never got it.</p>
    <div class="cta"><a class="btn primary" href="${demo('en')}">Request a demo</a><a class="btn" href="#how">See how it works</a></div>
    <p class="fine">Hosted in the EU · GDPR data processing agreement · Built around Modelo 303, 111 and 390 deadlines</p>
  </div>
  ${ledger(en.ledger)}
</div></section>

<section class="band"><div class="wrap">
  <div class="section-head"><p class="eyebrow">The problem</p><h2>Three sentences every accountant has heard.</h2></div>
  <div class="excuses">
    <div class="excuse"><q>I never got it.</q><p>Pescada shows when the file arrived, when the notification reached their inbox and when they opened it. Receipt can only be confirmed after opening.</p></div>
    <div class="excuse"><q>You never sent it.</q><p>Every upload is fingerprinted and time-stamped in a log that cannot be edited afterwards. Your client sees the same record you do.</p></div>
    <div class="excuse"><q>It went to spam.</q><p>The receiving mail server reports back: delivered, bounced or marked as spam. Anything left unopened gets an automatic reminder.</p></div>
  </div>
</div></section>

<section class="band" id="how"><div class="wrap">
  <div class="section-head"><p class="eyebrow">How it works</p><h2>From upload to confirmed, in four recorded steps.</h2></div>
  <ol class="flow">
    <li><h3>Sent</h3><p>The client drops files into their private workspace, or you send a report with its deadline.</p></li>
    <li><h3>Notified</h3><p>The other side gets an email. Delivery, bounces and spam reports are written to the log.</p></li>
    <li><h3>Opened</h3><p>Every opening and download is recorded, version by version, with the person and the time.</p></li>
    <li><h3>Confirmed</h3><p>Receipt or approval takes one click, and is only possible once the file has been opened.</p></li>
  </ol>
</div></section>

<section class="band" id="product"><div class="wrap">
  <div class="section-head"><p class="eyebrow">Product</p><h2>Built for how a Spanish accounting firm actually works.</h2></div>
  <div class="features">
    <div class="feature"><span class="tag">One firm, every client</span><h3>A workspace for each client</h3><p>Each company has its own space and can invite its own staff. Clients never see each other; your team sees them all.</p></div>
    <div class="feature"><span class="tag">Monthly · quarterly · yearly</span><h3>Deadlines that open themselves</h3><p>Bank statements every month, Modelo 303 and 111 every quarter, 390 in January: requests and expected reports appear ahead of time, with reminders.</p></div>
    <div class="feature"><span class="tag">Norma 43 · camt.053 · CSV · PDF</span><h3>Bank statements read for you</h3><p>Bank files are parsed exactly; PDFs and scans are read by AI. Counterparty, NIF, amount, invoice and contract numbers come out of every payment.</p></div>
    <div class="feature"><span class="tag">Suggested, then confirmed</span><h3>Payments matched to invoices</h3><p>Each payment is matched to the invoices the client uploaded, by number, amount, NIF and date. Your accountant confirms or rejects every match.</p></div>
    <div class="feature"><span class="tag">SHA-256 · CSV · printable report</span><h3>An evidence log you can hand over</h3><p>Every action sits in an append-only, hash-chained log. Export it as CSV, or print a tracking report for a single document.</p></div>
    <div class="feature"><span class="tag">Full history</span><h3>Versions, never overwrites</h3><p>Replacing a file keeps the earlier version and the reason given, and asks the other side to open and confirm again.</p></div>
  </div>
</div></section>

<section class="band"><div class="wrap split">
  <div class="section-head" style="margin:0"><p class="eyebrow">For your clients</p><h2>Simple enough for clients who hate portals.</h2><p class="lead">No account to set up and no password to forget. They get a link, drop their files, and see what is still waiting on them.</p></div>
  <ul class="facts">
    <li><b>Sign in</b><span>A single-use link by email. Nothing to remember.</span></li>
    <li><b>One place</b><span>Upload documents, answer requests, approve reports.</span></li>
    <li><b>Private</b><span>Only their own company’s documents, and the colleagues they invite.</span></li>
    <li><b>Any device</b><span>Works in the browser on a phone or a laptop.</span></li>
  </ul>
</div></section>

<section class="band"><div class="wrap split">
  <div class="section-head" style="margin:0"><p class="eyebrow">Data and security</p><h2>Your clients’ data stays in the EU.</h2><p><a href="/security/">Security details</a> · <a href="/dpa/">Data processing agreement</a> · <a href="/subprocessors/">Sub-processors</a></p></div>
  <ul class="facts">
    <li><b>Hosting</b><span>Servers in Germany; files in an EU-jurisdiction object store.</span></li>
    <li><b>Retention</b><span>Files are locked against deletion for 6 years, as the Commercial Code requires.</span></li>
    <li><b>Backups</b><span>Daily, with a copy kept at a second provider.</span></li>
    <li><b>AI reading</b><span>Only for PDFs and scans. Structured bank files never leave our servers, and AI reading can be switched off.</span></li>
  </ul>
</div></section>

<section class="band"><div class="wrap closing">
  <h2>See it with your own clients’ documents.</h2>
  <p class="lead">We set up a workspace for your firm and work through the first month’s deadlines with you.</p>
  <div class="cta" style="margin-top:4px"><a class="btn primary" href="${demo('en')}">Request a demo</a></div>
  <p class="fine">Already working with a firm on Pescada? <a href="${company.appUrl}">Sign in at app.pescada.io</a></p>
</div></section>`,
  },
  {
    key: 'home', lang: 'es', path: '/es/',
    title: 'Intercambio de documentos con trazabilidad para asesorías',
    description: 'Tus clientes envían facturas y extractos; tú envías informes y declaraciones. Cada archivo queda registrado desde el envío hasta la confirmación, en un registro que nadie puede modificar.',
    body: `
<section class="hero"><div class="wrap">
  <div>
    <p class="eyebrow">Para asesorías y despachos en España</p>
    <h1 style="margin-top:18px">Ningún documento se <em>escapa</em>. Cada paso, registrado.</h1>
    <p class="lead">Pescada es donde tus clientes envían facturas, extractos bancarios y contratos, y donde tú les envías informes y declaraciones. Cada archivo queda registrado desde el envío hasta la confirmación, así que nadie puede decir que no lo recibió.</p>
    <div class="cta"><a class="btn primary" href="${demo('es')}">Solicitar una demo</a><a class="btn" href="#how">Cómo funciona</a></div>
    <p class="fine">Alojado en la UE · Contrato de encargo del tratamiento (RGPD) · Pensado para los plazos del 303, 111 y 390</p>
  </div>
  ${ledger(es.ledger)}
</div></section>

<section class="band"><div class="wrap">
  <div class="section-head"><p class="eyebrow">El problema</p><h2>Tres frases que toda asesoría ha oído.</h2></div>
  <div class="excuses">
    <div class="excuse"><q>No me ha llegado.</q><p>Pescada muestra cuándo llegó el archivo, cuándo el aviso llegó a su bandeja de entrada y cuándo lo abrió. Solo se puede confirmar la recepción después de abrirlo.</p></div>
    <div class="excuse"><q>No me lo enviaste.</q><p>Cada archivo se registra con su huella digital y su hora en un registro que no se puede modificar después. Tu cliente ve el mismo registro que tú.</p></div>
    <div class="excuse"><q>Se fue a spam.</q><p>El servidor de correo del destinatario informa: entregado, rebotado o marcado como spam. Lo que queda sin abrir recibe un recordatorio automático.</p></div>
  </div>
</div></section>

<section class="band" id="how"><div class="wrap">
  <div class="section-head"><p class="eyebrow">Cómo funciona</p><h2>Del envío a la confirmación, en cuatro pasos registrados.</h2></div>
  <ol class="flow">
    <li><h3>Enviado</h3><p>El cliente sube sus archivos a su espacio privado, o tú envías un informe con su fecha límite.</p></li>
    <li><h3>Notificado</h3><p>La otra parte recibe un correo. Entregas, rebotes y avisos de spam quedan en el registro.</p></li>
    <li><h3>Abierto</h3><p>Cada apertura y descarga queda registrada, versión a versión, con la persona y la hora.</p></li>
    <li><h3>Confirmado</h3><p>La recepción o la aprobación se confirma con un clic, y solo después de haber abierto el archivo.</p></li>
  </ol>
</div></section>

<section class="band" id="product"><div class="wrap">
  <div class="section-head"><p class="eyebrow">Producto</p><h2>Hecho para cómo trabaja de verdad una asesoría en España.</h2></div>
  <div class="features">
    <div class="feature"><span class="tag">Una asesoría, todos sus clientes</span><h3>Un espacio para cada cliente</h3><p>Cada empresa tiene su propio espacio y puede invitar a su personal. Los clientes nunca se ven entre sí; tu equipo los ve a todos.</p></div>
    <div class="feature"><span class="tag">Mensual · trimestral · anual</span><h3>Plazos que se abren solos</h3><p>Extractos cada mes, 303 y 111 cada trimestre, 390 en enero: las solicitudes y los informes previstos aparecen con antelación, con recordatorios.</p></div>
    <div class="feature"><span class="tag">Norma 43 · camt.053 · CSV · PDF</span><h3>Extractos bancarios leídos por ti</h3><p>Los ficheros bancarios se procesan de forma exacta; los PDF y escaneos los lee la IA. De cada movimiento salen contraparte, NIF, importe y números de factura y contrato.</p></div>
    <div class="feature"><span class="tag">Propuesto y luego confirmado</span><h3>Cobros y pagos casados con facturas</h3><p>Cada movimiento se casa con las facturas que subió el cliente por número, importe, NIF y fecha. Tu equipo confirma o rechaza cada propuesta.</p></div>
    <div class="feature"><span class="tag">SHA-256 · CSV · informe imprimible</span><h3>Un registro que sirve como prueba</h3><p>Cada acción queda en un registro encadenado al que solo se pueden añadir entradas. Se exporta en CSV o como informe imprimible de un documento.</p></div>
    <div class="feature"><span class="tag">Historial completo</span><h3>Versiones, nunca sobrescrituras</h3><p>Al sustituir un archivo se conserva la versión anterior y el motivo, y se pide a la otra parte que vuelva a abrirlo y confirmarlo.</p></div>
  </div>
</div></section>

<section class="band"><div class="wrap split">
  <div class="section-head" style="margin:0"><p class="eyebrow">Para tus clientes</p><h2>Sencillo incluso para quien odia los portales.</h2><p class="lead">Sin cuenta que configurar ni contraseña que olvidar. Reciben un enlace, suben sus archivos y ven qué les queda pendiente.</p></div>
  <ul class="facts">
    <li><b>Acceso</b><span>Un enlace de un solo uso por correo. Nada que recordar.</span></li>
    <li><b>Un único sitio</b><span>Subir documentos, responder solicitudes, aprobar informes.</span></li>
    <li><b>Privado</b><span>Solo los documentos de su empresa y los compañeros que inviten.</span></li>
    <li><b>Cualquier dispositivo</b><span>Funciona en el navegador del móvil o del portátil.</span></li>
  </ul>
</div></section>

<section class="band"><div class="wrap split">
  <div class="section-head" style="margin:0"><p class="eyebrow">Datos y seguridad</p><h2>Los datos de tus clientes se quedan en la UE.</h2><p><a href="/es/seguridad/">Seguridad</a> · <a href="/es/dpa/">Encargo del tratamiento</a> · <a href="/es/subencargados/">Subencargados</a></p></div>
  <ul class="facts">
    <li><b>Alojamiento</b><span>Servidores en Alemania; archivos en un almacenamiento con jurisdicción UE.</span></li>
    <li><b>Conservación</b><span>Los archivos están bloqueados contra borrado durante 6 años, como exige el Código de Comercio.</span></li>
    <li><b>Copias</b><span>Diarias, con una copia en un segundo proveedor.</span></li>
    <li><b>Lectura con IA</b><span>Solo para PDF y escaneos. Los ficheros bancarios estructurados no salen de nuestros servidores, y la lectura con IA se puede desactivar.</span></li>
  </ul>
</div></section>

<section class="band"><div class="wrap closing">
  <h2>Pruébalo con los documentos de tus propios clientes.</h2>
  <p class="lead">Configuramos un espacio para tu asesoría y preparamos contigo los plazos del primer mes.</p>
  <div class="cta" style="margin-top:4px"><a class="btn primary" href="${demo('es')}">Solicitar una demo</a></div>
  <p class="fine">¿Ya trabajas con una asesoría en Pescada? <a href="${company.appUrl}">Accede en app.pescada.io</a></p>
</div></section>`,
  },
];
