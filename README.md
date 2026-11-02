# Pescada

Document exchange between an accounting firm and its clients, where every step is recorded:
who sent what and when, whether the notification email reached the other side, when the
recipient opened the file, and when they confirmed receipt or approved it. The goal is that
nobody can say "I never got it", "you never sent it" or "it went to spam".

## What it does

- **Client workspaces.** Each client company has its own workspace. Several people from the same
  company can be invited; clients never see other clients. Accountants see every workspace.
- **Documents from clients** (invoices, contracts, bank statements, receipts) and **reports and
  document requests from the accountant**, each tracked through *Sent → Notified → Opened → Confirmed*.
  Confirming or approving is only possible after the recipient has opened the current version.
- **Deadlines.** Reports carry a deadline and record whether they were sent on time. Requests have a
  due date.
- **Recurring deadlines.** Monthly, quarterly or yearly obligations (bank statements by the 5th,
  Modelo 303 by the 20th after each quarter, …) create the request or the expected report
  automatically a set number of days ahead.
- **Email notifications and reminders.** Every new document, report, request, replacement, note and
  confirmation emails the other side. Automatic reminders go out when something is not opened
  (48 h) or not confirmed (72 h), and before deadlines. With Postmark, delivery, bounces, spam
  complaints and opens are written to the log.
- **Replacing a file** keeps every earlier version, records the reason, and asks the recipient to
  open and confirm again.
- **Evidence log.** Every action is an append-only, hash-chained event per workspace (SHA-256 of the
  entry plus the previous hash). The database refuses `UPDATE`, `DELETE` and `TRUNCATE` on the log,
  and the chain can be verified at any time. Every file is fingerprinted with SHA-256 by the server.
- **Exports.** The log downloads as CSV, and a printable tracking report (whole workspace or one
  item) can be printed or saved as PDF. Exports are themselves logged.
- **Bank statement and invoice recognition.** Files uploaded as *Bank statement* or *Invoice* are read
  automatically. Statements: Norma 43 (AEB 43), camt.053 XML and bank CSV exports are parsed exactly by
  code; PDFs and photos are read by Claude. For each transaction the app records date, amount, currency,
  counterparty (name, NIF, IBAN), the payment text, and any invoice and contract numbers in it. Invoices
  (read by Claude) give number, issuer, recipient, dates, net, tax and total, and whether the invoice was
  issued or received by the client company. Payments are then matched to the client's invoices by
  invoice number, amount, counterparty and date; the accountant confirms or rejects each match. Every
  recognition, suggested match and decision is written to the log. An accountant can re-read any file
  as a statement or an invoice.
- **AI cost tracking.** Every call to the AI reader stores its token usage and estimated cost (list
  price per model, including fallbacks and cache tokens). Accountants see the cost per client and
  month, per model and per document, can download it as CSV, and can set a monthly budget
  (`AI_MONTHLY_BUDGET_USD`, applied to each firm separately) after which that firm's files are not sent to the AI reader until the next month.
  Clients never see these figures.
