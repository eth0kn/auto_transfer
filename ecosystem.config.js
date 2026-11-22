// ==========================================================
// R7 (2026-10-30): PM2 Ecosystem Config
// Purpose: fix PM2 log timestamp UTC → WIB (Asia/Jakarta).
// Deploy: `pm2 reload ecosystem.config.js --update-env`
// Note: `TZ` env affects `new Date().toString()` and `toLocaleString()`,
// but NOT `toISOString()` (always UTC per ECMA spec). In-code logs that
// use toISOString stay UTC — fix at source if needed (separate task).
// ==========================================================
module.exports = {
    apps: [
        {
            name: 'unified-backend',   // match existing PM2 process name di VPS
            script: 'index.js',
            cwd: __dirname,

            // Timezone env — applies to Node runtime (new Date() non-ISO methods)
            // AND PM2 log timestamp prepender below.
            env: {
                NODE_ENV: 'production',
                TZ: 'Asia/Jakarta',
                // OBS (2026-10-31): observability bundle for race investigation.
                // Set '1' to enable [OBS-BE] verbose logs. Flip to '0' or remove to disable.
                OBS_VERBOSE: '1',
            },

            // PM2 prepends this to every log line. moment() format pattern.
            // Example output: 2026-10-31 01:05:08 +0700: 🤖 [brimo] BOT REGISTERED...
            log_date_format: 'YYYY-MM-DD HH:mm:ss Z',

            // Logs
            error_file: './logs/err.log',
            out_file: './logs/out.log',
            merge_logs: true,

            // Lifecycle
            autorestart: true,
            max_memory_restart: '512M',
            watch: false,
        },
        {
            // Telegram Bot Sprint 1 (2026-11-22) — mono-repo dual-process (Opsi M)
            // Concept: docs/feature_telegram_bot_concept_2026-11-21.md
            // Separate PM2 process for fault isolation. Crash bot != backend down.
            // Shared root .env (dotenv.config loaded with absolute path in telegram-bot/index.js).
            name: 'telegram-bot',
            script: 'telegram-bot/index.js',
            cwd: __dirname,

            env: {
                NODE_ENV: 'production',
                TZ: 'Asia/Jakarta',
            },

            log_date_format: 'YYYY-MM-DD HH:mm:ss Z',

            error_file: './logs/telegram-bot-err.log',
            out_file: './logs/telegram-bot-out.log',
            merge_logs: true,

            autorestart: true,
            max_memory_restart: '256M',
            watch: false,

            // Telegraf long-polling resumes on restart — safe to crash+restart
            // Min uptime: 10s (prevent restart loop on misconfig)
            min_uptime: '10s',
            max_restarts: 10,
        },
    ],
};
