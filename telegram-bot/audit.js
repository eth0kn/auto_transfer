// Telegram Bot — Audit Log Helper
// Log ALL commands to tg_audit_log.
// Safe to call from any handler — errors logged, never thrown (fail-open).

const { pool } = require('./db');

/**
 * Log one command execution to tg_audit_log.
 * @param {object} params
 * @param {string} params.chat_id
 * @param {'owner'|'operator'|'unknown'} params.role
 * @param {string} params.cmd  e.g. "/approve_rdp"
 * @param {string} [params.args]
 * @param {'success'|'denied'|'error'|'rejected'} params.result
 * @param {string} [params.error_message]
 */
async function logAudit(params) {
    const { chat_id, role, cmd, args, result, error_message } = params;
    try {
        await pool.execute(
            'INSERT INTO tg_audit_log (chat_id, role, cmd, args, result, error_message) VALUES (?, ?, ?, ?, ?, ?)',
            [
                String(chat_id),
                role,
                cmd || null,
                args || null,
                result,
                error_message || null
            ]
        );
    } catch (e) {
        console.error('[audit] insert failed:', e.message);
    }
}

/**
 * Purge audit log rows older than N days.
 * Called periodically from telegram-bot/index.js retention cron.
 * Fail-open — returns 0 on error (console.error logged).
 * @param {number} days  retention window in days (default 90 if invalid)
 * @returns {Promise<number>} count of rows deleted
 */
async function purgeOldAudit(days) {
    const d = Number.isFinite(days) && days > 0 ? Math.floor(days) : 90;
    try {
        const [result] = await pool.execute(
            'DELETE FROM tg_audit_log WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)',
            [d]
        );
        return result.affectedRows || 0;
    } catch (e) {
        console.error('[audit] purge failed:', e.message);
        return 0;
    }
}

module.exports = { logAudit, purgeOldAudit };
