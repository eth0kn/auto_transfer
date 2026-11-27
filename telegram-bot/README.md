# Telegram Bot — Remote Admin

Sibling PM2 process to `unified-backend`, same folder (`/var/automate/auto_transfer/`).

Feature concept: [../docs/feature_telegram_bot_concept_2026-11-21.md](../docs/feature_telegram_bot_concept_2026-11-21.md)
Sprint 1 tracking: [../docs/feature_telegram_bot_sprint1_2026-11-22.md](../docs/feature_telegram_bot_sprint1_2026-11-22.md)

## Setup

```bash
# 1. Install deps (run from telegram-bot/ folder)
cd /var/automate/auto_transfer/telegram-bot
npm install

# 2. Add bot config to root .env (shared with unified-backend)
echo "
# Telegram Bot
TELEGRAM_BOT_TOKEN=1234567890:ABCdefGHI...
OWNER_CHAT_ID=999000111
TG_BOT_API_KEY=changeme-random-32-hex-chars-here
BACKEND_URL=http://127.0.0.1:3010
TG_CONFIRM_TTL_SEC=60
TG_RATE_LIMIT_PER_MIN=10
TG_WIZARD_TIMEOUT_MIN=15
TG_AUDIT_RETENTION_DAYS=90
TG_SHADOW_ENABLED=true
TG_SHADOW_FILTER=all
" >> /var/automate/auto_transfer/.env

# 3. Apply migration
cd /var/automate/auto_transfer
mysql -u $DB_USER -p$DB_PASSWORD $DB_NAME < migrations/2026-11-22_add_telegram_bot_tables.sql

# 4. Start via PM2 (from auto_transfer root)
cd /var/automate/auto_transfer
pm2 start ecosystem.config.js --only telegram-bot

# 5. Verify
pm2 logs telegram-bot --lines 30 --nostream
```

## How to Create Bot Token

1. Open Telegram, search `@BotFather`
2. Send `/newbot`
3. Set name (e.g., "AutoTransfer Admin Bot")
4. Set username (e.g., `AutoTransferAdminBot`) — must end with `bot`
5. Copy the token
6. Paste to `.env` `TELEGRAM_BOT_TOKEN=`

## How to Find Owner chat_id

1. Open Telegram, search `@userinfobot`
2. Send any message
3. Copy "Id: xxxxx"
4. Paste to `.env` `OWNER_CHAT_ID=xxxxx`

## Operations

- **Logs**: `pm2 logs telegram-bot`
- **Restart**: `pm2 restart telegram-bot`
- **Stop**: `pm2 stop telegram-bot`
- **Status**: `pm2 status telegram-bot`

## Commands (Sprint 1)

### Public (any role)
- `/start` — greeting
- `/whoami` — show your role
- `/help` — commands for your role

### Operator + Owner
- `/list` — list approved RDPs
- `/status` — system status (RDPs + operators count)

### Owner Only
- `/list_rdp` — list all RDPs (pending + approved + revoked)
- `/approve_rdp <hostname>` — approve pending RDP
- `/revoke_rdp <hostname>` — revoke RDP
- `/list_operators` — list all operators
- `/create_operator <chat_id> <display_name>` — add new operator (auto-approved)
- `/revoke_operator <chat_id>` — revoke operator
- `/delete_operator <chat_id>` — hard delete operator
- `/shadow` — show shadow settings
- `/shadow on|off` — toggle shadow forwarding
- `/shadow filter <all|destructive|errors>` — set filter
- `/audit [chat_id] [limit]` — view audit log

## Security Model

- **Owner identity**: hardcoded in `.env` (`OWNER_CHAT_ID`), NOT in DB — prevents DB-based elevation
- **Operator identity**: DB table `operators`, status='approved' required
- **Unknown**: reject + notify owner
- **3-tier defense**:
  1. Private chat only (reject group/supergroup/channel)
  2. No forwarded commands (prevents social engineering)
  3. Role resolution (owner > operator > unknown)

## Troubleshooting

### Bot won't start
```
🔴 [BOT] TELEGRAM_BOT_TOKEN not set
```
→ Add `TELEGRAM_BOT_TOKEN=...` to root `.env`

```
🔴 [BOT] OWNER_CHAT_ID not set or invalid
```
→ Add `OWNER_CHAT_ID=999000111` (numeric string) to root `.env`

```
🔴 [BOT] operators table missing
```
→ Run migration:
```bash
mysql -u $DB_USER -p$DB_PASSWORD $DB_NAME < /var/automate/auto_transfer/migrations/2026-11-22_add_telegram_bot_tables.sql
```

### Bot doesn't respond
1. Check PM2: `pm2 status telegram-bot` → should show "online"
2. Check logs: `pm2 logs telegram-bot --lines 50 --nostream`
3. Verify token: `curl https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe`

### Owner permission denied
→ Verify `OWNER_CHAT_ID` in `.env` matches your actual Telegram user_id (not username). Use `@userinfobot` to confirm.
