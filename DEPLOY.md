# Установка на сервер (Hostinger VPS, Ubuntu 24.04)

Инструкция для одного сервера: приложение, база PostgreSQL, HTTPS и ежедневная копия базы.
Всё запускается в Docker. Команды выполняются на сервере от имени `root`.

## 1. Адрес сайта (DNS)

Адрес приложения: `app.pescada.io`. В Cloudflare → домен `pescada.io` → **DNS → Records → Add record**:

| Type | Name | IPv4 address | Proxy status | TTL |
|---|---|---|---|---|
| A | `app` | IP сервера (Hostinger → VPS → Overview → IPv4) | **DNS only** (серое облако) | Auto |

«DNS only» нужен, чтобы сервер сам получил HTTPS-сертификат. Проверка с Mac:
`dig +short app.pescada.io` должен показать IP сервера. Без этого HTTPS не включится.

## 2. Вход на сервер

Hostinger → VPS → **Web console**, или в Терминале на Mac:

```sh
ssh root@<IP сервера>
```

## 3. Доступ сервера к репозиторию (только чтение)

На сервере:

```sh
ssh-keygen -t ed25519 -f /root/.ssh/github -N "" -C "voixa-server"
printf 'Host github.com\n  IdentityFile /root/.ssh/github\n  StrictHostKeyChecking accept-new\n' >> /root/.ssh/config
cat /root/.ssh/github.pub
```

Скопируйте показанную строку. GitHub → репозиторий `bcaun/voixa-accountant` → **Settings → Deploy keys →
Add deploy key**: название `voixa-server`, вставить ключ, галочку «Allow write access» **не** ставить.

## 4. Загрузка и установка

```sh
git clone -b claude/server-prototype git@github.com:bcaun/voixa-accountant.git /opt/voixa-exchange
cd /opt/voixa-exchange
bash deploy/install.sh app.pescada.io ваш@email "Ваше Имя"
```

Скрипт обновит систему, включит файрвол (открыты только SSH, 80 и 443), установит Docker, создаст
`deploy/.env` с паролями, соберёт и запустит приложение и создаст учётную запись бухгалтера.
В конце он напечатает **ссылку для входа** — откройте её в браузере (работает один раз, 30 минут).

Новая ссылка для входа в любой момент:

```sh
cd /opt/voixa-exchange
docker compose -f deploy/docker-compose.prod.yml exec app node src/cli.js login-link --email ваш@email
```

### Ещё одна бухгалтерия (другая фирма, другая страна)

На одном сервере может работать несколько фирм. Бухгалтеры одной фирмы видят только своих клиентов.
У фирмы есть страна (ES, IT, FR, DE, PT) — она подставляется новым клиентам по умолчанию.

```sh
cd /opt/voixa-exchange
docker compose -f deploy/docker-compose.prod.yml exec app node src/cli.js create-firm --name "Studio Rossi" --country IT
docker compose -f deploy/docker-compose.prod.yml exec app node src/cli.js create-accountant --firm "Studio Rossi" --email giulia@studiorossi.it --name "Giulia Rossi"
docker compose -f deploy/docker-compose.prod.yml exec app node src/cli.js list-firms
```

Вторая команда печатает ссылку для входа — её нужно передать бухгалтеру. Если фирм несколько,
у `create-accountant` обязательно указывать `--firm`.

## 5. Почта (Postmark)

Пока в `deploy/.env` стоит `MAIL_TRANSPORT=console`, письма (приглашения клиентам, уведомления)
не уходят, а пишутся в журнал приложения: `docker compose -f deploy/docker-compose.prod.yml logs app`.

1. Зарегистрируйтесь на postmarkapp.com, создайте Server, подтвердите домен `pescada.io`
   (Postmark покажет DKIM- и Return-Path-записи — добавьте их в Cloudflare DNS, тоже «DNS only»).
2. В `deploy/.env`:
   ```
   MAIL_TRANSPORT=postmark
   POSTMARK_TOKEN=<Server API token>
   MAIL_FROM=Pescada <notifications@pescada.io>
   ```
3. В Postmark → Server → Webhooks добавьте адрес
   `https://app.pescada.io/webhooks/postmark?token=<WEBHOOK_TOKEN из deploy/.env>`
   с событиями Delivery, Bounce, Spam Complaint, Open.
