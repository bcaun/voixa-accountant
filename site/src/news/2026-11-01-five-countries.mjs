const table = (head, rows) => `<div class="table"><table><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((d, i) => (i ? `<td>${d}</td>` : `<th scope="row">${d}</th>`)).join('')}</tr>`).join('')}</tbody></table></div>`;

export const post = {
  date: '2026-11-01',
  tag: { en: 'Product', es: 'Producto' },
  slug: { en: 'italy-france-germany-portugal', es: 'italia-francia-alemania-portugal' },
  title: {
    en: 'Pescada now works in Italy, France, Germany and Portugal',
    es: 'Pescada ya funciona en Italia, Francia, Alemania y Portugal',
  },
  summary: {
    en: 'Accounting firms in five countries can now run their client document exchange on Pescada. Each client follows its own country’s tax IDs, deadlines and e-invoice formats, and national e-invoices and bank files are read exactly, without AI.',
    es: 'Las asesorías de cinco países ya pueden gestionar con Pescada el intercambio de documentos con sus clientes. Cada cliente sigue los NIF, plazos y formatos de factura electrónica de su país, y las facturas electrónicas y ficheros bancarios nacionales se leen de forma exacta, sin IA.',
  },
  body: {
    en: `
<p>Pescada started with accounting firms in Spain. From today it also supports firms and their clients in <b>Italy, France, Germany and Portugal</b>. A firm in Milan, Lyon, Munich or Porto gets the same thing a firm in Barcelona does: one place where clients send invoices, bank statements and contracts, the firm sends reports and filings, and every step is recorded from sent to confirmed.</p>

<h2>Every firm has its own space</h2>
<p>Each accounting firm on Pescada has its own clients, its own accountants and its own client numbering. Accountants see only their firm’s clients, and every email a client receives carries the firm’s name. Clients still see only their own company’s documents.</p>

<h2>Every client has a country</h2>
<p>When a firm adds a client, it chooses the client’s country. It defaults to the firm’s own, and a firm can have clients in several countries. The country decides:</p>
${table(['Country', 'Tax ID checked', 'Deadlines counted in', 'Read exactly, without AI'], [
  ['Italy', 'Partita IVA, Codice Fiscale', 'Rome time', 'FatturaPA e-invoices, including signed .p7m files; camt.053 and CSV bank files'],
  ['France', 'SIREN, SIRET, VAT number', 'Paris time', 'Factur-X invoices (the data inside the PDF), UBL and CII; CFONB 120, camt.053 and CSV bank files'],
  ['Germany', 'USt-IdNr., Steuernummer', 'Berlin time', 'XRechnung (UBL and CII) and ZUGFeRD invoices; MT940, camt.053 and CSV bank files'],
  ['Portugal', 'NIF / NIPC', 'Lisbon time', 'UBL invoices; camt.053 and CSV bank files'],
  ['Spain', 'NIF, CIF, NIE', 'Madrid time', 'Norma 43, camt.053 and CSV bank files'],
])}
<p>Tax IDs are checked with their check digits when a client is added, so a mistyped Partita IVA or NIF is caught at once.</p>

<h2>E-invoices are read exactly</h2>
<p>When a client uploads an Italian FatturaPA, a German XRechnung or a French Factur-X, Pescada reads the invoice number, the supplier and customer with their tax IDs, the dates, the taxable base, the VAT and the total straight from the structured data. Nothing is guessed and no AI is used. Bank files in the national formats are read the same way. Scans and ordinary PDFs are still read by AI, as before.</p>
<p>Payments are then matched to invoices by invoice number, amount, tax ID, counterparty and date. Bank wording is understood in Italian, French, German, Portuguese, Spanish and English, so “bonifico a favore di”, “virement reçu de” or “SEPA-Überweisung an” all lead to the right counterparty. The accountant confirms or rejects each match, and every decision goes into the log.</p>

<h2>Deadline templates for each country</h2>
<p>Recurring deadlines create the request or the expected report before each due date and send reminders. Each country comes with templates to start from: F24, Certificazione Unica and Modello 770 in Italy; CA3 and DSN in France; Umsatzsteuer-Voranmeldung, Lohnsteuer-Anmeldung and Zusammenfassende Meldung in Germany; the periodic VAT return, DMR and Modelo 22 in Portugal. Deadlines can also fall in the second or third month after the period, as Portugal’s VAT return does.</p>
<p>The templates are starting points. Some dates move with weekends or depend on the company, and the firm sets the final date for each client.</p>

<h2>What stays the same</h2>
<p>Documents are stored in the EU with a six-year lock against deletion. Every action is written to a log that cannot be edited, and the log can be exported as evidence. Clients sign in with a one-time link, with no password to remember.</p>

<h2>Coming next</h2>
<p>The Pescada app and its emails are in English today. Italian, French, German, Portuguese and Spanish versions are the next step.</p>

