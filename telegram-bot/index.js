/**
 * Telegram Bot — Remote Admin for auto_transfer + clientapps
 * Sprint 1 Foundation (2026-11-22)
 *
 * Concept: docs/feature_telegram_bot_concept_2026-11-21.md
 * Sprint 1: docs/feature_telegram_bot_sprint1_2026-11-22.md
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

    // Log BEFORE bot.launch() because launch() long-polling never resolves
    console.log(`✅ [BOT] Telegram bot starting — long-polling mode`);
    console.log(`   Owner chat_id: ${OWNER}`);
    console.log(`   Shadow enabled: ${process.env.TG_SHADOW_ENABLED || 'true'}`);
    console.log(`   Shadow filter: ${process.env.TG_SHADOW_FILTER || 'all'}`);

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