4. Перезапуск: `docker compose -f deploy/docker-compose.prod.yml up -d`

## 6. Распознавание PDF (Anthropic)

В `deploy/.env` добавьте `ANTHROPIC_API_KEY=...` (ключ из platform.claude.com) и, по желанию,
месячный лимит `AI_MONTHLY_BUDGET_USD=150`. Перезапуск — как выше.

## 7. Резервные копии

- **Hostinger:** VPS → Backups & Monitoring → ежедневные копии всего сервера.
- **База:** контейнер `backup` каждые сутки сохраняет дамп базы (хранится 14 дней) в томе
  `voixa-exchange_backups`. Список: `docker run --rm -v voixa-exchange_backups:/b alpine ls -l /b`
- **Вне сервера:** после подключения R2 (раздел 7а) контейнер `offsite` каждые 6 часов копирует
  дампы в бакет, в папку `db-backups/`.

## 7а. Файлы и копии в Cloudflare R2

1. Cloudflare → **R2 Object Storage** (при первом входе — подключить R2, бесплатно до 10 ГБ).
2. **Create bucket**: имя `pescada-exchange`, Location → **Specify jurisdiction → European Union (EU)**.
3. В бакете → **Settings**:
   - **Bucket lock rules → Add rule**: prefix `companies/`, retention **2190 days** (6 лет) —
     файлы клиентов нельзя удалить или перезаписать 6 лет;
     ещё одно правило: prefix `db-backups/`, retention **30 days**.
   - **Object lifecycle rules → Add rule**: prefix `db-backups/`, delete objects after **90 days**.
4. R2 → **Manage API tokens → Create API token** (Account API token): permission **Object Read & Write**,
   **Apply to specific buckets only → pescada-exchange**. Сохраните Access Key ID, Secret Access Key
   и адрес **EU jurisdiction** вида `https://<id>.eu.r2.cloudflarestorage.com`.
5. На сервере в `deploy/.env` (без `#` в начале строк):
   ```
   STORAGE_DRIVER=s3
   S3_BUCKET=pescada-exchange
   S3_REGION=auto
   S3_ENDPOINT=https://<id>.eu.r2.cloudflarestorage.com
   S3_ACCESS_KEY_ID=...
   S3_SECRET_ACCESS_KEY=...
   ```
6. Перенос уже загруженных файлов и запуск:
   ```sh
   cd /opt/voixa-exchange
   bash deploy/move-files-to-r2.sh
   docker compose -f deploy/docker-compose.prod.yml up -d
   bash deploy/move-files-to-r2.sh      # ещё раз: файлы, загруженные во время переключения
   docker compose -f deploy/docker-compose.prod.yml logs --tail 5 offsite
   ```
   Число файлов «on this server» и «in the bucket» должно совпасть, а в журнале `offsite` — `offsite copy done`.

## 8. Обновление приложения

```sh
cd /opt/voixa-exchange && bash deploy/update.sh
```

Если сервер устанавливался до ноября 2026, один раз добавьте в `deploy/.env` (без `#`):
```
SECRET_KEY=<вывод команды: openssl rand -hex 32>
ALERT_EMAIL=<ваш адрес для сообщений о сбоях>
```
`SECRET_KEY` шифрует секреты двухфакторного входа. Не меняйте его после того, как бухгалтеры
включили 2FA, и храните копию вне сервера (например, в менеджере паролей).

## 9. Безопасность и надзор

- **Сбои.** На `ALERT_EMAIL` приходят письма об ошибках приложения, недоставленной почте и
  зависших задачах (не чаще одного письма на тему в 15 минут).
- **Внешняя проверка.** В UptimeRobot (бесплатно) добавьте монитор HTTP(s) на
  `https://app.pescada.io/healthz/deep?token=<WEBHOOK_TOKEN>` с интервалом 5 минут.
  Он проверяет базу, очередь писем и задания распознавания.
- **Проверка восстановления** раз в месяц: `bash deploy/restore-test.sh` — разворачивает последнюю
  копию базы во временной базе, проверяет журналы всех клиентов и удаляет её. Живая база не затрагивается.
