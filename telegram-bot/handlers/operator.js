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
const { startWizard, getActiveWizard, advanceWizard, cancelWizard } = require('../wizard');

// Short-lived pending-delete confirmations (callback_data cap 64 bytes)
// key = random 12-char hex id → {alias, rdp_hostname, operator_chat_id, expires_at}
// 60s TTL, auto-cleanup via setTimeout
const pendingDeletes = new Map();
const PENDING_TTL_MS = 60 * 1000;

// Sprint 2c: /edit field whitelist (mirror of backend telegram-bot-ipc.js)
const EDIT_FIELDS = [
    { key: 'username',     label: 'Username' },
    { key: 'password',     label: 'Password' },
    { key: 'callback_url', label: 'Callback URL' },
    { key: 'api_key',      label: 'API Key' },
];
const SENSITIVE_EDIT_FIELDS = new Set(['password', 'api_key']);
function maskForDisplay(field, value) {
    if (SENSITIVE_EDIT_FIELDS.has(field)) return '••••••••';
    if (typeof value !== 'string') return '-';
    return value.length > 60 ? value.slice(0, 57) + '...' : value;
}

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
    // F2 Sprint 2c mini-scan fix: result enum is success|denied|error|rejected only.
    // Pre-existing bug mirrors F9 (Sprint 2b) that already fixed the confirm path.
    await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/delete', args: `${alias}@${rdp_hostname}`, result: 'success', error_message: 'awaiting_confirm' });
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

// ==========================================================
// /edit — Sprint 2c
// Wizard flow: pick_field → await_value → confirm → POST backend
// ==========================================================

async function handleEdit(ctx) {
    const r = ctx.state.role;
    const text = ctx.message?.text || '';
    const parts = text.trim().split(/\s+/);
    if (parts.length < 3) {
        await ctx.reply(
            'Usage: <code>/edit &lt;alias&gt; &lt;rdp_hostname&gt;</code>\n\nExample: <code>/edit fajar-brimo-01 RDP-TF-BRImo1</code>',
            { parse_mode: 'HTML' }
        );
        await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/edit', result: 'rejected', error_message: 'missing_args' });
        return;
    }
    const alias = parts[1];
    const rdp_hostname = parts[2];

    try {
        await startWizard(r.chat_id, 'edit', 'pick_field', { alias, rdp_hostname });
    } catch (e) {
        console.error('[handler /edit] startWizard failed:', e.message);
        await ctx.reply(`❌ Error starting wizard: ${escapeHtml(e.message)}`, { parse_mode: 'HTML' });
        return;
    }

    const buttons = EDIT_FIELDS.map(f => ([
        { text: f.label, callback_data: `edit_field:${f.key}` }
    ]));
    buttons.push([{ text: '❌ Cancel', callback_data: 'edit_cancel' }]);

    await ctx.reply(
        `✏️ <b>Edit account</b>\n\n` +
        `Account: <code>${escapeHtml(alias)}</code>\n` +
        `RDP: <code>${escapeHtml(rdp_hostname)}</code>\n\n` +
        `Pick field to edit:`,
        {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: buttons }
        }
    );
    await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/edit', args: `${alias}@${rdp_hostname}`, result: 'success', error_message: 'wizard_started' });
}

