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

## 5. Почта (Postmark)

Пока в `deploy/.env` стоит `MAIL_TRANSPORT=console`, письма (приглашения клиентам, уведомления)
не уходят, а пишутся в журнал приложения: `docker compose -f deploy/docker-compose.prod.yml logs app`.

1. Зарегистрируйтесь на postmarkapp.com, создайте Server, подтвердите домен `pescada.io`
   (Postmark покажет DKIM- и Return-Path-записи — добавьте их в Cloudflare DNS, тоже «DNS only»).
2. В `deploy/.env`:
   ```
   MAIL_TRANSPORT=postmark
   POSTMARK_TOKEN=<Server API token>
   MAIL_FROM=Voixa Exchange <notifications@pescada.io>
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

## Полезные команды

```sh
cd /opt/voixa-exchange
docker compose -f deploy/docker-compose.prod.yml ps            # что запущено
docker compose -f deploy/docker-compose.prod.yml logs -f app   # журнал приложения
docker compose -f deploy/docker-compose.prod.yml restart app   # перезапуск приложения
```