- **Passwordless sign-in.** People sign in with a one-time link sent to their email.
- **Several firms, five countries.** One server hosts any number of accounting firms. Accountants see only
  their own firm's clients, client numbers count per firm, and emails carry the firm's name. Every client
  has a country (Spain, Italy, France, Germany or Portugal; the firm's by default) which sets:

  | | Tax ID checked | Deadlines in | Read exactly, without AI |
  |---|---|---|---|
  | Spain | NIF / CIF / NIE | Madrid time | Norma 43, camt.053, CSV |
  | Italy | Partita IVA, Codice Fiscale (check digits) | Rome time | FatturaPA XML, signed `.p7m` too; camt.053, CSV |
  | France | SIREN, SIRET, TVA (check digits) | Paris time | Factur-X PDF, UBL, CII; CFONB 120, camt.053, CSV |
  | Germany | USt-IdNr. (check digit), Steuernummer | Berlin time | XRechnung (UBL, CII), ZUGFeRD PDF; MT940, camt.053, CSV |
  | Portugal | NIF / NIPC (check digit) | Lisbon time | UBL; camt.053, CSV |

  …plus deadline templates (Modelo 303/111/390; F24, CU, 770; CA3, DSN, CA12; UStVA, Lohnsteuer, ZM;
  IVA periódica, DMR, Modelo 22, IES), bank wording in each language for counterparties and invoice
  numbers, and the AI reader's instructions. Deadlines can fall one, two or three months after the period
  (Portugal's VAT return is due on the 20th of the second month).

## Run it locally

Requirements: Node.js 20+ and PostgreSQL 14+.

```sh
npm install
cp .env.example .env          # set DATABASE_URL; the defaults print emails to the console
export $(grep -v '^#' .env | xargs)
npm run create-firm -- --name "Your Firm" --country ES               # ES, IT, FR, DE or PT
npm run create-accountant -- --firm "Your Firm" --email you@voixa.es --name "Your Name"   # prints a sign-in link
npm start                     # http://localhost:3000
```

Open the printed link, add a client, and invite a client contact. With `MAIL_TRANSPORT=console`
the invitation (with its sign-in link) is printed in the server log.

Or with Docker (PostgreSQL, S3-compatible storage and a mail catcher included):

```sh
docker compose up --build
docker compose exec app node src/cli.js create-accountant --email you@voixa.es --name "Your Name"
# app http://localhost:3000 · emails http://localhost:8025
```

## Tests

The tests run the whole app against a real PostgreSQL database, which they wipe:

```sh
TEST_DATABASE_URL=postgres://postgres@localhost:5432/voixa_test npm test
```

They cover sign-in, workspace isolation, upload and fingerprinting, open-before-confirm, file
replacement, requests, reports and deadlines, recurring deadlines, reminders, email webhooks,
exports, the append-only guard and detection of a tampered log.

## Production setup

- **Server:** one small VM (2 vCPU, 4 GB RAM) is enough for hundreds of clients. Run behind a reverse
  proxy with HTTPS and set `APP_URL=https://…` and `TRUST_PROXY=1`.
- **Database:** PostgreSQL with daily backups to another region. The log is the evidence; test a
  restore regularly.
- **Files:** `STORAGE_DRIVER=s3` with a bucket in the EU (AWS `eu-south-2` Spain, Google
  `europe-southwest1` Madrid, or Cloudflare R2 with EU jurisdiction). Turn on versioning and
  Object Lock (compliance mode, 6 years) so stored files cannot be deleted or overwritten.
- **Email:** `MAIL_TRANSPORT=postmark` with a sending domain that has SPF, DKIM and DMARC set up.
  In Postmark, add a webhook to `https://<host>/webhooks/postmark?token=<WEBHOOK_TOKEN>` for
  Delivery, Bounce, Spam Complaint and Open events.
- **AI reading:** set `ANTHROPIC_API_KEY` to read PDF and photo statements and invoices. Files are sent
  to the Anthropic API; cover this in the client agreement and your data-processing records (GDPR).
  Without a key, Norma 43, camt.053 and CSV statements are still read, and other files are marked as
  not readable with a note explaining what to upload instead.
- **Secrets and alerts:** set `SECRET_KEY` (32 random bytes, hex; encrypts two-factor secrets) and
  `ALERT_EMAIL` (errors, failed deliveries, stuck jobs). Monitor `/healthz/deep?token=<WEBHOOK_TOKEN>`
  from outside, and run `deploy/restore-test.sh` monthly and `node src/cli.js verify-all` on demand.
- **Virus scanning:** `CLAMAV_HOST`/`CLAMAV_PORT` point at clamd (the `clamav` service in the production
  compose file, ~1.5 GB RAM). Without it uploads are stored with scan status `pending` and rescanned later.
- **Languages:** emails go out in the person's chosen language, otherwise by the firm's (accountants) or
  client's (clients) country; `EMAIL_LANG=en|es|it|fr|de|pt` forces one language (default `auto`).
- **Email-in:** `INBOUND_DOMAIN` plus a Postmark inbound stream posting to
  `/webhooks/postmark-inbound?token=<WEBHOOK_TOKEN>`; mail must pass SPF or DKIM.
- **Billing:** `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET` (webhook `/webhooks/stripe`),
  `STRIPE_QUANTITY=clients|firm`; `STRIPE_PRICE_ID` is the Essential plan and `STRIPE_PRICE_ID_PRO` the Pro plan (Pro adds AI reading of PDFs and photos, bank feeds, an email-in address per client and accounting-software exports and the firm’s logo on client emails and spaces; trials include everything; `node src/cli.js set-tier --firm … --tier essential|pro` sets it by hand); `SIGNUP=off` disables self-signup, `TRIAL_DAYS` sets the trial.
  Sign-up creates nothing until the emailed link is opened; a hidden field, a minimum fill time, a list of
  throwaway mail domains and per-IP/per-address limits stop robots. `SIGNUP_DAILY_MAX` (20) caps requests per day,
  `TRIAL_MAX_CLIENTS` (10) and `TRIAL_MAX_INVITES` (20 a day) limit trial firms, and `SIGNUP_NOTIFY_EMAIL` is told of each new firm.
- **Bank feeds:** `GOCARDLESS_SECRET_ID`, `GOCARDLESS_SECRET_KEY`, `BANK_FEED_SYNC_HOURS` (default 12).
- **Sign-in:** besides email links, passkeys (WebAuthn, no setup; they count as two-step sign-in) and Google /
  Microsoft (OpenID Connect) when `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` or `MICROSOFT_CLIENT_ID`/`MICROSOFT_CLIENT_SECRET`
  are set (redirect URIs `/auth/oauth/google/callback`, `/auth/oauth/microsoft/callback`; `MICROSOFT_TENANT` defaults to
  `organizations`). Microsoft accounts are only linked by the signed-in person, never matched by email. A sign-in from a
  new browser or device is reported by email with a one-click "sign out everywhere" link. `SUPPORT_EMAIL` receives in-app
  support messages.
- **Trusted timestamps:** with `TSA_URL` (RFC 3161; `TSA_USER`/`TSA_PASSWORD`, `TSA_NAME`, `TSA_QUALIFIED=yes` only for a
  qualified TSA on the EU trusted list, `TSA_INTERVAL_MIN` default 60) the heads of the logs that grew are sealed hourly. Tokens and
  manifests are kept, shown in the log and report, and included in the full export for checking with `openssl ts -verify`.
  CLI: `timestamp-now`, `verify-timestamps`.
- **Closing clients:** `CLOSE_EXPORT_DAYS` (30) export window, then blocked; purged after `RETENTION_YEARS` (6).
- **Firms and accountants** are created from the command line (`create-firm`, `create-accountant --firm`,
  `list-firms`). Clients are invited from the app. A firm can change its name and default country in the app.

## Project layout

```
src/server.js        HTTP server, security headers, sign-in pages, webhook
src/routes/api.js    JSON API used by the web client
src/items.js         documents, reports, requests: status, actions, notifications
src/companies.js     workspaces, people, recurring deadlines
src/ledger.js        hash-chained evidence log and verification
src/mailer.js        email queue, transports (console, SMTP, Postmark), delivery webhooks
src/scheduler.js     automatic reminders and recurring deadlines
src/export.js        CSV and printable tracking report
src/storage.js       file storage (local disk or S3-compatible)
src/countries.js     per-country rules: tax ID checks, time zones, deadline templates
src/recognition/     statement parsers (Norma 43, CFONB 120, MT940, camt.053, CSV), e-invoices (FatturaPA, UBL, CII,
                     Factur-X / ZUGFeRD), AI reader, references, payment matching, AI pricing
src/sql/             database schema
public/              web client (plain HTML, CSS and JavaScript, no build step)
test/                end-to-end tests
```

## Product website (pescada.io)

`site/` holds the marketing site and the public legal pages (privacy policy, terms, data processing
agreement, sub-processors, security) in English and Spanish. Edit the sources in `site/src/`, company
details in `site/src/company.mjs`, then rebuild and commit the output:

```sh
node site/build.mjs     # writes site/public, which Caddy serves on pescada.io
```

The build also copies the brand fonts (`site/src/fonts`, `site/src/fonts.css`) into `public/` so the app
and the site use the same files. Colours, type and components follow the Pescada brand kit v1.0.

### Publishing news

News and press releases live in `site/src/news/`, one file per post, in English and Spanish. Copy an
existing post, change `date`, `slug`, `title`, `summary` and `body`, then rebuild and commit:

```sh
node site/build.mjs     # adds the post to /news/ and /es/noticias/, the RSS feeds and the sitemap
```