- **Проверка журналов** на живой базе: `docker compose -f deploy/docker-compose.prod.yml exec app node src/cli.js verify-all`
- **Антивирус.** Сервис `clamav` запускается сам и занимает ~1,5 ГБ памяти (сервер с 4 ГБ — достаточно).
  Пока он загружается, файлы принимаются и проверяются позже; заражённые блокируются, обе стороны получают письмо.
- **DMARC.** Когда в Postmark → DMARC несколько недель нет чужих отправителей, смените в Cloudflare
  запись `_dmarc.pescada.io` на `v=DMARC1; p=quarantine; rua=mailto:<ваш адрес>` (позже — `p=reject`).
- **R2.** В бакете включите удаление старых (noncurrent) версий через 30 дней для префикса `db-backups/`.
- **Обновления зависимостей** предлагает Dependabot (pull request раз в неделю); CI проверяет `npm audit`.

## 10. Язык писем и интерфейса

Письма уходят на языке человека: выбранном им в «Аккаунт», иначе — по стране фирмы (для бухгалтеров)
или клиента (для клиентов): ES → испанский, IT → итальянский, FR → французский, DE → немецкий,
PT → португальский, остальные → английский. Чтобы все письма были на одном языке, задайте
`EMAIL_LANG=es` (или `en`, `it`, `fr`, `de`, `pt`); по умолчанию `auto`.

## 11. Документы по почте (in.pescada.io)

У каждого клиента появляется адрес вида `sol-y-mar-7k2@in.pescada.io`: всё, что на него присылают
с адресов участников, попадает в его пространство.

1. Postmark → Server → **Default Inbound Stream** → Settings → Inbound domain `in.pescada.io`;
   webhook `https://app.pescada.io/webhooks/postmark-inbound?token=<WEBHOOK_TOKEN>`.
2. Cloudflare DNS: запись **MX** `in` → `inbound.postmarkapp.com`, приоритет 10, DNS only.
3. `deploy/.env`: `INBOUND_DOMAIN=in.pescada.io`, перезапуск.

Письма без прохождения SPF или DKIM отклоняются (отключается `INBOUND_REQUIRE_AUTH=off`, не рекомендуется).

## 12. Самостоятельная регистрация и оплата (Stripe)

Без настроек Stripe фирма может зарегистрироваться на `/#/signup` и получает пробный период
`TRIAL_DAYS` (30 дней). Регистрацию можно выключить: `SIGNUP=off`.

Защита от фальшивых регистраций (настройки в `deploy/.env`, в скобках — значения по умолчанию):
- фирма создаётся только после того, как владелец почты откроет ссылку из письма (ссылка живёт 24 часа);
- скрытое поле-ловушка и проверка времени заполнения формы отсекают роботов; одноразовые ящики (mailinator и т. п.) не принимаются;
- не больше 5 заявок в час с одного IP и 3 писем в сутки на один адрес;
- не больше `SIGNUP_DAILY_MAX` (20) заявок в сутки всего; при превышении регистрация приостанавливается, на `ALERT_EMAIL` приходит письмо;
- в пробный период: не больше `TRIAL_MAX_CLIENTS` (10) клиентов и `TRIAL_MAX_INVITES` (20) приглашений в сутки;
- о каждой новой фирме приходит письмо на `SIGNUP_NOTIFY_EMAIL` (по умолчанию `DEMO_EMAIL`).

Чтобы снять ограничения с конкретной фирмы до оплаты, переведите её на внутренний план:
`docker compose -f deploy/docker-compose.prod.yml exec db psql -U voixa -c "update firms set plan = 'internal' where name = 'Название'"`

