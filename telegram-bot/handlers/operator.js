// Telegram Bot — Operator Handlers
// Scope: OPERATOR_ALLOWED (operator + owner can call)
// Sprint 1: /list and /status are stubs — Sprint 2+ will wire to backend socket IPC

const { pool } = require('../db');
const { logAudit } = require('../audit');
const { forwardToOwner } = require('../shadow');
const { escapeHtml } = require('../util');

async function handleList(ctx) {
    const r = ctx.state.role;
    // Sprint 1: simplified stub — just confirm command received + list operator scope
    let scope;
    if (r.role === 'owner') {
        scope = 'ALL (owner — no RDP restriction)';
    } else {
        const allowed = r.operator?.allowed_rdp_hostnames;
        scope = allowed ? JSON.parse(allowed).join(', ') : 'all approved RDPs';
    }

    // Query pool for approved RDPs in scope
    try {
        const [rdps] = await pool.execute(
            `SELECT rdp_hostname, status, last_ts_ip, last_seen_at FROM rdp_registry WHERE status = 'approved' ORDER BY rdp_hostname`
        );
        if (rdps.length === 0) {
            await ctx.reply(`📋 No approved RDPs yet.\n\nScope: ${escapeHtml(scope)}`, { parse_mode: 'HTML' });
        } else {
            const lines = rdps.map(x => `• <code>${escapeHtml(x.rdp_hostname)}</code> — ${escapeHtml(x.last_ts_ip || '-')} (last seen ${escapeHtml(x.last_seen_at)})`);
            await ctx.reply(
                `📋 <b>Approved RDPs</b>\n\nScope: ${escapeHtml(scope)}\n\n${lines.join('\n')}\n\n<i>Account listing per RDP: coming Sprint 2.</i>`,
                { parse_mode: 'HTML' }
            );
        }
        await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/list', result: 'success' });

        if (r.role === 'operator') {
            await forwardToOwner({
                ctx,
                operatorChatId: r.chat_id,
                operatorLabel: r.operator?.display_name || 'operator',
                cmd: '/list',
                result: `Listed ${rdps.length} RDPs`
            });
        }
    } catch (e) {
        console.error('[handler /list]', e.message);
        await ctx.reply(`❌ Error: ${e.message}`);
        await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/list', result: 'error', error_message: e.message });
    }
}

async function handleStatus(ctx) {
    const r = ctx.state.role;
    try {
        const [rdps] = await pool.execute(
            `SELECT status, COUNT(*) as cnt FROM rdp_registry GROUP BY status`
        );
        const [ops] = await pool.execute(
            `SELECT status, COUNT(*) as cnt FROM operators GROUP BY status`
        );

        const rdpSummary = rdps.map(x => `${x.status}: ${x.cnt}`).join(', ') || 'none';
        const opSummary = ops.map(o => `${o.status}: ${o.cnt}`).join(', ') || 'none';

        const text = [
            `📊 <b>System Status</b>`,
            ``,
            `<b>RDPs</b>: ${escapeHtml(rdpSummary)}`,
            `<b>Operators</b>: ${escapeHtml(opSummary)}`,
            ``,
            `<i>Bot runtime status (Sprint 3): coming soon.</i>`
        ].join('\n');

        await ctx.reply(text, { parse_mode: 'HTML' });
        await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/status', result: 'success' });

        if (r.role === 'operator') {
            await forwardToOwner({
                ctx,
                operatorChatId: r.chat_id,
                operatorLabel: r.operator?.display_name || 'operator',
                cmd: '/status',
                result: `Fetched status: RDPs ${rdpSummary}, Ops ${opSummary}`
            });
        }
    } catch (e) {
        console.error('[handler /status]', e.message);
        await ctx.reply(`❌ Error: ${e.message}`);
        await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/status', result: 'error', error_message: e.message });
    }
}

module.exports = { handleList, handleStatus };
