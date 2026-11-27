// Telegram Bot — Owner Handlers
// Scope: OWNER_ONLY (strictest — anti-elevation enforced via requireRole in router)

const { pool } = require('../db');
const { logAudit } = require('../audit');
const { escapeHtml } = require('../util');
// /shadow persistence via app_config DB table
const { shadowState, updateShadowState } = require('../shadow');
// /revoke_rdp runtime kick via /api/tg/rdp/revoke_kick
const { postJson } = require('../backend-client');

// ==========================================================
// RDP Management
// ==========================================================

async function handleListRdp(ctx) {
    const r = ctx.state.role;
    try {
        const [rows] = await pool.execute(
            `SELECT rdp_hostname, status, last_ts_ip, bound_ts_ip, approved_by, approved_at, last_seen_at
             FROM rdp_registry ORDER BY status, rdp_hostname`
        );
        if (rows.length === 0) {
            await ctx.reply('📋 No RDPs registered yet.\n\n<i>RDPs auto-register when clientapp connects.</i>', { parse_mode: 'HTML' });
            await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/list_rdp', result: 'success' });
            return;
        }
        const sections = { pending: [], approved: [], revoked: [] };
        for (const row of rows) {
            const icon = row.status === 'approved' ? '✅' : (row.status === 'pending' ? '⏳' : '🚫');
            sections[row.status]?.push(
                `${icon} <code>${escapeHtml(row.rdp_hostname)}</code>\n   IP: ${escapeHtml(row.last_ts_ip || '-')}${row.bound_ts_ip ? ` (bound ${escapeHtml(row.bound_ts_ip)})` : ''}\n   last seen: ${escapeHtml(row.last_seen_at)}`
            );
        }
        const parts = [];
        if (sections.pending.length) parts.push(`<b>⏳ Pending (${sections.pending.length})</b>\n${sections.pending.join('\n')}`);
        if (sections.approved.length) parts.push(`<b>✅ Approved (${sections.approved.length})</b>\n${sections.approved.join('\n')}`);
        if (sections.revoked.length) parts.push(`<b>🚫 Revoked (${sections.revoked.length})</b>\n${sections.revoked.join('\n')}`);

        await ctx.reply(`📋 <b>RDP Registry</b>\n\n${parts.join('\n\n')}`, { parse_mode: 'HTML' });
        await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/list_rdp', result: 'success' });
    } catch (e) {
        console.error('[handler /list_rdp]', e.message);
        await ctx.reply(`❌ Error: ${e.message}`);
        await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/list_rdp', result: 'error', error_message: e.message });
    }
}

async function handleApproveRdp(ctx) {
    const r = ctx.state.role;
    const text = ctx.message?.text || '';
    const parts = text.split(/\s+/);
    if (parts.length < 2) {
        await ctx.reply('Usage: <code>/approve_rdp &lt;hostname&gt;</code>', { parse_mode: 'HTML' });
        await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/approve_rdp', result: 'rejected', error_message: 'missing_arg' });
        return;
    }
    const hostname = parts[1];

    try {
        const [rows] = await pool.execute(
            `SELECT * FROM rdp_registry WHERE rdp_hostname = ? LIMIT 1`,
            [hostname]
        );
        if (rows.length === 0) {
            await ctx.reply(`❌ RDP <code>${escapeHtml(hostname)}</code> not found in registry.`, { parse_mode: 'HTML' });
            await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/approve_rdp', args: hostname, result: 'error', error_message: 'not_found' });
            return;
        }
        if (rows[0].status === 'approved') {
            await ctx.reply(`ℹ️ RDP <code>${escapeHtml(hostname)}</code> already approved.`, { parse_mode: 'HTML' });
            return;
        }
        await pool.execute(
            `UPDATE rdp_registry SET status = 'approved', approved_by = ?, approved_at = NOW(), bound_ts_ip = ?, revoked_at = NULL WHERE rdp_hostname = ?`,
            [r.chat_id, rows[0].last_ts_ip, hostname]
        );
        await ctx.reply(`✅ RDP <code>${escapeHtml(hostname)}</code> approved.\n   Bound IP: ${escapeHtml(rows[0].last_ts_ip || '-')}`, { parse_mode: 'HTML' });
        await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/approve_rdp', args: hostname, result: 'success' });
    } catch (e) {
        console.error('[handler /approve_rdp]', e.message);
        await ctx.reply(`❌ Error: ${e.message}`);
        await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/approve_rdp', args: hostname, result: 'error', error_message: e.message });
    }
}

