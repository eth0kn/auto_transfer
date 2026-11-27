// Telegram Bot — Shadow Observability Helper
// Asymmetric owner monitoring:
// - Owner tau SEMUA operator command (default ON)
// - Owner chat TIDAK di-forward ke operator (asymmetric, enforced here)
//
// Rate limit batching — cooldown + accumulate dropped count. If operator spams
// within COOLDOWN_MS, drops are counted and appended to next normal send as
// "(+N prior rate-limited)".

const { escapeHtml } = require('./util');

const COOLDOWN_MS = parseInt(process.env.TG_SHADOW_COOLDOWN_MS || '2000', 10);
const operatorRateState = new Map(); // chat_id → { lastSentAt, droppedCount, firstDropAt }

// Shadow runtime state — persisted via app_config DB table.
// Loaded at bot boot via initShadowState(pool). Mutated by /shadow TG command
// (owner.js handleShadow) + persisted back via updateShadowState(pool, key, val).
// Fallback to env vars kalau DB rows belum ada.
const shadowState = {
    enabled: (process.env.TG_SHADOW_ENABLED || 'true') === 'true',
    filter:  process.env.TG_SHADOW_FILTER  || 'all',
    initialized: false, // flag — true after initShadowState() berhasil
};

/**
 * Load shadow state dari DB app_config table.
 * Fallback ke env defaults kalau row belum ada (migration period).
 * Harus dipanggil sekali di startup (telegram-bot/index.js) setelah DB connect.
 */
async function initShadowState(pool) {
    try {
        const [rows] = await pool.execute(
            "SELECT `key`, `value` FROM app_config WHERE `key` IN ('shadow_enabled','shadow_filter')"
        );
        for (const r of rows) {
            if (r.key === 'shadow_enabled') shadowState.enabled = (r.value === 'true');
            if (r.key === 'shadow_filter')  shadowState.filter  = r.value;
        }
        shadowState.initialized = true;
        console.log(`✅ [shadow] state loaded from app_config — enabled=${shadowState.enabled}, filter=${shadowState.filter}`);
    } catch (e) {
        console.warn(`⚠️ [shadow] initShadowState failed (fallback to env defaults): ${e.message}`);
        // state keeps env-derived defaults — shadowState.initialized remains false
    }
}

/**
 * Persist + mutate 1 shadow setting. Called by owner.js handleShadow.
 * @param {object} pool MySQL pool
 * @param {'enabled'|'filter'} key
 * @param {string|boolean} value — for 'enabled': true/false; for 'filter': 'all'|'destructive'|'errors'|'off'
 * @returns {Promise<void>}
 */
async function updateShadowState(pool, key, value) {
    let dbKey, dbValue;
    if (key === 'enabled') {
        dbKey = 'shadow_enabled';
        dbValue = (value === true || value === 'true') ? 'true' : 'false';
        shadowState.enabled = (dbValue === 'true');
    } else if (key === 'filter') {
        dbKey = 'shadow_filter';
        dbValue = String(value);
        shadowState.filter = dbValue;
    } else {
        throw new Error(`updateShadowState: unknown key '${key}' (expected 'enabled' or 'filter')`);
    }
    await pool.execute(
        "INSERT INTO app_config (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`)",
        [dbKey, dbValue]
    );
}

// Periodic purge of idle state (every 60s, drop entries idle > 5 min with no pending drops)
const PURGE_INTERVAL_MS = 60 * 1000;
const PURGE_IDLE_MS = 5 * 60 * 1000;
const purgeTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, state] of operatorRateState) {
        if (state.droppedCount === 0 && (now - state.lastSentAt) > PURGE_IDLE_MS) {
            operatorRateState.delete(key);
        }
    }
}, PURGE_INTERVAL_MS);
if (purgeTimer.unref) purgeTimer.unref();

/**
 * Format timestamp for shadow message (WIB).
 */
