# Telegram Roulette — Render

Это серверная версия Telegram Mini App + Telegram-бота.

## Что настроить в Render

Environment Variables:
- BOT_TOKEN — токен бота от BotFather
- BOT_USERNAME — username бота без @
- ADMIN_ID — твой Telegram ID
- CHANNEL_USERNAME — username канала, например @mychannel
- CHANNEL_URL — ссылка на канал
- WEBAPP_URL — URL этого Render Web Service, например https://telegram-roulette.onrender.com
- START_COINS — обычно 0

## Важно

1. Бот должен быть администратором канала, чтобы проверка подписки через getChatMember работала надежно.
2. WEBAPP_URL должен совпадать с HTTPS URL Render.
3. В BotFather у бота нужно поставить Mini App/Menu Button на WEBAPP_URL.
4. SQLite-файл находится на диске сервиса. На бесплатном Render-файловая система может быть непостоянной при некоторых redeploy/rebuild. Для постоянного продакшена лучше подключить Postgres или persistent disk.
5. Не публикуй BOT_TOKEN в GitHub.