async function handleRevokeRdp(ctx) {
    const r = ctx.state.role;
    const text = ctx.message?.text || '';
    const parts = text.split(/\s+/);
    if (parts.length < 2) {
        await ctx.reply('Usage: <code>/revoke_rdp &lt;hostname&gt;</code>', { parse_mode: 'HTML' });
        await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/revoke_rdp', result: 'rejected', error_message: 'missing_arg' });
        return;
    }
    const hostname = parts[1];

    try {
        const [result] = await pool.execute(
            `UPDATE rdp_registry SET status = 'revoked', revoked_at = NOW() WHERE rdp_hostname = ? AND status != 'revoked'`,
            [hostname]
        );
        if (result.affectedRows === 0) {
            await ctx.reply(`❌ RDP <code>${escapeHtml(hostname)}</code> not found or already revoked.`, { parse_mode: 'HTML' });
            await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/revoke_rdp', args: hostname, result: 'error', error_message: 'not_found_or_already_revoked' });
            return;
        }
        // Kick existing sockets via /api/tg/rdp/revoke_kick. Backend force-disconnects
        // bot + control sockets. Register gate at bot:register + rdp:control_register
        // prevents re-register — clientapp loop reconnect gets rejected.
        let kickDetail = '';
        try {
            const kickResp = await postJson('/rdp/revoke_kick', { hostname });
            if (kickResp.ok) {
                const bot = kickResp.data?.bot_disconnected ?? 0;
                const ctl = kickResp.data?.control_disconnected ?? 0;
                kickDetail = `\n<i>Runtime kick: ${bot} bot socket + ${ctl} control socket disconnected. Re-register blocked (revoke gate).</i>`;
            } else {
                kickDetail = `\n<i>⚠️ Runtime kick gagal (HTTP ${kickResp.status}) — DB status sudah revoked. Jalankan pm2 reload unified-backend kalau socket masih aktif.</i>`;
            }
        } catch (e) {
            kickDetail = `\n<i>⚠️ Runtime kick error: ${escapeHtml(e.message)}</i>`;
        }
        await ctx.reply(`🚫 RDP <code>${escapeHtml(hostname)}</code> revoked.${kickDetail}`, { parse_mode: 'HTML' });
        await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/revoke_rdp', args: hostname, result: 'success' });
    } catch (e) {
        console.error('[handler /revoke_rdp]', e.message);
        await ctx.reply(`❌ Error: ${e.message}`);
        await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/revoke_rdp', args: hostname, result: 'error', error_message: e.message });
    }
}

// ==========================================================
// Operator Management
// ==========================================================

async function handleListOperators(ctx) {
    const r = ctx.state.role;
    try {
        const [rows] = await pool.execute(
            `SELECT chat_id, username, display_name, status, approved_at, last_active_at
             FROM operators ORDER BY status, chat_id`
        );
        if (rows.length === 0) {
            await ctx.reply('📋 No operators registered yet.\n\n<i>Add via /create_operator &lt;chat_id&gt; &lt;display_name&gt;</i>', { parse_mode: 'HTML' });
            return;
        }
        const lines = rows.map(o => {
            const icon = o.status === 'approved' ? '✅' : (o.status === 'pending' ? '⏳' : (o.status === 'revoked' ? '🚫' : '❌'));
            return `${icon} <code>${escapeHtml(o.chat_id)}</code> — ${escapeHtml(o.display_name || '-')}${o.username ? ' @' + escapeHtml(o.username) : ''}\n   status: ${escapeHtml(o.status)}, last active: ${escapeHtml(o.last_active_at || '-')}`;
        });
        await ctx.reply(`📋 <b>Operators</b>\n\n${lines.join('\n\n')}`, { parse_mode: 'HTML' });
        await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/list_operators', result: 'success' });
    } catch (e) {
        console.error('[handler /list_operators]', e.message);
        await ctx.reply(`❌ Error: ${e.message}`);
        await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/list_operators', args: null, result: 'error', error_message: e.message });
    }
}

