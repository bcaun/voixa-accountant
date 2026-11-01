// Where the demo form sends the visitor after it is submitted.
const T = {
  en: ['/thanks/', 'Thank you', 'We have your request and will write to you within one working day to arrange the demo.', 'Back to the home page', '/'],
  es: ['/es/gracias/', 'Gracias', 'Hemos recibido tu solicitud y te escribiremos en un día laborable para organizar la demo.', 'Volver al inicio', '/es/'],
  it: ['/it/grazie/', 'Grazie', 'Abbiamo ricevuto la tua richiesta e ti scriveremo entro un giorno lavorativo per organizzare la demo.', 'Torna alla pagina iniziale', '/it/'],
  fr: ['/fr/merci/', 'Merci', 'Nous avons bien reçu votre demande et vous écrirons sous un jour ouvré pour organiser la démo.', 'Retour à l’accueil', '/fr/'],
  de: ['/de/danke/', 'Danke', 'Wir haben Ihre Anfrage erhalten und melden uns innerhalb eines Werktags, um die Demo zu vereinbaren.', 'Zurück zur Startseite', '/de/'],
  pt: ['/pt/obrigado/', 'Obrigado', 'Recebemos o seu pedido e escrevemos-lhe num dia útil para combinar a demo.', 'Voltar ao início', '/pt/'],
};
export const pages = Object.entries(T).map(([lang, [path, title, text, back, home]]) => ({
  key: 'thanks', lang, path, title, description: text, noindex: true,
  body: `<section class="section"><div class="wrap" style="max-width:720px"><div class="section-head"><h1>${title}</h1><p class="lead">${text}</p><p><a class="btn primary" href="${home}">${back}</a></p></div></div></section>`,
}));