function nowWIB() {
    const now = new Date();
    const options = {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false, timeZone: 'Asia/Jakarta'
    };
    return new Intl.DateTimeFormat('id-ID', options).format(now).replace(/\//g, '-') + ' WIB';
}

/**
 * Should this shadow event be forwarded given current filter?
 */
function shouldForward(eventType, filter) {
    if (filter === 'off') return false;
    if (filter === 'all') return true;
    if (filter === 'errors') return eventType === 'error' || eventType === 'denied';
    if (filter === 'destructive') return eventType === 'destructive';
    return true;
}

/**
 * Forward operator command summary to owner chat.
 * ONE-WAY only — owner never gets fan-out to operator.
 *
 * @param {object} params
 * @param {object} params.ctx  telegraf context
 * @param {string} params.operatorChatId
 * @param {string} params.operatorLabel  e.g. "fajar @RDP-fajar-01"
 * @param {string} params.cmd
 * @param {string} params.result
 * @param {'success'|'error'|'denied'|'destructive'} [params.eventType='success']
 */
async function forwardToOwner({ ctx, operatorChatId, operatorLabel, cmd, result, eventType = 'success' }) {
    // Read from in-memory shadowState (persisted via app_config, loaded at boot).
    if (!shadowState.enabled) return;
    if (!shouldForward(eventType, shadowState.filter)) return;

    const ownerChatId = process.env.OWNER_CHAT_ID;
    if (!ownerChatId) return;

    // Asymmetric enforcement: never forward to anyone BUT owner
    if (String(operatorChatId) === String(ownerChatId)) return; // self — skip

    // Rate limit: cooldown + accumulate.
    // ONLY 'error' events bypass cooldown (genuine backend/bot failures — rare + informative).
    // 'denied' events respect cooldown — rogue operator spamming owner-only commands
    // (e.g. /approve_rdp x y z) would otherwise flood owner unthrottled.
    const bypassCooldown = (eventType === 'error');
    const key = String(operatorChatId);
    const now = Date.now();
    let state = operatorRateState.get(key);
    if (!state) {
        state = { lastSentAt: 0, droppedCount: 0, firstDropAt: 0 };
        operatorRateState.set(key, state);
    }
    if (!bypassCooldown && (now - state.lastSentAt) < COOLDOWN_MS) {
        // Within cooldown — drop + accumulate for next flush
        if (state.droppedCount === 0) state.firstDropAt = now;
        state.droppedCount++;
        return;
    }

    const icon = eventType === 'error' ? '🔴' : (eventType === 'denied' ? '🚫' : (eventType === 'destructive' ? '⚠️' : '👁'));
    const lines = [
        `${icon} <b>Shadow: operator activity</b>`,
        `👤 ${escapeHtml(operatorLabel)} (chat ${escapeHtml(operatorChatId)})`,
        `💬 <code>${escapeHtml(cmd)}</code>`,
        `→ ${escapeHtml(result)}`,
        `⏱ ${escapeHtml(nowWIB())}`
    ];
    // Append batch summary if prior drops accumulated
    if (state.droppedCount > 0) {
        const windowSec = Math.round((now - state.firstDropAt) / 1000);
        lines.push(`<i>(+${state.droppedCount} prior command${state.droppedCount === 1 ? '' : 's'} rate-limited in last ${windowSec}s)</i>`);
        state.droppedCount = 0;
        state.firstDropAt = 0;
    }

    state.lastSentAt = now;
    try {
        await ctx.telegram.sendMessage(ownerChatId, lines.join('\n'), { parse_mode: 'HTML' });
    } catch (e) {
        console.error('[shadow] forward failed:', e.message);
    }
}

/**
 * Notify owner about permission-denied attempt by an operator.
 */
async function notifyOwnerDenied(ctx, cmd) {
    const r = ctx.state.role;
    const operatorLabel = r.operator?.display_name || ctx.message?.from?.first_name || 'unknown';
    await forwardToOwner({
        ctx,
        operatorChatId: r.chat_id,
        operatorLabel,
        cmd,
        result: '❌ Permission denied',
        eventType: 'denied'
    });
}

/**
 * Notify owner about unknown user attempting command.
 */
async function notifyOwnerUnknown(ctx, cmd) {
    const ownerChatId = process.env.OWNER_CHAT_ID;
    if (!ownerChatId) return;
    const from = ctx.message?.from;
    const label = from ? `${from.first_name || '?'}${from.username ? ' @' + from.username : ''}` : '?';
    const text = [
        `⚠️ <b>Unknown user attempted command</b>`,
        `👤 ${escapeHtml(label)} (chat ${escapeHtml(from?.id || '?')})`,
        `💬 <code>${escapeHtml(cmd)}</code>`,
        `⏱ ${escapeHtml(nowWIB())}`,
        ``,
        `Approve as operator: <code>/create_operator ${escapeHtml(from?.id || 'CHAT_ID')} &lt;display_name&gt;</code>`
    ].join('\n');
    try {
        await ctx.telegram.sendMessage(ownerChatId, text, { parse_mode: 'HTML' });
    } catch (e) {
        console.error('[shadow] notifyOwnerUnknown failed:', e.message);
    }
}

module.exports = {
    forwardToOwner,
    notifyOwnerDenied,
    notifyOwnerUnknown,
    nowWIB,
    // Persistence API (app_config DB table)
    shadowState,          // live object — read .enabled / .filter
    initShadowState,      // call at bot startup (telegram-bot/index.js)
    updateShadowState,    // call from owner.js handleShadow to toggle+persist
};