async function handleCreateOperator(ctx) {
    const r = ctx.state.role;
    const text = ctx.message?.text || '';
    const parts = text.split(/\s+/);
    if (parts.length < 3) {
        await ctx.reply('Usage: <code>/create_operator &lt;chat_id&gt; &lt;display_name&gt;</code>\n\nExample: <code>/create_operator 123456789 Fajar</code>', { parse_mode: 'HTML' });
        await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/create_operator', result: 'rejected', error_message: 'missing_args' });
        return;
    }
    const chatId = parts[1];
    const displayName = parts.slice(2).join(' ');

    if (!/^\d+$/.test(chatId)) {
        await ctx.reply(`❌ chat_id must be numeric string. Got: <code>${escapeHtml(chatId)}</code>`, { parse_mode: 'HTML' });
        await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/create_operator', args: chatId, result: 'rejected', error_message: 'invalid_chat_id_format' });
        return;
    }
    // Prevent making self into operator (owner is hardcoded)
    if (chatId === r.chat_id) {
        await ctx.reply(`❌ Cannot add self (you are already owner).`);
        await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/create_operator', args: chatId, result: 'rejected', error_message: 'self_add_denied' });
        return;
    }

    try {
        await pool.execute(
            `INSERT INTO operators (chat_id, display_name, status, approved_by, approved_at)
             VALUES (?, ?, 'approved', ?, NOW())`,
            [chatId, displayName, r.chat_id]
        );
        await ctx.reply(`✅ Operator created &amp; approved.\n   ID: <code>${escapeHtml(chatId)}</code>\n   Name: ${escapeHtml(displayName)}`, { parse_mode: 'HTML' });
        await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/create_operator', args: `${chatId} ${displayName}`, result: 'success' });
    } catch (e) {
        if (e.code === 'ER_DUP_ENTRY') {
            await ctx.reply(`❌ Operator with ID <code>${escapeHtml(chatId)}</code> already exists.`, { parse_mode: 'HTML' });
            await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/create_operator', args: chatId, result: 'error', error_message: 'duplicate' });
        } else {
            console.error('[handler /create_operator]', e.message);
            await ctx.reply(`❌ Error: ${e.message}`);
            await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/create_operator', args: chatId, result: 'error', error_message: e.message });
        }
    }
}

async function handleRevokeOperator(ctx) {
    const r = ctx.state.role;
    const text = ctx.message?.text || '';
    const parts = text.split(/\s+/);
    if (parts.length < 2) {
        await ctx.reply('Usage: <code>/revoke_operator &lt;chat_id&gt;</code>', { parse_mode: 'HTML' });
        await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/revoke_operator', result: 'rejected', error_message: 'missing_arg' });
        return;
    }
    const chatId = parts[1];

    try {
        const [result] = await pool.execute(
            `UPDATE operators SET status = 'revoked', revoked_at = NOW() WHERE chat_id = ? AND status != 'revoked'`,
            [chatId]
        );
        if (result.affectedRows === 0) {
            await ctx.reply(`❌ Operator <code>${escapeHtml(chatId)}</code> not found or already revoked.`, { parse_mode: 'HTML' });
            await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/revoke_operator', args: chatId, result: 'error', error_message: 'not_found' });
            return;
        }
        // Cascade cleanup wizard state for revoked operator
        await pool.execute(`DELETE FROM wizard_sessions WHERE chat_id = ?`, [chatId]);
        // Middleware fresh-queries operators table per request (strict status='approved'
        // filter, zero cache). Revoked operator role resolves to 'unknown' on NEXT TG
        // action → any destructive command denied. Bots are per-account (not per-operator),
        // so no "stop bots" semantic applies.
        await ctx.reply(`🚫 Operator <code>${escapeHtml(chatId)}</code> revoked.\n\n<i>Wizard sessions cleaned. Next command from this chat_id akan ditolak (role → unknown).</i>`, { parse_mode: 'HTML' });
        await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/revoke_operator', args: chatId, result: 'success' });
    } catch (e) {
        console.error('[handler /revoke_operator]', e.message);
        await ctx.reply(`❌ Error: ${e.message}`);
        await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/revoke_operator', args: chatId, result: 'error', error_message: e.message });
    }
}

