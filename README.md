# Browser Income API

Backend-сервис на Node.js и Express для получения статистики дохода через браузерную автоматизацию.

Проект использует Puppeteer, persistent browser profile, cookies/localStorage persistence, очередь запросов, retry-механику, keepalive и защиту API через ключ доступа.

Сервис рассчитан на запуск на Linux VPS через systemd и предназначен для стабильного получения данных из веб-интерфейса, где прямой API недоступен или недостаточен.

## Стек

- Node.js
- Express
- Puppeteer
- puppeteer-extra
- puppeteer-extra-plugin-stealth
- dotenv
- Linux VPS
- systemd

## Возможности

- REST API для получения статистики дохода за выбранный период
- Браузерная автоматизация через Puppeteer
- Persistent browser profile
- Сохранение и восстановление cookies
- Сохранение и восстановление localStorage
- Автоматическая авторизация при истечении сессии
- Optional image captcha resolver
- Последовательная очередь запросов
- Mutex на навигацию браузера
- Retry-механизм для нестабильной навигации
- Safe reload / safe goto
- Проверка готовности страницы по DOM
- Cache TTL для повторного использования уже открытого периода
- Keepalive для поддержания браузерной сессии
- Мягкий рестарт браузера при stale-state
- API-key авторизация
- CORS-настройки
- Admin endpoints для диагностики запросов
- Graceful shutdown при SIGINT/SIGTERM
- Подготовка к запуску на VPS через systemd

## Структура проекта

```text
browser-income-api/
├── README.md
├── package.json
├── server.js
├── .env.example
├── .gitignore
└── systemd/
    └── browser-income-api.service.example
```

## Основные endpoints

### Проверка сервиса

```http
GET /browser/ping
```

Возвращает состояние сервиса, настройки keepalive и информацию о восстановлении сессии.

### Получить доход за период через GET

```http
GET /browser/income?nick=example_user&from=2026-04-01&to=2026-04-24
```

Параметры:

- `nick` — имя аккаунта/модели в таблице;
- `from` — дата начала периода в формате `YYYY-MM-DD`;
- `to` — дата конца периода в формате `YYYY-MM-DD`.

### Получить доход за период через POST

```http
POST /browser/income
```

Пример тела запроса:

```json
{
  "nick": "example_user",
  "from": "2026-04-01",
  "to": "2026-04-24"
}
```

### Просмотр последних request logs

```http
GET /browser/_logs?key=ADMIN_KEY
```

Endpoint доступен только при наличии admin key.

### Streaming request logs

```http
GET /browser/_logs/stream?key=ADMIN_KEY
```

Возвращает поток логов в формате Server-Sent Events.

### Echo endpoint для диагностики

```http
GET /browser/_echo?key=ADMIN_KEY
```

Возвращает заголовки, query-параметры и тело запроса. Используется для диагностики интеграций.

## Установка

```bash
git clone https://github.com/your-username/browser-income-api.git
cd browser-income-api

npm install
cp .env.example .env
```

После этого нужно заполнить `.env`.

## Пример `.env`

```env
PORT=8003

TARGET_ORIGIN=https://example.com
TARGET_LOCALE=ru

BROWSER_LOGIN_EMAIL=example@example.com
BROWSER_LOGIN_PASSWORD=change_me

API_KEY=change_me
ADMIN_KEY=change_me

CAPTCHA_API_KEY=

USER_DATA_DIR=./profiles/browser
AUTH_DIR=./auth

HEADFUL=0
DEBUG_LOGS=0
DEBUG_SHOTS=0

TIMEZONE=Europe/Moscow
ACCEPT_LANGUAGE=ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7
FIXED_UA=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36

KEEP_OPEN=1
KEEPALIVE_MIN=0
SOFT_RESTART_HOURS=4
MIN_SECS_BETWEEN_CALLS=2

CACHE_TTL_SEC=20

REQ_TIMEOUT_SEC=75
REQ_TIMEOUT_COLD_SEC=180

CORS_ORIGIN=
LOG_REQUESTS=0
MAX_REQ_LOGS=200
```

## Локальный запуск

```bash
npm start
```

По умолчанию сервис слушает локальный адрес:

```text
http://127.0.0.1:8003
```

## Пример запроса

```bash
curl -H "X-API-Key: change_me" \
  "http://127.0.0.1:8003/browser/income?nick=example_user&from=2026-04-01&to=2026-04-24"
```

Пример ответа:

```json
{
  "nick": "example_user",
  "income_text": "$123.45",
  "income_value": 123.45,
  "currency": "$",
  "period": {
    "from": "2026-04-01",
    "to": "2026-04-24"
  },
  "login_performed": false,
  "restored_from_files": true,
  "url": "https://example.com/ru/payout/income-statistics",
  "cache_ttl_sec": 20,
  "reused": true
}
```

## Деплой на VPS

Проект можно запускать на Linux VPS через systemd.

Пример unit-файла находится в:

```text
systemd/browser-income-api.service.example
```

Пример команд:

```bash
sudo cp systemd/browser-income-api.service.example /etc/systemd/system/browser-income-api.service
sudo systemctl daemon-reload
sudo systemctl enable browser-income-api
sudo systemctl start browser-income-api
sudo systemctl status browser-income-api
```

Просмотр логов:

```bash
journalctl -u browser-income-api.service -n 100 --no-pager
journalctl -u browser-income-api.service -f
```

## Безопасность

В репозитории не должны храниться:

- реальные логины и пароли;
- реальные API-ключи;
- реальные cookies;
- реальные localStorage-дампы;
- реальные production-домены, если они приватные;
- скриншоты с приватными данными;
- логи с приватными данными;
- папки `auth/`, `profiles/`, `shots/`;
- файл `.env`.

Все приватные значения должны передаваться через переменные окружения.

## Что реализовано

- Express API для получения статистики дохода
- Puppeteer browser automation
- Stealth plugin для браузерной автоматизации
- Persistent browser profile
- Восстановление cookies и localStorage из файлов
- Автоматическая авторизация при необходимости
- Optional image captcha resolver
- Поиск нужного аккаунта в таблице
- Парсинг денежного значения и валюты
- Последовательная очередь запросов
- Таймауты для cold/warm запросов
- Mutex на навигацию браузера
- Safe goto / safe reload с retry
- Проверка готовности страницы по DOM
- Cache TTL для повторного использования периода
- Keepalive-проверка браузера
- Мягкий рестарт браузера при stale-state
- API-key middleware
- Admin logs endpoints
- SSE stream для логов
- Graceful shutdown
- Подготовка к запуску через systemd

## Цель проекта

Цель проекта — показать практическую разработку backend-сервиса, который получает данные из веб-интерфейса через управляемую браузерную сессию.

Проект демонстрирует навыки Node.js backend-разработки, Puppeteer automation, работы с авторизацией, очередями, таймаутами, retries, browser state persistence и production-запуска на Linux-сервере.
