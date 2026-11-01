// Throwaway mailbox services, refused at sign-up. Not exhaustive: it stops the common ones.
const DOMAINS = `0-mail.com 10minutemail.com 10minutemail.net 20minutemail.com 33mail.com anonbox.net burnermail.io
discard.email dispostable.com dropmail.me emailondeck.com emailfake.com fakeinbox.com fakemail.net getairmail.com
getnada.com guerrillamail.biz guerrillamail.com guerrillamail.de guerrillamail.info guerrillamail.net guerrillamail.org
guerrillamailblock.com harakirimail.com inboxbear.com incognitomail.org jetable.org kasmail.com mailcatch.com
maildrop.cc mailinator.com mailinator.net mailinator2.com mailnesia.com mailpoof.com mailsac.com mailtemp.net
mintemail.com moakt.com mohmal.com mytemp.email mytrashmail.com nada.email nwytg.net sharklasers.com spam4.me
spambox.us spamgourmet.com spamex.com temp-mail.io temp-mail.org tempail.com tempinbox.com tempmail.com tempmail.dev
tempmail.net tempmailo.com tempr.email throwawaymail.com tmail.ws tmpmail.net tmpmail.org trash-mail.com trashmail.com
trashmail.de trashmail.net trbvm.com wegwerfmail.de wegwerfmail.net yopmail.com yopmail.fr yopmail.net`.split(/\s+/);
const SET = new Set(DOMAINS);

export function isDisposable(email) {
  const domain = String(email).split('@').pop().toLowerCase();
  const parts = domain.split('.');
  // also catch subdomains such as foo.mailinator.com
  for (let i = 0; i < parts.length - 1; i++) if (SET.has(parts.slice(i).join('.'))) return true;
  return false;
}
