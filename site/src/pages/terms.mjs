import { company as c } from '../company.mjs';

export const pages = [
  {
    key: 'terms', lang: 'en', path: '/terms/', navTitle: 'Terms of Service',
    title: 'Terms of Service',
    description: 'Terms under which accounting firms use Pescada.',
    body: `
<p>These terms apply between ${c.legalName}, tax ID ${c.taxId} (“Pescada”, “we”), and the accounting firm or other business that signs up for Pescada (the “Customer”). Pescada is offered to businesses only, not to consumers. An order form or proposal accepted by the Customer sets the plan and fees; if it conflicts with these terms, the order form prevails.</p>

<h2>1. The service</h2>
<p>Pescada is an online portal where the Customer exchanges documents with its own clients, tracks each document from sending to confirmation, keeps an activity log, receives reminders for recurring deadlines, and can have bank statements and invoices read automatically and matched.</p>

<h2>2. Accounts and users</h2>
<ul>
  <li>The Customer decides who gets access: its own staff and the people it invites at each of its clients. It is responsible for their use of the service and for removing access when someone leaves.</li>
  <li>Sign-in is by single-use links sent by email. The Customer keeps its users’ email accounts secure and tells us without delay about any unauthorised access it suspects.</li>
</ul>

<h2>3. Customer data</h2>
<p>Documents and data uploaded to Pescada belong to the Customer or its clients. We use them only to provide the service, as set out in the <a href="/dpa/">Data Processing Agreement</a>, which forms part of these terms.</p>

<h2>4. Acceptable use</h2>
<p>The Customer will not upload unlawful content or malware, try to access other customers’ data, test the service’s security without our written permission, or resell the service without agreement.</p>

<h2>5. Automated reading</h2>
<p>Data extracted from documents and suggested matches between payments and invoices are aids to the Customer’s work. Some are produced by AI and can contain errors. The Customer reviews them before relying on them for accounting entries, filings or advice.</p>

<h2>6. The activity log</h2>
<p>The log records events that happen in Pescada: uploads, deliveries, notifications reported by the mail provider, openings, downloads, confirmations and notes, with their time and author. It does not record what happens outside Pescada, for example whether someone read an email.</p>

<h2>7. Availability and support</h2>
<p>We make reasonable efforts to keep Pescada available and to announce planned maintenance in advance. Support is by email at <a href="mailto:${c.contactEmail}">${c.contactEmail}</a> on Spanish working days. Any service levels or response times beyond this apply only if agreed in the order form.</p>

<h2>8. Fees</h2>
<p>Fees are set in the order form, exclude VAT and are invoiced monthly in advance unless agreed otherwise. If an invoice is more than 30 days overdue, we may suspend access after giving 10 days’ notice.</p>

<h2>9. Confidentiality and intellectual property</h2>
<p>Each party keeps the other’s non-public information confidential. We own Pescada and its software; the Customer receives a right to use it for its business during the contract.</p>

<h2>10. Liability</h2>
<p>Neither party is liable for indirect or consequential loss or lost profits. Each party’s total liability under these terms in any 12 months is limited to the fees paid by the Customer in those 12 months. These limits do not apply to wilful misconduct, gross negligence, or anything the law does not allow to be limited.</p>

<h2>11. Term and termination</h2>
<p>The contract runs month to month unless the order form says otherwise, and either party can end it with 30 days’ notice. After it ends, the Customer can export its documents and activity log for 30 days. Data is then handled as set out in the Data Processing Agreement, including retention the law requires.</p>

<h2>12. Changes to these terms</h2>
<p>We give at least 30 days’ notice by email of changes that affect the Customer. If the Customer does not accept a change, it can end the contract before the change applies.</p>

<h2>13. Law and courts</h2>
<p>These terms are governed by Spanish law. The courts of ${c.courtsCity} have jurisdiction.</p>`,
  },
  {
    key: 'terms', lang: 'es', path: '/es/terminos/', navTitle: 'Condiciones de uso',
    title: 'Condiciones de uso',
    description: 'Condiciones en las que las asesorías usan Pescada.',
    body: `
<p>Estas condiciones se aplican entre ${c.legalName}, NIF ${c.taxId} («Pescada», «nosotros»), y la asesoría u otra empresa que contrata Pescada (el «Cliente»). Pescada se ofrece solo a empresas y profesionales, no a consumidores. El pedido o la propuesta aceptada por el Cliente fija el plan y las tarifas; si contradice estas condiciones, prevalece el pedido.</p>

<h2>1. El servicio</h2>
<p>Pescada es un portal en línea en el que el Cliente intercambia documentos con sus propios clientes, sigue cada documento desde el envío hasta la confirmación, conserva un registro de actividad, recibe recordatorios de plazos periódicos y puede leer y casar automáticamente extractos bancarios y facturas.</p>

<h2>2. Cuentas y usuarios</h2>
<ul>
  <li>El Cliente decide quién tiene acceso: su propio personal y las personas que invita en cada uno de sus clientes. Es responsable del uso que hagan del servicio y de retirar el acceso cuando alguien deja de necesitarlo.</li>
  <li>El acceso se realiza mediante enlaces de un solo uso enviados por correo. El Cliente mantiene seguras las cuentas de correo de sus usuarios y nos avisa sin demora de cualquier acceso no autorizado que sospeche.</li>
</ul>

<h2>3. Datos del Cliente</h2>
<p>Los documentos y datos subidos a Pescada pertenecen al Cliente o a sus clientes. Solo los usamos para prestar el servicio, según el <a href="/es/dpa/">Contrato de encargo del tratamiento</a>, que forma parte de estas condiciones.</p>

<h2>4. Uso aceptable</h2>
<p>El Cliente no subirá contenido ilícito ni software malicioso, no intentará acceder a datos de otros clientes, no pondrá a prueba la seguridad del servicio sin nuestra autorización por escrito y no revenderá el servicio sin acuerdo.</p>

<h2>5. Lectura automática</h2>
<p>Los datos extraídos de los documentos y las propuestas de casación entre movimientos y facturas son una ayuda para el trabajo del Cliente. Algunos los genera la IA y pueden contener errores. El Cliente los revisa antes de basar en ellos asientos contables, declaraciones o asesoramiento.</p>

<h2>6. El registro de actividad</h2>
<p>El registro recoge los hechos que ocurren en Pescada: subidas, entregas, avisos comunicados por el proveedor de correo, aperturas, descargas, confirmaciones y notas, con su hora y su autor. No recoge lo que ocurre fuera de Pescada, por ejemplo si alguien leyó un correo.</p>

<h2>7. Disponibilidad y soporte</h2>
<p>Hacemos esfuerzos razonables para mantener Pescada disponible y anunciar con antelación el mantenimiento previsto. El soporte se presta por correo en <a href="mailto:${c.contactEmail}">${c.contactEmail}</a> en días laborables en España. Otros niveles de servicio o plazos de respuesta solo se aplican si se pactan en el pedido.</p>

<h2>8. Tarifas</h2>
<p>Las tarifas se fijan en el pedido, no incluyen el IVA y se facturan mensualmente por adelantado salvo otro acuerdo. Si una factura lleva más de 30 días vencida, podemos suspender el acceso con 10 días de preaviso.</p>

<h2>9. Confidencialidad y propiedad intelectual</h2>
<p>Cada parte guarda la confidencialidad de la información no pública de la otra. Pescada y su software son nuestros; el Cliente recibe un derecho de uso para su actividad mientras dure el contrato.</p>

<h2>10. Responsabilidad</h2>
<p>Ninguna de las partes responde de daños indirectos ni del lucro cesante. La responsabilidad total de cada parte en virtud de estas condiciones en un periodo de 12 meses se limita a las tarifas pagadas por el Cliente en esos 12 meses. Estos límites no se aplican al dolo, la culpa grave ni a lo que la ley no permita limitar.</p>

<h2>11. Duración y resolución</h2>
<p>El contrato es mensual salvo que el pedido diga otra cosa, y cualquiera de las partes puede resolverlo con 30 días de preaviso. Tras la resolución, el Cliente puede exportar sus documentos y su registro de actividad durante 30 días. Después, los datos se tratan según el Contrato de encargo del tratamiento, incluida la conservación que exija la ley.</p>

<h2>12. Cambios en estas condiciones</h2>
<p>Avisamos por correo con al menos 30 días de antelación de los cambios que afecten al Cliente. Si el Cliente no acepta un cambio, puede resolver el contrato antes de que se aplique.</p>

<h2>13. Ley y jurisdicción</h2>
<p>Estas condiciones se rigen por la ley española. Son competentes los juzgados y tribunales de ${c.courtsCity}.</p>`,
  },
];