async function handleDeleteOperator(ctx) {
    const r = ctx.state.role;
    const text = ctx.message?.text || '';
    const parts = text.split(/\s+/);
    if (parts.length < 2) {
        await ctx.reply('Usage: <code>/delete_operator &lt;chat_id&gt;</code>\n\n⚠️ <i>Hard delete — audit trail lost. Prefer /revoke_operator.</i>', { parse_mode: 'HTML' });
        await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/delete_operator', result: 'rejected', error_message: 'missing_arg' });
        return;
    }
    const chatId = parts[1];

    try {
        const [result] = await pool.execute(
            `DELETE FROM operators WHERE chat_id = ?`,
            [chatId]
        );
        if (result.affectedRows === 0) {
            await ctx.reply(`❌ Operator <code>${escapeHtml(chatId)}</code> not found.`, { parse_mode: 'HTML' });
            await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/delete_operator', args: chatId, result: 'error', error_message: 'not_found' });
            return;
        }
        // Cascade cleanup wizard state for deleted operator
        await pool.execute(`DELETE FROM wizard_sessions WHERE chat_id = ?`, [chatId]);
        await ctx.reply(`🗑️ Operator <code>${escapeHtml(chatId)}</code> hard-deleted.`, { parse_mode: 'HTML' });
        await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/delete_operator', args: chatId, result: 'success' });
    } catch (e) {
        console.error('[handler /delete_operator]', e.message);
        await ctx.reply(`❌ Error: ${e.message}`);
        await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/delete_operator', args: chatId, result: 'error', error_message: e.message });
    }
}

// ==========================================================
// Observability
// ==========================================================

async function handleShadow(ctx) {
    const r = ctx.state.role;
    const text = ctx.message?.text || '';
    const parts = text.trim().split(/\s+/);

    // /shadow toggle persists via app_config DB. Loaded at boot via initShadowState
    // (telegram-bot/index.js). Toggle di sini mutasi shadowState in-memory + write
    // ke DB (reuse auto_approve_enabled pattern).
    if (parts.length < 2) {
        await ctx.reply(
            `👁 <b>Shadow Observability</b>\n\n` +
            `Current: enabled=<b>${shadowState.enabled ? 'ON' : 'OFF'}</b>, filter=<code>${escapeHtml(shadowState.filter)}</code>\n\n` +
            `Usage:\n` +
            `• <code>/shadow on</code> / <code>/shadow off</code>\n` +
            `• <code>/shadow filter all|destructive|errors|off</code>\n\n` +
            `<i>Persisted via app_config DB — survives pm2 reload/restart.</i>`,
            { parse_mode: 'HTML' }
        );
        return;
    }

    const action = parts[1].toLowerCase();
    try {
        if (action === 'on') {
            await updateShadowState(pool, 'enabled', true);
            await ctx.reply(`✅ Shadow forwarding: <b>ON</b> (persisted)`, { parse_mode: 'HTML' });
        } else if (action === 'off') {
            await updateShadowState(pool, 'enabled', false);
            await ctx.reply(`🔇 Shadow forwarding: <b>OFF</b> (persisted)`, { parse_mode: 'HTML' });
        } else if (action === 'filter') {
            const level = parts[2]?.toLowerCase();
            if (!['all', 'destructive', 'errors', 'off'].includes(level)) {
                await ctx.reply(`❌ Invalid filter. Use: <code>all</code>, <code>destructive</code>, <code>errors</code>, atau <code>off</code>`, { parse_mode: 'HTML' });
                await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/shadow', args: parts.slice(1).join(' '), result: 'rejected', error_message: 'invalid_filter' });
                return;
            }
            await updateShadowState(pool, 'filter', level);
            await ctx.reply(`✅ Shadow filter: <code>${escapeHtml(level)}</code> (persisted)`, { parse_mode: 'HTML' });
        } else {
            await ctx.reply(`❌ Unknown action. Use: <code>/shadow on|off|filter &lt;level&gt;</code>`, { parse_mode: 'HTML' });
            await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/shadow', args: parts.slice(1).join(' '), result: 'rejected', error_message: 'unknown_action' });
            return;
        }
        await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/shadow', args: parts.slice(1).join(' '), result: 'success' });
    } catch (e) {
        console.error('[handler /shadow] persistence failed:', e.message);
        await ctx.reply(`❌ Error persisting shadow state: ${escapeHtml(e.message)}`, { parse_mode: 'HTML' });
        await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/shadow', args: parts.slice(1).join(' '), result: 'error', error_message: e.message });
    }
}

