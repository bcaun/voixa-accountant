# Voixa Exchange

Document exchange between Voixa Accounting and its clients, where every step is recorded:
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
  (`AI_MONTHLY_BUDGET_USD`) after which files are not sent to the AI reader until the next month.
  Clients never see these figures.
- **Passwordless sign-in.** People sign in with a one-time link sent to their email.

## Run it locally

Requirements: Node.js 20+ and PostgreSQL 14+.

```sh
npm install
cp .env.example .env          # set DATABASE_URL; the defaults print emails to the console
export $(grep -v '^#' .env | xargs)
npm run create-accountant -- --email you@voixa.es --name "Your Name"   # prints a sign-in link
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
- **Accountants** are created from the command line (`npm run create-accountant`). Clients are
  invited from the app.

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
src/recognition/     statement parsers (Norma 43, camt.053, CSV), AI reader, references, payment matching, AI pricing
src/sql/             database schema
public/              web client (plain HTML, CSS and JavaScript, no build step)
test/                end-to-end tests
```
