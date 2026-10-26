# RIVA EARN — live Mini App project

This is a real backend-backed starter project, not a localStorage-only demo. It includes Telegram Mini App authentication, persistent SQLite records, language preference, once-per-UTC-day bonus claims, task submissions for admin review, referral links, transaction history, withdrawal requests, and admin withdrawal review/task creation.

## Important before launch
- This project does **not** automatically send real money. It records ETB balances and withdrawal requests; an authorized administrator must verify and pay requests manually using the chosen payment service.
- Configure a persistent disk for the SQLite database. Without persistent storage, some hosts can erase the database on redeploy/restart.
- Daily bonus uses UTC calendar dates. Change the date policy if you need Ethiopia local time (Africa/Addis_Ababa).
- Admin access is granted only to numeric Telegram IDs in `ADMIN_TELEGRAM_IDS`.
- Do not publish or share your BotFather token.

## Deploy on a Node.js host
1. Upload this project to a private GitHub repository or deploy the ZIP using a host that supports Node.js apps and persistent storage.
2. Build command: `npm install`
3. Start command: `npm start`
4. Set environment variables from `.env.example`: `BOT_TOKEN`, `BOT_USERNAME`, `ADMIN_TELEGRAM_IDS`, `DAILY_BONUS_ETB`, and `DB_PATH`.
5. Use an HTTPS domain provided by your host.
6. In Telegram, open `@BotFather` → `/mybots` → select `RivaEarnBot` → `Bot Settings` → `Mini Apps` → `Menu Button`. Enter your deployed HTTPS URL and title `💰 RIVA EARN`, then save.
7. Test by opening the Mini App from inside Telegram. Opening the website directly in a normal browser will not authenticate because Telegram initData is required.

## Telegram bot setup
- Make sure your bot username is set correctly in `BOT_USERNAME` (without `@`).
- The `startapp=ref_<telegram_id>` referral deep link requires the bot's Mini App to be configured and opened through Telegram.
- This app does not need or use a user's Telegram password or login code.

## API overview
- `GET /health` health check
- Authenticated Mini App routes: `/api/me`, `/api/language`, `/api/bonus`, `/api/tasks`, `/api/tasks/:id/complete`, `/api/invite`, `/api/withdraw`, `/api/history`
- Admin routes (restricted by Telegram ID): `/api/admin/overview`, `/api/admin/withdrawals`, `/api/admin/withdrawals/:id/review`, `/api/admin/tasks`

## Current limitations to address before a public launch
- Add task-completion approval UI for admins (submissions are stored as pending).
- Add rate limiting and operational monitoring.
- Set and test the appropriate Ethiopia-local daily reset policy.
- Confirm legal, tax, consumer-protection, and payment-provider requirements for ETB rewards.
- Add backups and a database migration strategy.
