// Telegram Bot — Wizard Session Manager
// Sprint 2a (2026-11-22)
//
// One wizard per chat_id at a time (PK chat_id).
// TTL from TG_WIZARD_TIMEOUT_MIN env (default 15 min).
// state_json shape: { step: '<current_step>', data: { ...accumulated fields } }

const { pool } = require('./db');

const DEFAULT_TTL_MIN = parseInt(process.env.TG_WIZARD_TIMEOUT_MIN || '15', 10);

/**
 * Start a new wizard. Replaces any existing wizard for this chat_id.
 * @param {string} chatId
 * @param {string} wizardType  e.g. 'add', 'edit', 'delete', 'pair'
 * @param {string} initialStep
 * @param {object} [initialData={}]
 */
async function startWizard(chatId, wizardType, initialStep, initialData = {}) {
    const expiresAt = new Date(Date.now() + DEFAULT_TTL_MIN * 60 * 1000);
    const stateJson = JSON.stringify({ step: initialStep, data: initialData });
    await pool.execute(
        `INSERT INTO wizard_sessions (chat_id, wizard_type, state_json, expires_at)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
            wizard_type = VALUES(wizard_type),
            state_json = VALUES(state_json),
            expires_at = VALUES(expires_at),
            created_at = CURRENT_TIMESTAMP`,
        [chatId, wizardType, stateJson, expiresAt]
    );
}

/**
 * Get current active wizard for chat_id. Returns null if none or expired.
 * Auto-deletes expired rows.
 */
async function getActiveWizard(chatId) {
    const [rows] = await pool.execute(
        `SELECT wizard_type, state_json, expires_at FROM wizard_sessions WHERE chat_id = ? LIMIT 1`,
        [chatId]
    );
    if (rows.length === 0) return null;
    const row = rows[0];
    if (new Date(row.expires_at) < new Date()) {
        // Expired — clean up
        await cancelWizard(chatId);
        return null;
    }
    let state = {};
    try {
        state = typeof row.state_json === 'string' ? JSON.parse(row.state_json) : (row.state_json || {});
    } catch (_) {
        state = {};
    }
    return {
        wizard_type: row.wizard_type,
        step: state.step || null,
        data: state.data || {},
        expires_at: row.expires_at
    };
}

/**
 * Advance wizard to next step, merge new data fields.
 */
async function advanceWizard(chatId, nextStep, mergeData = {}) {
    const current = await getActiveWizard(chatId);
    if (!current) throw new Error('no active wizard');
    const newData = { ...current.data, ...mergeData };
    const stateJson = JSON.stringify({ step: nextStep, data: newData });
    const expiresAt = new Date(Date.now() + DEFAULT_TTL_MIN * 60 * 1000);
    await pool.execute(
        `UPDATE wizard_sessions SET state_json = ?, expires_at = ? WHERE chat_id = ?`,
        [stateJson, expiresAt, chatId]
    );
    return { wizard_type: current.wizard_type, step: nextStep, data: newData };
}

/**
 * Cancel/clear wizard for chat_id. Idempotent.
 */
async function cancelWizard(chatId) {
    await pool.execute(`DELETE FROM wizard_sessions WHERE chat_id = ?`, [chatId]);
}

/**
 * Cleanup all expired wizard rows. Call from cron or periodic sweep.
 */
async function cleanupExpired() {
    const [result] = await pool.execute(`DELETE FROM wizard_sessions WHERE expires_at < NOW()`);
    return result.affectedRows || 0;
}

module.exports = { startWizard, getActiveWizard, advanceWizard, cancelWizard, cleanupExpired };