1. Stripe → Products → цена с ежемесячной оплатой (за клиента или за фирму).
2. Developers → Webhooks → адрес `https://app.pescada.io/webhooks/stripe`, события
   `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `invoice.payment_failed`.
3. `deploy/.env`:
   ```
   STRIPE_SECRET_KEY=...
   STRIPE_PRICE_ID=price_...       # Pescada Essential
   STRIPE_WEBHOOK_SECRET=whsec_...
   STRIPE_QUANTITY=clients     # или firm — одна подписка на фирму
   STRIPE_PRICE_ID_PRO=price_...   # Pescada Pro
   ```
   **Тарифы.** Essential — весь обмен документами, журнал, запросы, сроки, напоминания, команда,
   точное чтение банковских файлов (camt.053, MT940, CFONB 120, Norma 43, CSV) и электронных счетов.
   Pro добавляет: чтение PDF и фото через ИИ, выписки напрямую из банка, почтовый адрес для каждого
   клиента, выгрузки в бухгалтерские программы, логотип фирмы в письмах и пространствах клиентов
   (загружается в «Настройки и команда фирмы»). В пробный период включено всё. Фирма на Essential
   видит эти функции с меткой «Pro» и объяснением; клиентам метки не показываются.
   Чтобы фирмы могли сами переходить между тарифами: Stripe → Settings → Billing → Customer portal →
   Subscriptions → разрешить смену тарифа и добавить обе цены. Тариф в Pescada меняется по webhook.
   Вручную: `docker compose -f deploy/docker-compose.prod.yml exec app node src/cli.js set-tier --firm "Название" --tier pro`
   (фирмы, существовавшие до появления тарифов, получили Pro). Список с тарифами: `node src/cli.js list-firms`.
Фирмы, созданные командой `create-firm`, работают без оплаты (план internal).
Если подписка не оплачена, фирма видит всё, но не может создавать новое; клиенты не блокируются.

## 13. Банковские выписки напрямую из банка (GoCardless)

1. Зарегистрируйтесь в GoCardless Bank Account Data, получите Secret ID и Secret Key.
2. `deploy/.env`: `GOCARDLESS_SECRET_ID=...`, `GOCARDLESS_SECRET_KEY=...`, перезапуск.
Только в тарифе Pro (и в пробный период). Клиент подключает банк в своём пространстве; движения приходят выписками каждые 12 часов
(`BANK_FEED_SYNC_HOURS`). Через 90 дней банк требует повторного подтверждения — клиент получает письмо.
GoCardless и Stripe уже указаны в списке субподрядчиков сайта с 1 декабря 2026.

## 14. Сайт pescada.io

- Страница «Тарифы» (`/pricing/` и версии на 5 языках): цены записаны в `site/src/pages/pricing.mjs`
  (`PLANS`, `INCLUDED`). Меняя цены в Stripe, поменяйте их и там, затем `node site/build.mjs`.

- Заявки с формы демо приходят на `DEMO_EMAIL` (по умолчанию hello@pescada.io).
- Статистика без cookies: Cloudflare → Web Analytics → добавить сайт → скопировать token в
  `site/src/company.mjs` (`analyticsToken`) и пересобрать сайт.

## 15. Вход через Google и Microsoft, ключи доступа

**Ключи доступа (passkeys)** работают сразу, настраивать ничего не нужно. Человек добавляет ключ в
«Ваш аккаунт → Способы входа» и затем входит по Face ID, Touch ID или Windows Hello. Ключ доступа
считается двухшаговой проверкой, в том числе когда фирма её требует.

**Google** (кнопка появится, когда заданы обе переменные):
1. console.cloud.google.com → создать проект → **APIs & Services → OAuth consent screen**: тип External,
   название Pescada, логотип, support email, домены `pescada.io`; scopes: `openid`, `email`, `profile`.
2. **Credentials → Create credentials → OAuth client ID** → Web application.
   Authorized redirect URI: `https://app.pescada.io/auth/oauth/google/callback`
3. В `deploy/.env`: `GOOGLE_CLIENT_ID=...` и `GOOGLE_CLIENT_SECRET=...`, затем `bash deploy/update.sh`.
Аккаунт Google с подтверждённой почтой, совпадающей с адресом в Pescada, привязывается при первом входе сам.

**Microsoft** (рабочие и учебные аккаунты Microsoft 365):
1. portal.azure.com → **Microsoft Entra ID → App registrations → New registration**: имя Pescada,
   Supported account types: *Accounts in any organizational directory (multitenant)*,
   Redirect URI (Web): `https://app.pescada.io/auth/oauth/microsoft/callback`.
2. **Certificates & secrets → New client secret** (срок 24 месяца; поставьте напоминание продлить).
3. В `deploy/.env`: `MICROSOFT_CLIENT_ID=<Application (client) ID>`, `MICROSOFT_CLIENT_SECRET=<Value секрета>`,
   затем `bash deploy/update.sh`.
Аккаунт Microsoft никогда не сопоставляется по почте: человек один раз входит по ссылке из письма и
привязывает его в «Ваш аккаунт → Способы входа».