async function handleAudit(ctx) {
    const r = ctx.state.role;
    const text = ctx.message?.text || '';
    const parts = text.trim().split(/\s+/);
    let chatIdFilter = null;
    let limit = 20;

    if (parts.length >= 2 && /^\d+$/.test(parts[1])) {
        // Could be chat_id or limit — if 5-10 digits assume chat_id, else limit
        if (parts[1].length >= 5) {
            chatIdFilter = parts[1];
            if (parts.length >= 3 && /^\d+$/.test(parts[2])) {
                limit = Math.min(parseInt(parts[2], 10), 100);
            }
        } else {
            limit = Math.min(parseInt(parts[1], 10), 100);
        }
    }

    try {
        let rows;
        if (chatIdFilter) {
            [rows] = await pool.execute(
                `SELECT * FROM tg_audit_log WHERE chat_id = ? ORDER BY created_at DESC LIMIT ?`,
                [chatIdFilter, limit]
            );
        } else {
            [rows] = await pool.execute(
                `SELECT * FROM tg_audit_log ORDER BY created_at DESC LIMIT ?`,
                [limit]
            );
        }
        if (rows.length === 0) {
            await ctx.reply('📋 Audit log empty.');
            return;
        }
        const lines = rows.map(x => {
            const icon = x.result === 'success' ? '✅' : (x.result === 'denied' ? '🚫' : (x.result === 'error' ? '🔴' : '⚠️'));
            return `${icon} <code>${escapeHtml(x.chat_id)}</code> [${escapeHtml(x.role)}] ${escapeHtml(x.cmd || '-')}${x.args ? ' ' + escapeHtml(x.args) : ''} — ${escapeHtml(x.result)}${x.error_message ? ' (' + escapeHtml(x.error_message) + ')' : ''}\n   ${escapeHtml(x.created_at)}`;
        });
        const header = chatIdFilter ? `<b>Audit log for ${escapeHtml(chatIdFilter)}</b> (last ${limit})` : `<b>Audit log</b> (last ${limit})`;
        await ctx.reply(`${header}\n\n${lines.join('\n\n')}`, { parse_mode: 'HTML' });
        await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/audit', args: parts.slice(1).join(' '), result: 'success' });
    } catch (e) {
        console.error('[handler /audit]', e.message);
        await ctx.reply(`❌ Error: ${e.message}`);
        await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/audit', result: 'error', error_message: e.message });
    }
}

module.exports = {
    handleListRdp, handleApproveRdp, handleRevokeRdp,
    handleListOperators, handleCreateOperator, handleRevokeOperator, handleDeleteOperator,
    handleShadow, handleAudit
};