<h2>How to start</h2>
<p>Accounting firms in any of the five countries can <a href="mailto:hello@pescada.io?subject=Pescada%20demo">request a demo</a>. We set up a workspace for the firm and plan the first month’s deadlines together.</p>`,
    es: `
<p>Pescada nació con asesorías en España. Desde hoy también da servicio a despachos y a sus clientes en <b>Italia, Francia, Alemania y Portugal</b>. Una asesoría en Milán, Lyon, Múnich u Oporto tiene lo mismo que una de Barcelona: un único sitio donde los clientes envían facturas, extractos y contratos, el despacho envía informes y declaraciones, y cada paso queda registrado desde el envío hasta la confirmación.</p>

<h2>Cada asesoría tiene su propio espacio</h2>
<p>Cada despacho en Pescada tiene sus propios clientes, su propio equipo y su propia numeración de clientes. Los asesores solo ven los clientes de su despacho, y cada correo que recibe un cliente lleva el nombre de su asesoría. Los clientes siguen viendo solo los documentos de su empresa.</p>

<h2>Cada cliente tiene un país</h2>
<p>Al dar de alta un cliente, la asesoría elige su país. Por defecto es el de la propia asesoría, y un despacho puede tener clientes en varios países. El país determina:</p>
${table(['País', 'Identificación fiscal comprobada', 'Plazos en hora de', 'Se lee de forma exacta, sin IA'], [
  ['Italia', 'Partita IVA, Codice Fiscale', 'Roma', 'Facturas electrónicas FatturaPA, también firmadas (.p7m); ficheros bancarios camt.053 y CSV'],
  ['Francia', 'SIREN, SIRET, número de IVA', 'París', 'Facturas Factur-X (los datos dentro del PDF), UBL y CII; ficheros CFONB 120, camt.053 y CSV'],
  ['Alemania', 'USt-IdNr., Steuernummer', 'Berlín', 'Facturas XRechnung (UBL y CII) y ZUGFeRD; ficheros MT940, camt.053 y CSV'],
  ['Portugal', 'NIF / NIPC', 'Lisboa', 'Facturas UBL; ficheros camt.053 y CSV'],
  ['España', 'NIF, CIF, NIE', 'Madrid', 'Ficheros Norma 43, camt.053 y CSV'],
])}
<p>Los números fiscales se comprueban con su dígito de control al dar de alta el cliente, así que una Partita IVA o un NIF mal escritos se detectan en el momento.</p>

<h2>Las facturas electrónicas se leen de forma exacta</h2>
<p>Cuando un cliente sube una FatturaPA italiana, una XRechnung alemana o una Factur-X francesa, Pescada toma el número de factura, el proveedor y el cliente con sus números fiscales, las fechas, la base imponible, el IVA y el total directamente de los datos estructurados. No se adivina nada ni se usa IA. Los ficheros bancarios en formato nacional se leen igual. Los escaneos y los PDF normales los sigue leyendo la IA, como hasta ahora.</p>
<p>Después, los cobros y pagos se casan con las facturas por número, importe, número fiscal, contraparte y fecha. Pescada entiende la redacción bancaria en italiano, francés, alemán, portugués, español e inglés: «bonifico a favore di», «virement reçu de» o «SEPA-Überweisung an» llevan a la contraparte correcta. El asesor confirma o rechaza cada propuesta, y cada decisión queda en el registro.</p>

<h2>Plantillas de plazos para cada país</h2>
<p>Los plazos recurrentes crean la solicitud o el informe previsto antes de cada vencimiento y envían recordatorios. Cada país incluye plantillas de partida: F24, Certificazione Unica y Modello 770 en Italia; CA3 y DSN en Francia; Umsatzsteuer-Voranmeldung, Lohnsteuer-Anmeldung y Zusammenfassende Meldung en Alemania; la declaración periódica de IVA, la DMR y el Modelo 22 en Portugal. Los plazos también pueden caer en el segundo o tercer mes después del periodo, como la declaración de IVA portuguesa.</p>
<p>Las plantillas son un punto de partida. Algunas fechas se mueven con los fines de semana o dependen de la empresa, y la asesoría fija la fecha final de cada cliente.</p>

<h2>Lo que no cambia</h2>
<p>Los documentos se guardan en la UE con un bloqueo de seis años contra el borrado. Cada acción se escribe en un registro que no se puede modificar y que se puede exportar como prueba. Los clientes acceden con un enlace de un solo uso, sin contraseñas que recordar.</p>

<h2>Próximamente</h2>
<p>La aplicación de Pescada y sus correos están hoy en inglés. Las versiones en italiano, francés, alemán, portugués y español son el siguiente paso.</p>

<h2>Cómo empezar</h2>
<p>Las asesorías de cualquiera de los cinco países pueden <a href="mailto:hello@pescada.io?subject=Demo%20de%20Pescada">solicitar una demo</a>. Configuramos un espacio para el despacho y preparamos juntos los plazos del primer mes.</p>`,
  },
};
