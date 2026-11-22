// Telegram Bot — Operator Handlers
// Scope: OPERATOR_ALLOWED (operator + owner can call)
// Sprint 1: /list and /status are stubs — Sprint 2+ will wire to backend socket IPC
// Sprint 2b: /delete with inline-button confirm, backend IPC via REST

const crypto = require('crypto');
const { pool } = require('../db');
const { logAudit } = require('../audit');
const { forwardToOwner } = require('../shadow');
const { escapeHtml } = require('../util');
const { postJson } = require('../backend-client');

// Short-lived pending-delete confirmations (callback_data cap 64 bytes)
// key = random 12-char hex id → {alias, rdp_hostname, operator_chat_id, expires_at}
// 60s TTL, auto-cleanup via setTimeout
const pendingDeletes = new Map();
const PENDING_TTL_MS = 60 * 1000;

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

// ==========================================================
// /delete — Sprint 2b
// ==========================================================

async function handleDelete(ctx) {
    const r = ctx.state.role;
    const text = ctx.message?.text || '';
    const parts = text.trim().split(/\s+/);
    if (parts.length < 3) {
        await ctx.reply(
            'Usage: <code>/delete &lt;alias&gt; &lt;rdp_hostname&gt;</code>\n\nExample: <code>/delete fajar-brimo-01 RDP-TF-BRImo1</code>',
            { parse_mode: 'HTML' }
        );
        await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/delete', result: 'rejected', error_message: 'missing_args' });
        return;
    }
    const alias = parts[1];
    const rdp_hostname = parts[2];

    // Generate short random callback id (6 bytes = 12 hex chars — fits callback_data 64-byte cap)
    const cbid = crypto.randomBytes(6).toString('hex');
    const expiresAt = Date.now() + PENDING_TTL_MS;
    pendingDeletes.set(cbid, {
        alias,
        rdp_hostname,
        operator_chat_id: r.chat_id,
        expires_at: expiresAt
    });
    setTimeout(() => pendingDeletes.delete(cbid), PENDING_TTL_MS);

    await ctx.reply(
        `⚠️ <b>Confirm delete</b>\n\n` +
        `Account: <code>${escapeHtml(alias)}</code>\n` +
        `RDP: <code>${escapeHtml(rdp_hostname)}</code>\n\n` +
        `<i>This will stop the bot and remove the account DB row. Non-recoverable.</i>\n\n` +
        `⏱ Confirm within 60s.`,
        {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [[
                    { text: '✅ YES, delete', callback_data: `del_ok:${cbid}` },
                    { text: '❌ Cancel', callback_data: `del_no:${cbid}` }
                ]]
            }
        }
    );
    await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/delete', args: `${alias}@${rdp_hostname}`, result: 'awaiting_confirm' });
}

async function handleDeleteConfirm(ctx) {
    const r = ctx.state.role;
    const cbid = ctx.match[1];
    const pending = pendingDeletes.get(cbid);

    // Expired / already handled
    if (!pending) {
        await ctx.answerCbQuery('⏱ Expired or already handled.', { show_alert: true });
        try { await ctx.editMessageText('⏱ <i>Confirmation expired.</i>', { parse_mode: 'HTML' }); } catch (_) { /* older msg */ }
        return;
    }
    // Only original requester can confirm their own delete
    if (String(ctx.from?.id) !== String(pending.operator_chat_id)) {
        await ctx.answerCbQuery('🚫 Not your confirmation.', { show_alert: true });
        await logAudit({ chat_id: String(ctx.from?.id || 'unknown'), role: r.role, cmd: '/delete:confirm', args: cbid, result: 'rejected', error_message: 'not_requester' });
        return;
    }
    pendingDeletes.delete(cbid);

    // Call backend
    const resp = await postJson('/account/delete', {
        alias: pending.alias,
        rdp_hostname: pending.rdp_hostname,
        operator_chat_id: pending.operator_chat_id
    });

    // F9 mini-scan Sprint 2b fix: result enum is success|denied|error|rejected only.
    // Scaffold status goes in error_message instead of inventing a new result value.
    let replyText;
    let auditResult;
    let auditErrMsg = null;
    if (resp.ok) {
        replyText = `✅ Delete request accepted.\n<code>${escapeHtml(pending.alias)}@${escapeHtml(pending.rdp_hostname)}</code>`;
        auditResult = 'success';
    } else if (resp.status === 501) {
        // Sprint 2b scaffold — backend accepts auth+scope but clientapp not wired yet
        replyText = `⚠️ <b>Scaffold accepted</b>\n\nBackend auth+scope OK.\nClientapp support coming Sprint 2e.\n\n<i>Status 501: ${escapeHtml(resp.data?.detail || 'not implemented')}</i>`;
        auditResult = 'success';
        auditErrMsg = 'sprint2b_scaffold_queued';
    } else if (resp.status === 403) {
        replyText = `❌ Scope denied: ${escapeHtml(resp.data?.detail || 'unknown')}`;
        auditResult = 'denied';
        auditErrMsg = resp.data?.detail || 'scope_denied';
    } else {
        replyText = `❌ Backend error ${resp.status}: ${escapeHtml(JSON.stringify(resp.data).slice(0, 200))}`;
        auditResult = 'error';
        auditErrMsg = `http_${resp.status}`;
    }

    try {
        await ctx.editMessageText(replyText, { parse_mode: 'HTML' });
    } catch (_) {
        await ctx.reply(replyText, { parse_mode: 'HTML' });
    }
    await ctx.answerCbQuery();

    await logAudit({
        chat_id: r.chat_id,
        role: r.role,
        cmd: '/delete:confirm',
        args: `${pending.alias}@${pending.rdp_hostname}`,
        result: auditResult,
        error_message: auditErrMsg
    });

    if (r.role === 'operator') {
        await forwardToOwner({
            ctx,
            operatorChatId: r.chat_id,
            operatorLabel: r.operator?.display_name || 'operator',
            cmd: '/delete',
            result: `${pending.alias}@${pending.rdp_hostname} → ${auditResult}`,
            eventType: resp.ok || resp.status === 501 ? 'destructive' : 'error'
        });
    }
}

async function handleDeleteCancel(ctx) {
    const r = ctx.state.role;
    const cbid = ctx.match[1];
    const pending = pendingDeletes.get(cbid);

    // Only original requester can cancel their own flow
    if (pending && String(ctx.from?.id) !== String(pending.operator_chat_id)) {
        await ctx.answerCbQuery('🚫 Not your confirmation.', { show_alert: true });
        return;
    }
    pendingDeletes.delete(cbid);

    try {
        await ctx.editMessageText('❌ <i>Delete canceled.</i>', { parse_mode: 'HTML' });
    } catch (_) { /* older msg */ }
    await ctx.answerCbQuery('Canceled.');
    await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/delete:cancel', args: cbid, result: 'success' });
}

module.exports = { handleList, handleStatus, handleDelete, handleDeleteConfirm, handleDeleteCancel };
