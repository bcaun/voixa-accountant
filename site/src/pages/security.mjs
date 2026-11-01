import { company as c } from '../company.mjs';

const table = (head, rows) => `<div class="table"><table><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((d) => `<td>${d}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;

export const pages = [
  {
    key: 'security', lang: 'en', path: '/security/', navTitle: 'Security',
    title: 'Security',
    description: 'How Pescada protects documents and keeps a record that cannot be altered.',
    body: `
<p>These are the technical and organisational measures in place today. This page is Annex 2 of our <a href="/dpa/">Data Processing Agreement</a>.</p>
${table(['Area', 'Measure'], [
  ['Separation of customers and clients', 'Every client company has its own workspace. Access is checked on every request, and automated tests confirm that one client cannot reach another’s documents.'],
  ['Sign-in', 'No passwords: single-use email links valid for 30 minutes. Sessions are stored only as SHA-256 hashes. Requests from other websites are refused.'],
  ['Encryption in transit', 'HTTPS everywhere, with automatically renewed certificates and HSTS.'],
  ['Integrity of the record', 'Every action is written to an append-only log. Each entry includes the SHA-256 hash of the previous one, and the database refuses edits and deletions of the log. Every file gets a SHA-256 fingerprint on upload.'],
  ['Storage', 'Documents are kept in EU-jurisdiction object storage with a 6-year lock against deletion or overwrite.'],
  ['Backups', 'Daily backup of the whole server, and a daily database copy sent to a second provider every 6 hours and kept 90 days.'],
  ['Server access', 'SSH keys only, password login disabled; firewall open only for SSH, HTTP and HTTPS; brute-force protection; automatic security updates.'],
  ['Secrets', 'Keys and passwords live only on the server, never in the code repository.'],
  ['Monitoring', 'External availability check every 5 minutes, with alerts.'],
])}
<h2>Reporting a vulnerability</h2>
<p>If you find a security problem, write to <a href="mailto:${c.contactEmail}">${c.contactEmail}</a>. Please do not test against other customers’ data. We reply within two working days.</p>`,
  },
  {
    key: 'security', lang: 'es', path: '/es/seguridad/', navTitle: 'Seguridad',
    title: 'Seguridad',
    description: 'Cómo protege Pescada los documentos y mantiene un registro que no se puede alterar.',
    body: `
<p>Estas son las medidas técnicas y organizativas aplicadas actualmente. Esta página es el Anexo 2 de nuestro <a href="/es/dpa/">Contrato de encargo del tratamiento</a>.</p>
${table(['Ámbito', 'Medida'], [
  ['Separación de clientes', 'Cada empresa cliente tiene su propio espacio. El acceso se comprueba en cada solicitud y hay pruebas automáticas que verifican que un cliente no puede llegar a los documentos de otro.'],
  ['Acceso', 'Sin contraseñas: enlaces de un solo uso por correo, válidos 30 minutos. Las sesiones se guardan solo como hash SHA-256. Se rechazan las solicitudes procedentes de otros sitios web.'],
  ['Cifrado en tránsito', 'HTTPS en todo el servicio, con certificados renovados automáticamente y HSTS.'],
  ['Integridad del registro', 'Cada acción se escribe en un registro al que solo se pueden añadir entradas. Cada entrada incluye el hash SHA-256 de la anterior, y la base de datos rechaza modificaciones y borrados del registro. Cada archivo recibe una huella SHA-256 al subirse.'],
  ['Almacenamiento', 'Los documentos se guardan en un almacenamiento de objetos con jurisdicción UE, con un bloqueo de 6 años contra borrado o sobrescritura.'],
  ['Copias de seguridad', 'Copia diaria de todo el servidor y copia diaria de la base de datos enviada a un segundo proveedor cada 6 horas y conservada 90 días.'],
  ['Acceso al servidor', 'Solo con claves SSH, acceso por contraseña desactivado; cortafuegos abierto solo para SSH, HTTP y HTTPS; protección contra ataques de fuerza bruta; actualizaciones de seguridad automáticas.'],
  ['Secretos', 'Las claves y contraseñas están solo en el servidor, nunca en el repositorio de código.'],
  ['Supervisión', 'Comprobación externa de disponibilidad cada 5 minutos, con alertas.'],
])}
<h2>Comunicar una vulnerabilidad</h2>
<p>Si encuentras un problema de seguridad, escribe a <a href="mailto:${c.contactEmail}">${c.contactEmail}</a>. Por favor, no hagas pruebas con datos de otros clientes. Respondemos en un plazo de dos días laborables.</p>`,
  },
];
