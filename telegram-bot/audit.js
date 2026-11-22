// Telegram Bot — Audit Log Helper
// D3: log ALL commands to tg_audit_log
// Safe to call from any handler — errors logged, never thrown (fail-open)

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

module.exports = { logAudit };