async function handleEditFieldPick(ctx) {
    const r = ctx.state.role;
    const fieldKey = ctx.match[1];
    const active = await getActiveWizard(r.chat_id);
    if (!active || active.wizard_type !== 'edit' || active.step !== 'pick_field') {
        await ctx.answerCbQuery('⏱ Session expired. Start again with /edit.', { show_alert: true });
        try { await ctx.editMessageText('⏱ <i>Wizard expired or already handled.</i>', { parse_mode: 'HTML' }); } catch (_) {}
        return;
    }
    const fieldDef = EDIT_FIELDS.find(f => f.key === fieldKey);
    if (!fieldDef) {
        await ctx.answerCbQuery('❌ Unknown field.', { show_alert: true });
        return;
    }
    try {
        await advanceWizard(r.chat_id, 'await_value', { field: fieldKey });
    } catch (e) {
        await ctx.answerCbQuery('⏱ Session expired.', { show_alert: true });
        return;
    }
    const hint = SENSITIVE_EDIT_FIELDS.has(fieldKey)
        ? '\n\n<i>⚠️ Sensitive field — value won\'t be echoed in audit.</i>'
        : '';
    try {
        await ctx.editMessageText(
            `✏️ <b>Edit account</b>\n\n` +
            `Account: <code>${escapeHtml(active.data.alias)}</code>\n` +
            `RDP: <code>${escapeHtml(active.data.rdp_hostname)}</code>\n` +
            `Field: <b>${escapeHtml(fieldDef.label)}</b>\n\n` +
            `Send the new value as a text message.${hint}\n\n` +
            `<i>Or /cancel to abort.</i>`,
            { parse_mode: 'HTML' }
        );
    } catch (_) { /* older msg */ }
    await ctx.answerCbQuery(`Field: ${fieldDef.label}`);
    await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/edit:pick_field', args: `${active.data.alias}@${active.data.rdp_hostname}:${fieldKey}`, result: 'success' });
}

/**
 * Called from wizard text router when step === 'await_value'.
 * Returns true if handled (so router stops chain).
 */
async function handleEditValueInput(ctx, active) {
    const r = ctx.state.role;
    const value = (ctx.message?.text || '').trim();
    if (!value) {
        await ctx.reply('❌ Empty value. Send the new value or /cancel.', { parse_mode: 'HTML' });
        return true;
    }
    if (value.length > 1024) {
        await ctx.reply(`❌ Value too long (${value.length} chars, max 1024).`, { parse_mode: 'HTML' });
        return true;
    }
    try {
        await advanceWizard(r.chat_id, 'confirm', { value });
    } catch (e) {
        await ctx.reply('⏱ Wizard expired. Start again with /edit.', { parse_mode: 'HTML' });
        return true;
    }
    const fieldDef = EDIT_FIELDS.find(f => f.key === active.data.field);
    const displayValue = maskForDisplay(active.data.field, value);
    await ctx.reply(
        `⚠️ <b>Confirm edit</b>\n\n` +
        `Account: <code>${escapeHtml(active.data.alias)}</code>\n` +
        `RDP: <code>${escapeHtml(active.data.rdp_hostname)}</code>\n` +
        `Field: <b>${escapeHtml(fieldDef?.label || active.data.field)}</b>\n` +
        `New value: <code>${escapeHtml(displayValue)}</code>\n\n` +
        `<i>This stops the bot on this alias before applying.</i>`,
        {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [[
                    { text: '✅ YES, apply', callback_data: 'edit_confirm:ok' },
                    { text: '❌ Cancel', callback_data: 'edit_confirm:no' }
                ]]
            }
        }
    );
    await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/edit:await_value', args: `${active.data.alias}@${active.data.rdp_hostname}:${active.data.field}`, result: 'success' });
    return true;
}

