// Telegram Bot — Owner Handlers
// Scope: OWNER_ONLY (strictest — anti-elevation enforced via requireRole in router)

const { pool } = require('../db');
const { logAudit } = require('../audit');

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
            await ctx.reply('📋 No RDPs registered yet.\n\n_RDPs auto-register when clientapp connects._');
            await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/list_rdp', result: 'success' });
            return;
        }
        const sections = { pending: [], approved: [], revoked: [] };
        for (const row of rows) {
            const icon = row.status === 'approved' ? '✅' : (row.status === 'pending' ? '⏳' : '🚫');
            sections[row.status]?.push(
                `${icon} \`${row.rdp_hostname}\`\n   IP: ${row.last_ts_ip || '-'}${row.bound_ts_ip ? ` (bound ${row.bound_ts_ip})` : ''}\n   last seen: ${row.last_seen_at}`
            );
        }
        const parts = [];
        if (sections.pending.length) parts.push(`*⏳ Pending (${sections.pending.length})*\n${sections.pending.join('\n')}`);
        if (sections.approved.length) parts.push(`*✅ Approved (${sections.approved.length})*\n${sections.approved.join('\n')}`);
        if (sections.revoked.length) parts.push(`*🚫 Revoked (${sections.revoked.length})*\n${sections.revoked.join('\n')}`);

        await ctx.reply(`📋 *RDP Registry*\n\n${parts.join('\n\n')}`, { parse_mode: 'Markdown' });
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
        await ctx.reply('Usage: `/approve_rdp <hostname>`', { parse_mode: 'Markdown' });
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
            await ctx.reply(`❌ RDP \`${hostname}\` not found in registry.`, { parse_mode: 'Markdown' });
            await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/approve_rdp', args: hostname, result: 'error', error_message: 'not_found' });
            return;
        }
        if (rows[0].status === 'approved') {
            await ctx.reply(`ℹ️ RDP \`${hostname}\` already approved.`, { parse_mode: 'Markdown' });
            return;
        }
        await pool.execute(
            `UPDATE rdp_registry SET status = 'approved', approved_by = ?, approved_at = NOW(), bound_ts_ip = ?, revoked_at = NULL WHERE rdp_hostname = ?`,
            [r.chat_id, rows[0].last_ts_ip, hostname]
        );
        await ctx.reply(`✅ RDP \`${hostname}\` approved.\n   Bound IP: ${rows[0].last_ts_ip || '-'}`, { parse_mode: 'Markdown' });
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
        await ctx.reply('Usage: `/revoke_rdp <hostname>`', { parse_mode: 'Markdown' });
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
            await ctx.reply(`❌ RDP \`${hostname}\` not found or already revoked.`, { parse_mode: 'Markdown' });
            await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/revoke_rdp', args: hostname, result: 'error', error_message: 'not_found_or_already_revoked' });
            return;
        }
        await ctx.reply(`🚫 RDP \`${hostname}\` revoked.\n\n_Note: Sprint 1 only marks DB — kick+stop enforcement Sprint 3._`, { parse_mode: 'Markdown' });
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
            await ctx.reply('📋 No operators registered yet.\n\n_Add via /create_operator <chat_id> <display_name>_');
            return;
        }
        const lines = rows.map(o => {
            const icon = o.status === 'approved' ? '✅' : (o.status === 'pending' ? '⏳' : (o.status === 'revoked' ? '🚫' : '❌'));
            return `${icon} \`${o.chat_id}\` — ${o.display_name || '-'}${o.username ? ' @' + o.username : ''}\n   status: ${o.status}, last active: ${o.last_active_at || '-'}`;
        });
        await ctx.reply(`📋 *Operators*\n\n${lines.join('\n\n')}`, { parse_mode: 'Markdown' });
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
        await ctx.reply('Usage: `/create_operator <chat_id> <display_name>`\n\nExample: `/create_operator 123456789 Fajar`', { parse_mode: 'Markdown' });
        await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/create_operator', result: 'rejected', error_message: 'missing_args' });
        return;
    }
    const chatId = parts[1];
    const displayName = parts.slice(2).join(' ');

    if (!/^\d+$/.test(chatId)) {
        await ctx.reply(`❌ chat_id must be numeric string. Got: \`${chatId}\``, { parse_mode: 'Markdown' });
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
        await ctx.reply(`✅ Operator created & approved.\n   chat_id: \`${chatId}\`\n   display_name: ${displayName}`, { parse_mode: 'Markdown' });
        await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/create_operator', args: `${chatId} ${displayName}`, result: 'success' });
    } catch (e) {
        if (e.code === 'ER_DUP_ENTRY') {
            await ctx.reply(`❌ Operator with chat_id \`${chatId}\` already exists.`, { parse_mode: 'Markdown' });
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
        await ctx.reply('Usage: `/revoke_operator <chat_id>`', { parse_mode: 'Markdown' });
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
            await ctx.reply(`❌ Operator \`${chatId}\` not found or already revoked.`, { parse_mode: 'Markdown' });
            await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/revoke_operator', args: chatId, result: 'error', error_message: 'not_found' });
            return;
        }
        await ctx.reply(`🚫 Operator \`${chatId}\` revoked.\n\n_D5: Sprint 3 will enforce kick + stop running bots. Sprint 1 only marks DB._`, { parse_mode: 'Markdown' });
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
        await ctx.reply('Usage: `/delete_operator <chat_id>`\n\n⚠️ _Hard delete — audit trail lost. Prefer /revoke_operator._', { parse_mode: 'Markdown' });
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
            await ctx.reply(`❌ Operator \`${chatId}\` not found.`, { parse_mode: 'Markdown' });
            await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/delete_operator', args: chatId, result: 'error', error_message: 'not_found' });
            return;
        }
        await ctx.reply(`🗑️ Operator \`${chatId}\` hard-deleted.`, { parse_mode: 'Markdown' });
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

    if (parts.length < 2) {
        const current = {
            enabled: process.env.TG_SHADOW_ENABLED || 'true',
            filter: process.env.TG_SHADOW_FILTER || 'all'
        };
        await ctx.reply(
            `👁 *Shadow Observability*\n\n` +
            `Current: enabled=${current.enabled}, filter=${current.filter}\n\n` +
            `Usage:\n` +
            `• \`/shadow on\` / \`/shadow off\`\n` +
            `• \`/shadow filter all|destructive|errors\`\n\n` +
            `_Note: Sprint 1 — env vars set at bot start. Runtime toggle: Sprint 2+ persistent store._`,
            { parse_mode: 'Markdown' }
        );
        return;
    }

    const action = parts[1].toLowerCase();
    // Sprint 1: in-memory runtime override (resets on restart)
    if (action === 'on') {
        process.env.TG_SHADOW_ENABLED = 'true';
        await ctx.reply(`✅ Shadow forwarding: ON (runtime only — persist via .env)`);
    } else if (action === 'off') {
        process.env.TG_SHADOW_ENABLED = 'false';
        await ctx.reply(`🔇 Shadow forwarding: OFF (runtime only — persist via .env)`);
    } else if (action === 'filter') {
        const level = parts[2]?.toLowerCase();
        if (!['all', 'destructive', 'errors'].includes(level)) {
            await ctx.reply(`❌ Invalid filter. Use: \`all\`, \`destructive\`, or \`errors\``, { parse_mode: 'Markdown' });
            await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/shadow', args: parts.slice(1).join(' '), result: 'rejected', error_message: 'invalid_filter' });
            return;
        }
        process.env.TG_SHADOW_FILTER = level;
        await ctx.reply(`✅ Shadow filter: \`${level}\` (runtime only)`, { parse_mode: 'Markdown' });
    } else {
        await ctx.reply(`❌ Unknown action. Use: \`/shadow on|off|filter <level>\``, { parse_mode: 'Markdown' });
        await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/shadow', args: parts.slice(1).join(' '), result: 'rejected', error_message: 'unknown_action' });
        return;
    }
    await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/shadow', args: parts.slice(1).join(' '), result: 'success' });
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
            return `${icon} \`${x.chat_id}\` [${x.role}] ${x.cmd || '-'}${x.args ? ' ' + x.args : ''} — ${x.result}${x.error_message ? ' (' + x.error_message + ')' : ''}\n   ${x.created_at}`;
        });
        const header = chatIdFilter ? `*Audit log for ${chatIdFilter}* (last ${limit})` : `*Audit log* (last ${limit})`;
        await ctx.reply(`${header}\n\n${lines.join('\n\n')}`, { parse_mode: 'Markdown' });
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
