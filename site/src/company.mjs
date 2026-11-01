// Everything about the company that the site and the legal pages print.
export const company = {
  product: 'Pescada',
  legalName: 'Voixa Consultors S.L.',
  taxId: 'B24744351',
  address: 'Carrer de Pallars 193, 08005 Barcelona',
  // Spanish law (art. 13 LSC) requires the single-shareholder status to be stated in the company's documentation
  singleMember: true,
  registry: {
    en: 'Registered in the Barcelona Commercial Registry, Section 8, Sheet B-645004, 1st entry of 13 November 2025',
    es: 'Inscrita en el Registro Mercantil de Barcelona, Sección 8, Hoja B-645004, Inscripción 1.ª de 13 de noviembre de 2025',
  },
  contactEmail: 'hello@pescada.io',
  privacyEmail: 'privacy@pescada.io',
  courtsCity: 'Barcelona',
  appUrl: 'https://app.pescada.io',
  // Cloudflare Web Analytics (cookieless). Empty = no analytics script on the site.
  analyticsToken: '',
  // 'draft' shows a "pending legal review" note on every legal page; set to 'final' once a lawyer has approved them
  legalStatus: 'final',
  legalVersion: '1.0',
  legalDate: '2026-11-01',
};

export const demoHref = (lang) => `mailto:${company.contactEmail}?subject=${encodeURIComponent(lang === 'es' ? 'Demo de Pescada' : 'Pescada demo')}`;
