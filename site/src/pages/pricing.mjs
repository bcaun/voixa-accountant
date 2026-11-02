// Pricing: two plans, priced per open client workspace with 15 included.
// Keep these numbers in step with the Stripe prices (Pescada Essential, Pescada Pro).
const PLANS = { essential: { base: 29, per: 1.9 }, pro: { base: 59, per: 3.9 } };
const INCLUDED = 15;
const EXAMPLES = [15, 50, 150];
const cost = (p, n) => p.base + Math.max(0, n - INCLUDED) * p.per;
const SIGNUP = 'https://app.pescada.io/#/signup';
const BANK = '(camt.053, MT940, CFONB 120, Norma 43, CSV)';

const T = {
  en: {
    path: '/pricing/', locale: 'en-IE', title: 'Pricing', home: '/',
    description: 'Pescada pricing: Essential from €29 a month and Pro from €59 a month, each with 15 clients included. 30-day free trial with everything.',
    lead: 'Two plans, priced by the number of clients you work with. Every plan includes the whole document exchange; Pro adds the time-savers.',
    month: 'a month', included: `includes ${INCLUDED} clients`, then: (x) => `then ${x} per client`, trial: 'Start a free trial', demo: 'Request a demo',
    essential: ['Essential', 'Everything you need to exchange documents with clients and prove it.', [
      'Unlimited documents and storage, hosted in the EU',
      'Tamper-evident activity log, exportable as evidence',
      'Requests, recurring deadlines and automatic reminders',
      `Bank files ${BANK} and e-invoices read exactly`,
      'Payment-to-invoice matching',
      'Daily summary, search and bulk download',
      'Team accounts and two-step sign-in',
      'Six languages for you and your clients']],
    pro: ['Pro', 'Everything in Essential, plus the time-savers.', [
      'Everything in Essential',
      'PDFs and photos of invoices and statements read by AI',
      'Bank statements fetched automatically from the bank',
      'A forwarding email address for each client',
      'Exports to accounting software (DATEV, CSV for your country)',
      'Your firm’s logo on emails and client spaces',
      'Priority support, same business day']],
    popular: 'Recommended',
    examplesTitle: 'What a month costs', clients: 'Clients',
    notes: [
      'Prices exclude VAT. Paid monthly by card through Stripe; cancel any time.',
      'A client is an open client workspace. Closed clients are not counted.',
      'The 30-day trial includes everything in Pro and needs no card.',
      'You can switch between Essential and Pro whenever you like; the difference is prorated.'],
  },
  es: {
    path: '/es/precios/', locale: 'es-ES', title: 'Precios', home: '/es/',
    description: 'Precios de Pescada: Essential desde 29 € al mes y Pro desde 59 € al mes, con 15 clientes incluidos. Prueba gratuita de 30 días con todo incluido.',
    lead: 'Dos planes, según el número de clientes con los que trabajas. Todos incluyen el intercambio de documentos completo; Pro añade lo que ahorra tiempo.',
    month: 'al mes', included: `incluye ${INCLUDED} clientes`, then: (x) => `después ${x} por cliente`, trial: 'Empezar la prueba gratuita', demo: 'Solicitar una demo',
    essential: ['Essential', 'Todo lo necesario para intercambiar documentos con tus clientes y poder demostrarlo.', [
      'Documentos y almacenamiento ilimitados, alojados en la UE',
      'Registro de actividad a prueba de manipulaciones, exportable como prueba',
      'Solicitudes, plazos periódicos y recordatorios automáticos',
      `Ficheros bancarios ${BANK} y facturas electrónicas leídos de forma exacta`,
      'Casación de cobros y pagos con facturas',
      'Resumen diario, búsqueda y descarga en bloque',
      'Cuentas para tu equipo y acceso en dos pasos',
      'Seis idiomas para ti y tus clientes']],
    pro: ['Pro', 'Todo lo de Essential, más lo que ahorra tiempo.', [
      'Todo lo de Essential',
      'PDF y fotos de facturas y extractos leídos con IA',
      'Extractos que llegan solos desde el banco',
      'Una dirección de correo para cada cliente',
      'Exportación al programa contable (DATEV, CSV de tu país)',
      'El logotipo de tu despacho en los correos y espacios de clientes',
      'Soporte prioritario, respuesta en el mismo día laborable']],
    popular: 'Recomendado',
    examplesTitle: 'Cuánto cuesta al mes', clients: 'Clientes',
    notes: [
      'Precios sin IVA. Pago mensual con tarjeta a través de Stripe; cancela cuando quieras.',
      'Un cliente es un espacio de cliente abierto. Los clientes cerrados no cuentan.',
      'La prueba de 30 días incluye todo lo de Pro y no pide tarjeta.',
      'Puedes cambiar entre Essential y Pro cuando quieras; la diferencia se prorratea.'],
  },
  it: {
    path: '/it/prezzi/', locale: 'it-IT', title: 'Prezzi', home: '/it/',
    description: 'Prezzi di Pescada: Essential da 29 € al mese e Pro da 59 € al mese, con 15 clienti inclusi. Prova gratuita di 30 giorni con tutto incluso.',
    lead: 'Due piani, in base al numero di clienti con cui lavori. Tutti includono lo scambio di documenti completo; Pro aggiunge ciò che fa risparmiare tempo.',
    month: 'al mese', included: `include ${INCLUDED} clienti`, then: (x) => `poi ${x} per cliente`, trial: 'Inizia la prova gratuita', demo: 'Richiedi una demo',
    essential: ['Essential', 'Tutto ciò che serve per scambiare documenti con i clienti e poterlo dimostrare.', [
      'Documenti e archiviazione illimitati, ospitati nell’UE',
      'Registro attività a prova di manomissione, esportabile come prova',
      'Richieste, scadenze periodiche e promemoria automatici',
      `File bancari ${BANK} e fatture elettroniche letti in modo esatto`,
      'Abbinamento di incassi e pagamenti alle fatture',
      'Riepilogo giornaliero, ricerca e download multiplo',
      'Account per il tuo team e accesso in due passaggi',
      'Sei lingue per te e i tuoi clienti']],
    pro: ['Pro', 'Tutto ciò che c’è in Essential, più ciò che fa risparmiare tempo.', [
      'Tutto ciò che c’è in Essential',
      'PDF e foto di fatture ed estratti letti con l’IA',
      'Estratti conto che arrivano da soli dalla banca',
      'Un indirizzo email per ogni cliente',
      'Esportazione verso il gestionale contabile (DATEV, CSV del tuo Paese)',
      'Il logo del tuo studio nelle email e negli spazi dei clienti',
      'Assistenza prioritaria, risposta in giornata lavorativa']],
    popular: 'Consigliato',
    examplesTitle: 'Quanto costa al mese', clients: 'Clienti',
    notes: [
      'Prezzi IVA esclusa. Pagamento mensile con carta tramite Stripe; disdici quando vuoi.',
      'Un cliente è uno spazio cliente aperto. I clienti chiusi non contano.',
      'La prova di 30 giorni include tutto Pro e non richiede carta.',
      'Puoi passare da Essential a Pro e viceversa quando vuoi; la differenza è calcolata pro rata.'],
  },
  fr: {
    path: '/fr/tarifs/', locale: 'fr-FR', title: 'Tarifs', home: '/fr/',
    description: 'Tarifs Pescada : Essential à partir de 29 € par mois et Pro à partir de 59 € par mois, 15 clients inclus. Essai gratuit de 30 jours, tout compris.',
    lead: 'Deux formules, selon le nombre de clients avec qui vous travaillez. Toutes comprennent l’échange de documents complet ; Pro ajoute ce qui fait gagner du temps.',
    month: 'par mois', included: `${INCLUDED} clients inclus`, then: (x) => `puis ${x} par client`, trial: 'Commencer l’essai gratuit', demo: 'Demander une démo',
    essential: ['Essential', 'Tout le nécessaire pour échanger des documents avec vos clients et le prouver.', [
      'Documents et stockage illimités, hébergés dans l’UE',
      'Journal d’activité infalsifiable, exportable comme preuve',
      'Demandes, échéances récurrentes et relances automatiques',
      `Fichiers bancaires ${BANK} et factures électroniques lus exactement`,
      'Rapprochement des paiements avec les factures',
      'Résumé quotidien, recherche et téléchargement groupé',
      'Comptes pour votre équipe et validation en deux étapes',
      'Six langues pour vous et vos clients']],
    pro: ['Pro', 'Tout Essential, plus ce qui fait gagner du temps.', [
      'Tout ce qu’offre Essential',
      'PDF et photos de factures et de relevés lus par l’IA',
      'Relevés récupérés automatiquement auprès de la banque',
      'Une adresse e-mail pour chaque client',
      'Exports vers le logiciel comptable (DATEV, CSV de votre pays)',
      'Le logo de votre cabinet dans les e-mails et les espaces clients',
      'Assistance prioritaire, réponse le jour ouvré même']],
    popular: 'Recommandé',
    examplesTitle: 'Ce que coûte un mois', clients: 'Clients',
    notes: [
      'Prix hors TVA. Paiement mensuel par carte via Stripe ; résiliable à tout moment.',
      'Un client est un espace client ouvert. Les clients fermés ne sont pas comptés.',
      'L’essai de 30 jours comprend tout Pro, sans carte.',
      'Vous pouvez passer d’Essential à Pro et inversement quand vous voulez ; la différence est calculée au prorata.'],
  },
  de: {
    path: '/de/preise/', locale: 'de-DE', title: 'Preise', home: '/de/',
    description: 'Pescada-Preise: Essential ab 29 € im Monat und Pro ab 59 € im Monat, jeweils 15 Mandanten inklusive. 30 Tage kostenlos testen, alles inklusive.',
    lead: 'Zwei Tarife, nach der Zahl Ihrer Mandanten. Jeder Tarif enthält den vollständigen Dokumentenaustausch; Pro ergänzt, was Zeit spart.',
    month: 'im Monat', included: `${INCLUDED} Mandanten inklusive`, then: (x) => `danach ${x} je Mandant`, trial: 'Kostenlos testen', demo: 'Demo anfragen',
    essential: ['Essential', 'Alles, um Dokumente mit Mandanten auszutauschen und es belegen zu können.', [
      'Unbegrenzte Dokumente und Speicher, gehostet in der EU',
      'Manipulationssicheres Aktivitätsprotokoll, als Nachweis exportierbar',
      'Anforderungen, wiederkehrende Fristen und automatische Erinnerungen',
      `Bankdateien ${BANK} und E-Rechnungen exakt gelesen`,
      'Zuordnung von Zahlungen zu Rechnungen',
      'Tageszusammenfassung, Suche und Sammeldownload',
      'Konten für Ihr Team und Bestätigung in zwei Schritten',
      'Sechs Sprachen für Sie und Ihre Mandanten']],
    pro: ['Pro', 'Alles aus Essential, plus was Zeit spart.', [
      'Alles aus Essential',
      'PDFs und Fotos von Rechnungen und Auszügen mit KI gelesen',
      'Kontoauszüge automatisch von der Bank',
      'Eine E-Mail-Adresse für jeden Mandanten',
      'Exporte für die Buchhaltungssoftware (DATEV, CSV Ihres Landes)',
      'Das Logo Ihrer Kanzlei in E-Mails und Mandantenbereichen',
      'Bevorzugter Support, Antwort am selben Werktag']],
    popular: 'Empfohlen',
    examplesTitle: 'Was ein Monat kostet', clients: 'Mandanten',
    notes: [
      'Preise zzgl. USt. Monatliche Zahlung per Karte über Stripe; jederzeit kündbar.',
      'Ein Mandant ist ein offener Mandantenbereich. Geschlossene Mandanten zählen nicht.',
      'Der 30-tägige Test enthält alles aus Pro und braucht keine Karte.',
      'Sie können jederzeit zwischen Essential und Pro wechseln; die Differenz wird anteilig verrechnet.'],
  },
  pt: {
    path: '/pt/precos/', locale: 'pt-PT', title: 'Preços', home: '/pt/',
    description: 'Preços do Pescada: Essential a partir de 29 € por mês e Pro a partir de 59 € por mês, com 15 clientes incluídos. Período experimental gratuito de 30 dias com tudo incluído.',
    lead: 'Dois planos, consoante o número de clientes com quem trabalha. Todos incluem a troca de documentos completa; o Pro acrescenta o que poupa tempo.',
    month: 'por mês', included: `inclui ${INCLUDED} clientes`, then: (x) => `depois ${x} por cliente`, trial: 'Começar o período experimental', demo: 'Pedir uma demo',
    essential: ['Essential', 'Tudo o que precisa para trocar documentos com os clientes e poder prová-lo.', [
      'Documentos e armazenamento ilimitados, alojados na UE',
      'Registo de atividade inviolável, exportável como prova',
      'Pedidos, prazos periódicos e lembretes automáticos',
      `Ficheiros bancários ${BANK} e faturas eletrónicas lidos com exatidão`,
      'Associação de pagamentos a faturas',
      'Resumo diário, pesquisa e transferência em bloco',
      'Contas para a sua equipa e verificação em dois passos',
      'Seis idiomas para si e para os seus clientes']],
    pro: ['Pro', 'Tudo o que tem o Essential, mais o que poupa tempo.', [
      'Tudo o que tem o Essential',
      'PDF e fotografias de faturas e extratos lidos por IA',
      'Extratos que chegam sozinhos do banco',
      'Um endereço de email para cada cliente',
      'Exportação para o software de contabilidade (DATEV, CSV do seu país)',
      'O logótipo do seu gabinete nos emails e nos espaços dos clientes',
      'Apoio prioritário, resposta no mesmo dia útil']],
    popular: 'Recomendado',
    examplesTitle: 'Quanto custa um mês', clients: 'Clientes',
    notes: [
      'Preços sem IVA. Pagamento mensal com cartão através da Stripe; cancele quando quiser.',
      'Um cliente é um espaço de cliente aberto. Os clientes encerrados não contam.',
      'O período experimental de 30 dias inclui tudo do Pro e não pede cartão.',
      'Pode mudar entre Essential e Pro quando quiser; a diferença é calculada proporcionalmente.'],
  },
};

