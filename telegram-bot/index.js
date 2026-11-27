/**
 * Telegram Bot — Remote Admin for auto_transfer + clientapps.
 *
 * Runs as PM2 app `telegram-bot`, sibling to `unified-backend`.
 * Shares .env at /var/automate/auto_transfer/.env (via root dotenv.config()).
 */

// Load shared .env from root (parent directory)
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { Telegraf } = require('telegraf');
const { roleMiddleware } = require('./middleware');
const { registerHandlers } = require('./handlers');
const { pool } = require('./db');
// Shadow state persistence via app_config (loaded at boot)
const { initShadowState, shadowState } = require('./shadow');
// Retention cron — purge old audit + expired wizard rows
const { purgeOldAudit } = require('./audit');
const { cleanupExpired: cleanupExpiredWizards } = require('./wizard');

// ==========================================================
// Config Validation (fail-fast)
// ==========================================================
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OWNER = process.env.OWNER_CHAT_ID;

if (!TOKEN) {
    console.error('🔴 [BOT] TELEGRAM_BOT_TOKEN not set in .env — refusing to start');
    process.exit(1);
}
if (!OWNER || !/^\d+$/.test(OWNER)) {
    console.error('🔴 [BOT] OWNER_CHAT_ID not set or invalid (must be numeric string) — refusing to start');
    console.error('   Current value:', OWNER);
    process.exit(1);
}

// ==========================================================
// Bot Init
// ==========================================================
const bot = new Telegraf(TOKEN);

// Middleware chain: role resolver first
bot.use(roleMiddleware);

// Register all command handlers
registerHandlers(bot);

// Publish command list to Telegram so operator sees autocomplete hints when
// typing "/". Role middleware still gates execution — non-authorized users
// see the command but get rejected on invoke. Scope: default (all chats).
// Owner-only commands intentionally omitted from this public list to avoid
// info disclosure to unknown users who stumble on the bot.
const BOT_COMMANDS = [
    { command: 'start',         description: 'Greeting + role check' },
    { command: 'whoami',        description: 'Show my chat_id + role' },
    { command: 'help',          description: 'Show help text' },
    { command: 'list',          description: 'List approved RDPs in my scope' },
    { command: 'list_accounts', description: 'List all accounts across my scope (grouped per RDP + bot state)' },
    { command: 'status',        description: 'System status summary' },
    { command: 'add',           description: 'Add new account (wizard: alias, password, callback, Saldo Minimal, ADB pair)' },
    { command: 'edit',          description: 'Edit account field — /edit <alias> [rdp_hostname]' },
    { command: 'delete',        description: 'Delete account — /delete <alias> [rdp_hostname]' },
    { command: 'start_bot',     description: 'Start bot engine — /start_bot <alias> [rdp_hostname]' },
    { command: 'stop_bot',      description: 'Stop bot engine — /stop_bot <alias> [rdp_hostname]' },
    { command: 'cancel',        description: 'Cancel active wizard' },
];

// Global error handler
bot.catch((err, ctx) => {
    console.error('🔴 [BOT] Unhandled error in handler:', err);
    try {
        ctx.reply(`🔴 Bot error: ${err.message}`);
    } catch (_) { /* ignore */ }
});

// ==========================================================
// Startup Health Check
// ==========================================================
async function healthCheck() {
    try {
        const [rows] = await pool.execute('SELECT 1 AS ok');
        if (rows[0].ok === 1) {
            console.log('✅ [BOT] DB connection OK');
        }
        // Verify tables exist
        const [tables] = await pool.execute(
            `SHOW TABLES LIKE 'operators'`
        );
        if (tables.length === 0) {
            console.error('🔴 [BOT] operators table missing — run migrations/2026-11-22_add_telegram_bot_tables.sql');
            process.exit(1);
        }
        console.log('✅ [BOT] Migrations applied');
    } catch (e) {
        console.error('🔴 [BOT] DB health check failed:', e.message);
        process.exit(1);
    }
}

// ==========================================================
// Start
// ==========================================================
(async () => {
    await healthCheck();

    // Load shadow state dari app_config (fallback env kalau row belum ada)
    await initShadowState(pool);

    // Hourly retention cron — purge old audit + expired wizard rows.
    // Env TG_AUDIT_RETENTION_DAYS (default 90). Both helpers fail-open (never throw).
    // unref() so cron tick never blocks SIGTERM graceful shutdown.
    const AUDIT_RETENTION_DAYS = parseInt(process.env.TG_AUDIT_RETENTION_DAYS || '90', 10);
    const CRON_TICK_MS = 60 * 60 * 1000; // 1 hour
    const retentionCron = setInterval(async () => {
        try {
            const pruned = await purgeOldAudit(AUDIT_RETENTION_DAYS);
            if (pruned > 0) console.log(`🧹 [cron] purged ${pruned} audit log rows (>${AUDIT_RETENTION_DAYS}d)`);
        } catch (e) {
            console.error('[cron] purgeOldAudit error:', e.message);
        }
        try {
            const expired = await cleanupExpiredWizards();
            if (expired > 0) console.log(`🧹 [cron] cleaned ${expired} expired wizard rows`);
        } catch (e) {
            console.error('[cron] cleanupExpiredWizards error:', e.message);
        }
    }, CRON_TICK_MS);
    retentionCron.unref();
    console.log(`✅ [cron] retention tick scheduled — every ${CRON_TICK_MS / 60000} min (audit >${AUDIT_RETENTION_DAYS}d + wizard expired)`);

    // Log BEFORE bot.launch() because launch() long-polling never resolves
    console.log(`✅ [BOT] Telegram bot starting — long-polling mode`);
    console.log(`   Owner chat_id: ${OWNER}`);
    console.log(`   Shadow enabled: ${shadowState.enabled}`);
    console.log(`   Shadow filter: ${shadowState.filter}`);

    // Publish command list BEFORE launch — Telegram picks this up in <5s
    // for autocomplete in all chats. Non-blocking: launch continues even if
    // this fails (e.g. Telegram API slow). Setting again on each restart is
    // safe: Telegram dedupes identical lists.
    try {
        await bot.telegram.setMyCommands(BOT_COMMANDS);
        console.log(`✅ [BOT] setMyCommands published (${BOT_COMMANDS.length} commands)`);
    } catch (e) {
        console.warn(`⚠️ [BOT] setMyCommands failed (non-blocking): ${e.message}`);
    }

    try {
        await bot.launch();
        // Reaches here only on graceful shutdown
        console.log('📴 [BOT] bot.launch() resolved (shutdown in progress)');
    } catch (e) {
        console.error('🔴 [BOT] Failed to start:', e.message);
        process.exit(1);
    }
})();

// Graceful shutdown
process.once('SIGINT', () => {
    console.log('📴 [BOT] SIGINT — stopping bot');
    bot.stop('SIGINT');
    pool.end().catch(() => {});
});
process.once('SIGTERM', () => {
    console.log('📴 [BOT] SIGTERM — stopping bot');
    bot.stop('SIGTERM');
    pool.end().catch(() => {});
});

// Crash safety
process.on('unhandledRejection', (reason) => {
    console.error('🔥 [BOT] [UNHANDLED REJECTION]', reason);
});
process.on('uncaughtException', (err) => {
    console.error('💥 [BOT] [UNCAUGHT EXCEPTION]', err.stack || err);
});