**Поддержка:** сообщения из кнопки «?» → «Написать нам» приходят на `SUPPORT_EMAIL`
(по умолчанию `DEMO_EMAIL`, то есть hello@pescada.io); ответ уходит прямо отправителю.

## 16. Квалифицированные метки времени на журнале (eIDAS)

Раз в час (если что-то произошло) Pescada заверяет «вершины» журналов всех клиентов, где были новые
записи, меткой времени RFC 3161. Вершина журнала математически включает все предыдущие записи и
отпечатки всех файлов, поэтому одна метка в час заверяет всё. С квалифицированным поставщиком
(eIDAS, ст. 41) закон предполагает верность даты и неизменность данных.

1. Выберите квалифицированного поставщика меток времени и проверьте его в EU Trust List Browser
   (eidas.ec.europa.eu/efda/tl-browser → страна → услуга «Qualified time stamp»). Метка любого
   квалифицированного поставщика ЕС действует во всех странах ЕС. Получите у него адрес сервиса
   (TSA URL) и, если требуется, логин и пароль.
2. В `deploy/.env`:
   ```
   TSA_URL=https://...        # адрес сервиса меток (RFC 3161)
   TSA_USER=...               # если поставщик требует
   TSA_PASSWORD=...
   TSA_NAME=Название поставщика
   TSA_QUALIFIED=yes          # только если поставщик в EU Trusted List как квалифицированный
   ```
   затем `bash deploy/update.sh`.
3. Проверка:
   ```sh
   docker compose -f deploy/docker-compose.prod.yml exec app node src/cli.js timestamp-now
   docker compose -f deploy/docker-compose.prod.yml exec app node src/cli.js verify-timestamps
   ```
Метка видна в журнале клиента («Записи до №N заверены меткой времени…») и в распечатываемом отчёте.
Полная выгрузка клиента содержит папку `timestamps/` с манифестами, токенами и инструкцией для
независимой проверки через OpenSSL. Ошибки сервиса меток приходят на `ALERT_EMAIL`.
Не ставьте `TSA_QUALIFIED=yes` для неквалифицированного сервиса: Pescada напишет «квалифицированная».

## 17. Электронная печать на PDF-отчётах (eIDAS)

Отчёт отслеживания доступен в PDF (кнопка «PDF» в журнале клиента и в карточке документа) и входит в
полную выгрузку. Если настроена печать, PDF подписывается печатью Voixa по стандарту PAdES
(ETSI.CAdES.detached), а при включённых метках времени (раздел 16) — ещё и с меткой времени подписи.
Adobe Acrobat Reader и валидатор ЕС (DSS) показывают печать и то, менялся ли документ.

**Квалифицированная печать (рекомендуется):** ключ хранится у поставщика, Pescada подписывает
удалённо по открытому API CSC (Cloud Signature Consortium v2). От поставщика нужны: квалифицированный
сертификат печати на Voixa Consultors S.L. (QSealC) с удалённой подписью, адрес API CSC, доступ
(client ID и secret), идентификатор ключа (credential ID) и, если требуется, PIN. В `deploy/.env`:
```
SEAL_NAME=Voixa Consultors S.L.
SEAL_QUALIFIED=yes                 # только для квалифицированного сертификата печати
SEAL_CSC_URL=https://...           # базовый адрес API CSC поставщика
SEAL_CSC_TOKEN_URL=https://...     # если вход (OAuth2) по отдельному адресу
SEAL_CSC_CLIENT_ID=...
SEAL_CSC_CLIENT_SECRET=...
SEAL_CSC_CREDENTIAL_ID=...
SEAL_CSC_PIN=...                   # если поставщик требует
```
**Печать из файлов** (неквалифицированная, для проверки): `SEAL_CERT_FILE`, `SEAL_KEY_FILE`, `SEAL_CHAIN_FILE`
(PEM; файлы нужно подключить в контейнер). Без настроек PDF выдаётся без печати.

## Полезные команды

```sh
cd /opt/voixa-exchange
docker compose -f deploy/docker-compose.prod.yml ps            # что запущено
docker compose -f deploy/docker-compose.prod.yml logs -f app   # журнал приложения
docker compose -f deploy/docker-compose.prod.yml restart app   # перезапуск приложения
```
