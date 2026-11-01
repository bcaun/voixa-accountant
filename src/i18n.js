// Emails in each person's language. Dictionaries (src/i18n/<lang>.js) map the English text,
// with {placeholders}, to its translation; anything missing stays in English. The activity log
// itself is kept in English, as one evidence record that both sides and a court can read.
import es from './i18n/es.js';
import it from './i18n/it.js';
import fr from './i18n/fr.js';
import de from './i18n/de.js';
import pt from './i18n/pt.js';
import { langOfCountry } from './countries.js';
import { config } from './config.js';

const DICTS = { es, it, fr, de, pt };
export const LOCALE = { en: 'en-GB', es: 'es-ES', it: 'it-IT', fr: 'fr-FR', de: 'de-DE', pt: 'pt-PT' };

export function tr(lang, s, vars = {}) {
  const out = DICTS[lang]?.[s] ?? s;
  return out.replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? m));
}
export const translator = (lang) => (s, vars) => tr(lang, s, vars);

/** The language to write to someone in: their choice, or that of their country. */
export const langFor = (user, country) => user?.lang || (config.emailLang !== 'auto' ? config.emailLang : langOfCountry(country));

/** Dates for a recipient: their language, the client's time zone. */
export const dayIn = (d, tz, lang) => new Date(d).toLocaleDateString(LOCALE[lang] || 'en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: tz });
export const timeIn = (d, tz, lang) => new Date(d).toLocaleString(LOCALE[lang] || 'en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: tz, timeZoneName: 'short' });
