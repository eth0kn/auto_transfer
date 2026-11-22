// Telegram Bot — Shadow Observability Helper
// B2.5 locked 2026-11-22 — asymmetric owner monitoring
// - Owner tau SEMUA operator command (default ON)
// - Owner chat TIDAK di-forward ke operator (asymmetric, enforced here)

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
    const enabled = (process.env.TG_SHADOW_ENABLED || 'true') === 'true';
    if (!enabled) return;

    const filter = process.env.TG_SHADOW_FILTER || 'all';
    if (!shouldForward(eventType, filter)) return;

    const ownerChatId = process.env.OWNER_CHAT_ID;
    if (!ownerChatId) return;

    // Asymmetric enforcement: never forward to anyone BUT owner
    if (String(operatorChatId) === String(ownerChatId)) return; // self — skip

    const icon = eventType === 'error' ? '🔴' : (eventType === 'denied' ? '🚫' : (eventType === 'destructive' ? '⚠️' : '👁'));
    const text = [
        `${icon} *Shadow: operator activity*`,
        `👤 ${operatorLabel} (chat ${operatorChatId})`,
        `💬 \`${cmd}\``,
        `→ ${result}`,
        `⏱ ${nowWIB()}`
    ].join('\n');

    try {
        await ctx.telegram.sendMessage(ownerChatId, text, { parse_mode: 'Markdown' });
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
        `⚠️ *Unknown user attempted command*`,
        `👤 ${label} (chat ${from?.id || '?'})`,
        `💬 \`${cmd}\``,
        `⏱ ${nowWIB()}`,
        ``,
        `Approve as operator: \`/create_operator ${from?.id || 'CHAT_ID'} <display_name>\``
    ].join('\n');
    try {
        await ctx.telegram.sendMessage(ownerChatId, text, { parse_mode: 'Markdown' });
    } catch (e) {
        console.error('[shadow] notifyOwnerUnknown failed:', e.message);
    }
}

module.exports = { forwardToOwner, notifyOwnerDenied, notifyOwnerUnknown, nowWIB };
