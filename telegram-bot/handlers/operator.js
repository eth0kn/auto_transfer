// Telegram Bot — Operator Handlers
// Scope: OPERATOR_ALLOWED (operator + owner can call)
// Sprint 1: /list and /status are stubs — Sprint 2+ will wire to backend socket IPC

const { pool } = require('../db');
const { logAudit } = require('../audit');
const { forwardToOwner } = require('../shadow');

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
            await ctx.reply(`📋 No approved RDPs yet.\n\nScope: ${scope}`);
        } else {
            const lines = rdps.map(r => `• \`${r.rdp_hostname}\` — ${r.last_ts_ip || '-'} (last seen ${r.last_seen_at})`);
            await ctx.reply(`📋 *Approved RDPs*\n\nScope: ${scope}\n\n${lines.join('\n')}\n\n_Account listing per RDP: coming Sprint 2._`, { parse_mode: 'Markdown' });
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

        const rdpSummary = rdps.map(r => `${r.status}: ${r.cnt}`).join(', ') || 'none';
        const opSummary = ops.map(o => `${o.status}: ${o.cnt}`).join(', ') || 'none';

        const text = [
            `📊 *System Status*`,
            ``,
            `*RDPs*: ${rdpSummary}`,
            `*Operators*: ${opSummary}`,
            ``,
            `_Bot runtime status (Sprint 3): coming soon._`
        ].join('\n');

        await ctx.reply(text, { parse_mode: 'Markdown' });
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