async function handleEditConfirm(ctx) {
    const r = ctx.state.role;
    const decision = ctx.match[1]; // 'ok' | 'no'
    const active = await getActiveWizard(r.chat_id);
    if (!active || active.wizard_type !== 'edit' || active.step !== 'confirm') {
        await ctx.answerCbQuery('⏱ Session expired or already handled.', { show_alert: true });
        try { await ctx.editMessageText('⏱ <i>Wizard expired or already handled.</i>', { parse_mode: 'HTML' }); } catch (_) {}
        return;
    }

    if (decision === 'no') {
        await cancelWizard(r.chat_id);
        try { await ctx.editMessageText('❌ <i>Edit canceled.</i>', { parse_mode: 'HTML' }); } catch (_) {}
        await ctx.answerCbQuery('Canceled.');
        await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/edit:cancel', args: `${active.data.alias}@${active.data.rdp_hostname}:${active.data.field}`, result: 'success' });
        return;
    }

    // decision === 'ok' — call backend
    // F1 Sprint 2c mini-scan fix: atomic CAS transition confirm→applying.
    // Only the first caller gets affectedRows=1 — a rapid double-click's second callback
    // gets 'no active wizard' and we no-op, preventing duplicate destructive calls
    // (critical for Sprint 2e when this triggers real clientapp socket emits).
    try {
        await advanceWizard(r.chat_id, 'applying', {}, 'confirm');
    } catch (_) {
        await ctx.answerCbQuery('⏳ Already processing.', { show_alert: false });
        return;
    }
    const { alias, rdp_hostname, field, value } = active.data;
    const resp = await postJson('/account/edit', {
        alias,
        rdp_hostname,
        field,
        value,
        operator_chat_id: r.chat_id
    });

    const displayValue = maskForDisplay(field, value);
    let replyText, auditResult, auditErrMsg = null;
    if (resp.ok) {
        replyText = `✅ Edit applied.\n<code>${escapeHtml(alias)}@${escapeHtml(rdp_hostname)}</code> · ${escapeHtml(field)}=<code>${escapeHtml(displayValue)}</code>`;
        auditResult = 'success';
    } else if (resp.status === 501) {
        replyText = `⚠️ <b>Scaffold accepted</b>\n\nBackend auth+scope+field OK.\nClientapp support coming Sprint 2e.\n\n<code>${escapeHtml(alias)}@${escapeHtml(rdp_hostname)}</code> · ${escapeHtml(field)}=<code>${escapeHtml(displayValue)}</code>\n\n<i>Status 501: ${escapeHtml(resp.data?.detail || 'not implemented')}</i>`;
        auditResult = 'success';
        auditErrMsg = 'sprint2c_scaffold_queued';
    } else if (resp.status === 403) {
        replyText = `❌ Scope denied: ${escapeHtml(resp.data?.detail || 'unknown')}`;
        auditResult = 'denied';
        auditErrMsg = resp.data?.detail || 'scope_denied';
    } else if (resp.status === 400) {
        replyText = `❌ Invalid: ${escapeHtml(resp.data?.detail || resp.data?.error || 'bad_request')}`;
        auditResult = 'rejected';
        auditErrMsg = resp.data?.error || 'bad_request';
    } else {
        replyText = `❌ Backend error ${resp.status}: ${escapeHtml(JSON.stringify(resp.data).slice(0, 200))}`;
        auditResult = 'error';
        auditErrMsg = `http_${resp.status}`;
    }

    try { await ctx.editMessageText(replyText, { parse_mode: 'HTML' }); }
    catch (_) { await ctx.reply(replyText, { parse_mode: 'HTML' }); }
    await ctx.answerCbQuery();

    // Audit: field+alias+rdp only (value masked for sensitive, always short)
    await logAudit({
        chat_id: r.chat_id,
        role: r.role,
        cmd: '/edit:confirm',
        args: `${alias}@${rdp_hostname}:${field}=${SENSITIVE_EDIT_FIELDS.has(field) ? '***' : displayValue}`,
        result: auditResult,
        error_message: auditErrMsg
    });

    if (r.role === 'operator') {
        await forwardToOwner({
            ctx,
            operatorChatId: r.chat_id,
            operatorLabel: r.operator?.display_name || 'operator',
            cmd: '/edit',
            result: `${alias}@${rdp_hostname} · ${field} → ${auditResult}`,
            eventType: resp.ok || resp.status === 501 ? 'destructive' : 'error'
        });
    }

    // F1 fix: release the atomic lock (step='applying' → gone). Cancel is idempotent.
    await cancelWizard(r.chat_id);
}

async function handleEditCancelAction(ctx) {
    const r = ctx.state.role;
    const active = await getActiveWizard(r.chat_id);
    if (active && active.wizard_type === 'edit') {
        await cancelWizard(r.chat_id);
    }
    try { await ctx.editMessageText('❌ <i>Edit canceled.</i>', { parse_mode: 'HTML' }); } catch (_) {}
    await ctx.answerCbQuery('Canceled.');
    await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/edit:cancel', args: active?.data ? `${active.data.alias}@${active.data.rdp_hostname}` : null, result: 'success' });
}

module.exports = {
    handleList, handleStatus,
    handleDelete, handleDeleteConfirm, handleDeleteCancel,
    handleEdit, handleEditFieldPick, handleEditValueInput, handleEditConfirm, handleEditCancelAction
};
