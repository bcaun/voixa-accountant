import { company as c } from '../company.mjs';

const table = (head, rows) => `<div class="table"><table><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((d) => `<td>${d}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;

export const pages = [
  {
    key: 'dpa', lang: 'en', path: '/dpa/', navTitle: 'Data Processing Agreement',
    title: 'Data Processing Agreement',
    description: 'GDPR Article 28 agreement between Pescada and the accounting firms that use it.',
    body: `
<p>This agreement under GDPR Article 28 and Spanish Organic Law 3/2018 (LOPDGDD) article 33 forms part of the <a href="/terms/">Terms of Service</a> between ${c.legalName}, tax ID ${c.taxId} (“Pescada”, the processor), and the Customer. It applies whenever Pescada processes personal data on the Customer’s behalf.</p>
<p>Where the Customer is itself a processor for its own clients (as an accounting firm usually is), Pescada acts as its sub-processor and the Customer confirms it is authorised by its clients to engage Pescada on these terms.</p>

<h2>1. Subject, duration and purpose</h2>
<p>Pescada processes personal data only to provide the service described in the Terms: storing and exchanging documents, keeping the activity log, sending notifications and reminders, and reading documents to extract accounting data and match payments to invoices. The agreement lasts as long as the Terms and any retention the law requires afterwards.</p>

<h2>2. Data and data subjects</h2>
${table(['Data subjects', 'Personal data'], [
  ['Users at the Customer and at its clients', 'Name, email, company, role, activity in the portal'],
  ['Employees of the Customer’s clients', 'Data in payroll and tax documents: name, tax ID, social security number, bank account, salary'],
  ['Customers and suppliers who are individuals or sole traders', 'Name, tax ID, address, amounts invoiced or paid, bank account'],
  ['Partners, directors and signatories', 'Name, ID document number, address, signature'],
])}
<p>The service is not designed for special categories of data (GDPR Article 9). The Customer will not upload such data unless agreed in writing.</p>

<h2>3. Pescada’s obligations</h2>
<ol>
  <li>Process personal data only on the Customer’s documented instructions, which are these terms and the Customer’s use of the service, and tell the Customer if an instruction appears to infringe data protection law.</li>
  <li>Ensure that everyone authorised to process the data is bound by confidentiality.</li>
  <li>Apply the measures described on the <a href="/security/">Security</a> page, which forms Annex 2 of this agreement.</li>
  <li>Engage only the sub-processors listed on the <a href="/subprocessors/">Sub-processors</a> page (Annex 1), under written terms imposing the same obligations. Give at least 30 days’ notice of any new or replaced sub-processor; the Customer may object on reasonable data-protection grounds and, if we cannot address the objection, end the contract before the change applies.</li>
  <li>Help the Customer answer requests from data subjects and meet its obligations under GDPR Articles 32 to 36, taking into account the information available to Pescada.</li>
  <li>Notify the Customer of a personal data breach without undue delay, and in any case within 48 hours of becoming aware of it, with the information then available.</li>
  <li>Make available the information needed to demonstrate compliance and allow audits, including inspections, by the Customer or an auditor it appoints, with 30 days’ notice and at most once a year unless a breach or a supervisory authority requires otherwise.</li>
  <li>Keep a record of processing activities as required by GDPR Article 30(2).</li>
</ol>

<h2>4. International transfers</h2>
<p>Customer data is hosted in the European Union. Where a sub-processor outside the European Economic Area processes it, the transfer relies on an adequacy decision, including the EU-US Data Privacy Framework, or on the European Commission’s Standard Contractual Clauses, as listed in Annex 1.</p>

<h2>5. Customer’s obligations</h2>
<p>The Customer confirms it has a lawful basis for the data it and its clients upload, gives data subjects the information the law requires, and keeps the list of people with access up to date.</p>

<h2>6. Automated reading</h2>
<p>The Customer instructs Pescada to read bank statements and invoices automatically, including with the AI provider listed in Annex 1 for PDFs and images. The Customer can ask us to switch AI reading off for its account; structured bank files (Norma 43, camt.053, CSV) are always read on Pescada’s own servers.</p>

<h2>7. The activity log as evidence</h2>
<p>The Customer acknowledges that the activity log is hash-chained and append-only, and that the tracking reports exported from it record the sending, notification, opening and confirmation of documents. The Customer may rely on them as evidence of those events with its clients.</p>

<h2>8. End of the service</h2>
<p>When the contract ends, the Customer can export its documents and activity log for 30 days. Pescada then deletes the Customer’s personal data, including copies, except where Spanish or EU law requires it to be kept. Documents are stored under a lock that prevents deletion for 6 years from upload, so that records required by the Commercial Code (article 30) are preserved; until the lock expires they are kept blocked and used for no other purpose, and they are deleted when it expires.</p>

<h2>9. Liability and governing law</h2>
<p>Liability follows the Terms of Service and GDPR Article 82. This agreement is governed by Spanish law and the courts of ${c.courtsCity} have jurisdiction.</p>`,
  },
  {
    key: 'dpa', lang: 'es', path: '/es/dpa/', navTitle: 'Encargo del tratamiento',
    title: 'Contrato de encargo del tratamiento',
    description: 'Contrato del artículo 28 del RGPD entre Pescada y las asesorías que lo utilizan.',
    body: `
<p>Este contrato, conforme al artículo 28 del RGPD y al artículo 33 de la Ley Orgánica 3/2018 (LOPDGDD), forma parte de las <a href="/es/terminos/">Condiciones de uso</a> entre ${c.legalName}, NIF ${c.taxId} («Pescada», el encargado), y el Cliente. Se aplica siempre que Pescada trate datos personales por cuenta del Cliente.</p>
<p>Cuando el Cliente sea a su vez encargado del tratamiento de sus propios clientes (como suele ocurrir con una asesoría), Pescada actúa como subencargado y el Cliente confirma que sus clientes le autorizan a contratar a Pescada en estos términos.</p>

<h2>1. Objeto, duración y finalidad</h2>
<p>Pescada trata datos personales solo para prestar el servicio descrito en las Condiciones: guardar e intercambiar documentos, mantener el registro de actividad, enviar avisos y recordatorios, y leer documentos para extraer datos contables y casar cobros y pagos con facturas. El contrato dura lo mismo que las Condiciones y la conservación que la ley exija después.</p>

<h2>2. Datos e interesados</h2>
${table(['Interesados', 'Datos personales'], [
  ['Usuarios del Cliente y de sus clientes', 'Nombre, correo, empresa, función, actividad en el portal'],
  ['Empleados de los clientes del Cliente', 'Datos de documentos laborales y fiscales: nombre, NIF, número de la Seguridad Social, cuenta bancaria, salario'],
  ['Clientes y proveedores que son personas físicas o autónomos', 'Nombre, NIF, domicilio, importes facturados o pagados, cuenta bancaria'],
  ['Socios, administradores y firmantes', 'Nombre, número de documento de identidad, domicilio, firma'],
])}
<p>El servicio no está diseñado para categorías especiales de datos (artículo 9 del RGPD). El Cliente no subirá este tipo de datos salvo acuerdo por escrito.</p>

<h2>3. Obligaciones de Pescada</h2>
<ol>
  <li>Tratar los datos personales solo según las instrucciones documentadas del Cliente, que son estos términos y el uso que el Cliente haga del servicio, e informarle si una instrucción parece infringir la normativa de protección de datos.</li>
  <li>Garantizar que todas las personas autorizadas a tratar los datos están obligadas a la confidencialidad.</li>
  <li>Aplicar las medidas descritas en la página de <a href="/es/seguridad/">Seguridad</a>, que constituye el Anexo 2 de este contrato.</li>
  <li>Recurrir únicamente a los subencargados que figuran en la página de <a href="/es/subencargados/">Subencargados</a> (Anexo 1), mediante contratos por escrito que impongan las mismas obligaciones. Avisar con al menos 30 días de antelación de cualquier subencargado nuevo o sustituido; el Cliente podrá oponerse por motivos razonables de protección de datos y, si no podemos atender la objeción, resolver el contrato antes de que se aplique el cambio.</li>
  <li>Ayudar al Cliente a responder a las solicitudes de los interesados y a cumplir sus obligaciones de los artículos 32 a 36 del RGPD, teniendo en cuenta la información de que disponga Pescada.</li>
  <li>Notificar al Cliente cualquier violación de la seguridad de los datos personales sin dilación indebida y, en todo caso, en un plazo de 48 horas desde que tenga conocimiento, con la información disponible en ese momento.</li>
  <li>Poner a disposición del Cliente la información necesaria para demostrar el cumplimiento y permitir auditorías, incluidas inspecciones, por el Cliente o un auditor designado por él, con 30 días de preaviso y como máximo una vez al año, salvo que una violación de seguridad o una autoridad de control exijan otra cosa.</li>
  <li>Llevar el registro de actividades de tratamiento exigido por el artículo 30.2 del RGPD.</li>
</ol>

<h2>4. Transferencias internacionales</h2>
<p>Los datos del Cliente se alojan en la Unión Europea. Cuando un subencargado situado fuera del Espacio Económico Europeo los trate, la transferencia se basa en una decisión de adecuación, incluido el Marco de Privacidad de Datos UE-EE. UU., o en las Cláusulas Contractuales Tipo de la Comisión Europea, según se indica en el Anexo 1.</p>

<h2>5. Obligaciones del Cliente</h2>
<p>El Cliente confirma que dispone de base jurídica para los datos que él y sus clientes suben, informa a los interesados como exige la ley y mantiene actualizada la lista de personas con acceso.</p>

<h2>6. Lectura automática</h2>
<p>El Cliente encarga a Pescada la lectura automática de extractos bancarios y facturas, incluida la lectura de PDF e imágenes por el proveedor de IA que figura en el Anexo 1. El Cliente puede pedirnos que desactivemos la lectura con IA en su cuenta; los ficheros bancarios estructurados (Norma 43, camt.053, CSV) se leen siempre en los servidores de Pescada.</p>

<h2>7. El registro de actividad como prueba</h2>
<p>El Cliente reconoce que el registro de actividad está encadenado y solo admite nuevas entradas, y que los informes exportados de él recogen el envío, el aviso, la apertura y la confirmación de los documentos. El Cliente puede utilizarlos como prueba de esos hechos ante sus clientes.</p>

<h2>8. Fin del servicio</h2>
<p>Al terminar el contrato, el Cliente puede exportar sus documentos y su registro de actividad durante 30 días. Después, Pescada suprime los datos personales del Cliente, incluidas las copias, salvo que la normativa española o de la UE exija conservarlos. Los documentos se guardan con un bloqueo que impide su borrado durante 6 años desde la subida, para preservar los registros exigidos por el Código de Comercio (artículo 30); hasta que vence el bloqueo se conservan bloqueados y no se usan para ningún otro fin, y se suprimen al vencer.</p>

<h2>9. Responsabilidad y ley aplicable</h2>
<p>La responsabilidad se rige por las Condiciones de uso y el artículo 82 del RGPD. Este contrato se rige por la ley española y son competentes los juzgados y tribunales de ${c.courtsCity}.</p>`,
  },
];
