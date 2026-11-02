// Web Push notifications to browsers and to Pescada installed on a phone or computer (PWA).
// They follow the same rules as instant emails: an accountant on the daily summary gets only the
// urgent ones. The VAPID keys are made on first use and kept in the database.
import webpush from 'web-push';
import { query } from './db.js';

let keys = null;
export async function vapidKeys() {
  if (keys) return keys;
  const { rows } = await query(`select key, value from app_settings where key in ('vapid_public', 'vapid_private')`);
  const got = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  if (got.vapid_public && got.vapid_private) keys = { publicKey: got.vapid_public, privateKey: got.vapid_private };
  else {
    const k = webpush.generateVAPIDKeys();
    // another process may have made them at the same moment: keep whichever was stored first
    await query(`insert into app_settings (key, value) values ('vapid_public', $1), ('vapid_private', $2) on conflict (key) do nothing`, [k.publicKey, k.privateKey]);
    return vapidKeys();
  }
  return keys;
}

export async function subscribe(user, sub, userAgent = '') {
  const endpoint = String(sub?.endpoint || ''), p256dh = String(sub?.keys?.p256dh || ''), auth = String(sub?.keys?.auth || '');
  if (!/^https:\/\//.test(endpoint) || !p256dh || !auth) throw Object.assign(new Error('That is not a valid push subscription.'), { status: 400 });
  await query(`insert into push_subscriptions (endpoint, user_id, p256dh, auth, user_agent) values ($1,$2,$3,$4,$5)
               on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`,
  [endpoint, user.id, p256dh, auth, String(userAgent).slice(0, 300)]);
}
export const unsubscribe = (user, endpoint) => query('delete from push_subscriptions where user_id = $1 and endpoint = $2', [user.id, String(endpoint || '')]);
export const forgetUser = (db, userId) => db.query('delete from push_subscriptions where user_id = $1', [userId]);

/** Inside the caller's transaction: queue a notification for a person, if they have a device that wants them. */
export async function queuePush(c, { userId, title, body, url }) {
  await c.query(`insert into push_messages (user_id, title, body, url) select $1, $2, $3, $4
                 where exists (select 1 from push_subscriptions where user_id = $1)`, [userId, String(title).slice(0, 200), String(body || '').slice(0, 500), url || '/']);
}

let sending = null;
/** Send what is waiting. Gone subscriptions (the person uninstalled or revoked permission) are removed. */
export function flushPush() {
  sending ||= (async () => {
    try {
      const { rows } = await query('update push_messages set sent_at = now() where id in (select id from push_messages where sent_at is null order by id limit 200) returning *');
      if (!rows.length) return 0;
      const k = await vapidKeys();
      webpush.setVapidDetails('mailto:hello@pescada.io', k.publicKey, k.privateKey);
      let sent = 0;
      for (const m of rows) {
        const { rows: subs } = await query('select * from push_subscriptions where user_id = $1', [m.user_id]);
        for (const s of subs) {
          try {
            await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
              JSON.stringify({ title: m.title, body: m.body, url: m.url, tag: `pescada-${m.id}` }), { TTL: 24 * 3600, urgency: 'normal' });
            sent++;
          } catch (err) {
            if (err.statusCode === 404 || err.statusCode === 410) await query('delete from push_subscriptions where endpoint = $1', [s.endpoint]);
            else console.error('push', err.statusCode || '', err.message);
          }
        }
      }
      await query(`delete from push_messages where sent_at < now() - interval '7 days'`);
      return sent;
    } finally { sending = null; }
  })();
  return sending;
}