const money = (n, locale) => new Intl.NumberFormat(locale, { style: 'currency', currency: 'EUR', minimumFractionDigits: Number.isInteger(n) ? 0 : 2 }).format(n);

function plan(t, id, featured) {
  const [name, tag, items] = t[id], p = PLANS[id];
  return `<article class="plan${featured ? ' featured' : ''}">
    ${featured ? `<p class="plan-tag">${t.popular}</p>` : ''}
    <h2>${name}</h2>
    <p class="plan-price"><b>${money(p.base, t.locale)}</b> <span>${t.month}</span></p>
    <p class="plan-sub">${t.included} · ${t.then(money(p.per, t.locale))}</p>
    <p class="plan-desc">${tag}</p>
    <ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul>
    <a class="btn ${featured ? 'primary' : 'outline'}" href="${SIGNUP}">${t.trial}</a>
  </article>`;
}

export const pages = Object.entries(T).map(([lang, t]) => ({
  key: 'pricing', lang, path: t.path, title: t.title, description: t.description,
  body: `<section class="section pricing"><div class="wrap">
    <div class="section-head"><h1>${t.title}</h1><p class="lead">${t.lead}</p></div>
    <div class="plans">${plan(t, 'essential', false)}${plan(t, 'pro', true)}</div>
    <h2 class="examples-title">${t.examplesTitle}</h2>
    <div class="table"><table><thead><tr><th scope="col">${t.clients}</th><th scope="col">Essential</th><th scope="col">Pro</th></tr></thead><tbody>
      ${EXAMPLES.map((n) => `<tr><th scope="row">${n}</th><td>${money(cost(PLANS.essential, n), t.locale)}</td><td>${money(cost(PLANS.pro, n), t.locale)}</td></tr>`).join('')}
    </tbody></table></div>
    <ul class="pricing-notes">${t.notes.map((n) => `<li>${n}</li>`).join('')}</ul>
    <p class="cta"><a class="btn primary" href="${SIGNUP}">${t.trial}</a><a class="btn outline" href="${t.home}#demo">${t.demo}</a></p>
  </div></section>`,
}));
