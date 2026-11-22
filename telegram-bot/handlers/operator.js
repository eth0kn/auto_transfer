// Telegram Bot — Operator Handlers
// Scope: OPERATOR_ALLOWED (operator + owner can call)
// Sprint 1: /list and /status are stubs — Sprint 2+ will wire to backend socket IPC
// Sprint 2b: /delete with inline-button confirm, backend IPC via REST

const crypto = require('crypto');
const { pool } = require('../db');
const { logAudit } = require('../audit');
const { forwardToOwner } = require('../shadow');
const { escapeHtml } = require('../util');
const { postJson, getJson } = require('../backend-client');
const { startWizard, getActiveWizard, advanceWizard, cancelWizard } = require('../wizard');

// Short-lived pending-delete confirmations (callback_data cap 64 bytes)
// key = random 12-char hex id → {alias, rdp_hostname, operator_chat_id, expires_at}
// 60s TTL, auto-cleanup via setTimeout
const pendingDeletes = new Map();
const PENDING_TTL_MS = 60 * 1000;

// Sprint 3 (v4.3.10): pending alias→RDP picker when /start /stop /edit /delete
// called WITHOUT rdp_hostname and fan-out resolution returns >1 hit.
// key = 12-char hex cbid → { action, alias, candidates[], operator_chat_id, expires_at,
//                            extra: {field?, value?, ...} for action-specific context }
const pendingPickers = new Map();
const PICKER_TTL_MS = 60 * 1000;

/**
 * Sprint 3 helper — resolve alias → RDP via fan-out. Returns:
 *   - { rdp_hostname }                 // auto-resolved (1 hit) → caller proceeds
 *   - { pickerShown: true }            // N>1 hit → picker message rendered, caller returns
 *   - { error: 'not_found'|'...' }     // 0 hit / no scope → caller sends error reply
 *
 * `extraContext` is stashed in the picker's pending state so the pick callback
 * can resume the original action with full args (e.g. field/value for /edit).
 */
async function resolveAliasOrPicker(ctx, action, alias, extraContext = {}) {
    const r = ctx.state.role;
    const resp = await getJson(`/account/alias_lookup?alias=${encodeURIComponent(alias)}&operator_chat_id=${encodeURIComponent(r.chat_id)}`);
    if (!resp.ok) {
        return { error: 'lookup_failed', detail: resp.data?.detail || `status ${resp.status}` };
    }
    const hits = Array.isArray(resp.data?.hits) ? resp.data.hits : [];
    const scanned = resp.data?.scanned ?? 0;
    if (scanned === 0) return { error: 'no_rdps_in_scope' };
    if (hits.length === 0) return { error: 'alias_not_found', scanned };
    if (hits.length === 1) return { rdp_hostname: hits[0].rdp_hostname, hit: hits[0] };

    // Multi-hit → render picker
    const cbid = crypto.randomBytes(6).toString('hex');
    const expiresAt = Date.now() + PICKER_TTL_MS;
    pendingPickers.set(cbid, {
        action,
        alias,
        candidates: hits.slice(0, 10), // Telegram inline keyboard cap
        operator_chat_id: r.chat_id,
        expires_at: expiresAt,
        extra: extraContext
    });
    setTimeout(() => pendingPickers.delete(cbid), PICKER_TTL_MS);

    const buttons = hits.slice(0, 10).map((h, i) => ([
        { text: `${h.rdp_hostname} (${h.device_id || 'no-device'})`, callback_data: `pick_rdp:${cbid}:${i}` }
    ]));
    buttons.push([{ text: '❌ Cancel', callback_data: `pick_rdp:${cbid}:cancel` }]);
    await ctx.reply(
        `⚠️ <b>Alias ambiguous</b>\n\n` +
        `Alias <code>${escapeHtml(alias)}</code> ditemukan di ${hits.length} RDP.\n` +
        `Pilih yang mana untuk <b>/${escapeHtml(action)}</b>:`,
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } }
    );
    return { pickerShown: true };
}

// Sprint 2c + v4.3.6 hotfix: /edit field whitelist aligned with clientapp DB schema.
// Scanner report 2026-11-22: clientapp accounts table has NO username / api_key columns.
// Login BRImo pakai password saja (alias cuma UI label).
// v4.3.9 / Sprint 2e-3 (2026-11-22): remote_ip dropped from whitelist — auto-derived
// from device_id via CGNAT regex at clientapp side (mirror UI readonly behavior).
// keep_balance added — numeric "Sisakan Saldo Minimal (Rp)" matches clientapp modal.
// Field whitelist: alias | password | callback_url | device_id | keep_balance (5 fields).
const EDIT_FIELDS = [
    { key: 'alias',        label: 'Alias' },
    { key: 'password',     label: 'Password' },
    { key: 'callback_url', label: 'Callback URL' },
    { key: 'device_id',    label: 'Device ID' },
    { key: 'keep_balance', label: 'Saldo Minimal (Rp)' },
];
const SENSITIVE_EDIT_FIELDS = new Set(['password']);
function maskForDisplay(field, value) {
    if (SENSITIVE_EDIT_FIELDS.has(field)) return '••••••••';
    if (typeof value !== 'string') return '-';
    return value.length > 60 ? value.slice(0, 57) + '...' : value;
}

// Sprint 2d-1 + v4.3.6 hotfix: /add wizard — 3 banking fields aligned with
// clientapp schema (alias + password + callback_url). Optional bank fields
// (device_id, remote_ip, keep_balance, mutasi_enabled, mirror_enabled) defer.
// Alias constraint relaxed: unrestricted printable, ≤128 chars.
//
// Sprint 2d-2 (v4.3.7): add ADB pair step per Q2=C locked. 2 extra wizard steps
// after callback_url collect `device_ip` (IP:PAIR_PORT shown on HP wireless
// debugging dialog) + `pair_code` (6-digit shown with it). Backend sends
// `adb pair <ip> <code>` to RDP via socket at Sprint 2e; scaffold returns 501.
// Sprint 2e-3 (v4.3.9, 2026-11-22): keep_balance added — matches clientapp modal
// field "Sisakan Saldo Minimal (Rp)". Integer ≥0. Accept `0` for no threshold.
const ADD_STEPS = [
    { key: 'alias',        label: 'Alias',        prompt: 'Send the <b>alias</b> (free text, space allowed, ≤128 chars). Example: <code>Toko A 123</code>' },
    { key: 'password',     label: 'Password',     prompt: 'Send the <b>password</b> for BRImo login.\n\n<i>⚠️ Sensitive — won\'t be echoed in audit.</i>' },
    { key: 'callback_url', label: 'Callback URL', prompt: 'Send the <b>callback URL</b> (http:// or https://):' },
    { key: 'keep_balance', label: 'Saldo Minimal',prompt: 'Send the <b>minimum balance to keep</b> (Rp, integer ≥0). Send <code>0</code> for no threshold.\n\n<i>Auto-transfer refuses to run if balance would fall below this amount.</i>' },
    { key: 'device_ip',    label: 'Device IP',    prompt: 'Send the <b>pair IP:port</b> shown on HP → Settings → Developer → Wireless debugging → <i>Pair device with pairing code</i>.\n\nFormat: <code>IP:PORT</code> (example <code>100.64.0.11:40123</code>). Port changes each time — use the pairing port, not the regular ADB port.' },
    { key: 'pair_code',    label: 'Pair code',    prompt: 'Send the <b>6-digit pair code</b> shown on HP alongside the IP above.\n\n<i>⚠️ Time-sensitive — expires when the HP\'s pairing dialog closes.</i>' },
];
const SENSITIVE_ADD_FIELDS = new Set(['password', 'pair_code']);
// Allow any printable char (space, digit, latin, Indonesian, special) — ban control chars only.
const ALIAS_REGEX        = /^[^\x00-\x1F\x7F]{1,128}$/;
const URL_REGEX          = /^https?:\/\/.+/i;
const DEVICE_IP_REGEX    = /^(\d{1,3}\.){3}\d{1,3}:\d{1,5}$/;
const PAIR_CODE_REGEX    = /^\d{6}$/;
const KEEP_BALANCE_REGEX = /^\d+$/; // non-negative integer, no decimals/separators
const KEEP_BALANCE_MAX   = 9_999_999_999; // 10B Rp practical ceiling

function validateDeviceIp(value) {
    if (!DEVICE_IP_REGEX.test(value)) return false;
    const [ipPart, portPart] = value.split(':');
    const octets = ipPart.split('.').map(n => parseInt(n, 10));
    if (octets.some(o => o < 0 || o > 255 || Number.isNaN(o))) return false;
    const port = parseInt(portPart, 10);
    if (Number.isNaN(port) || port < 1 || port > 65535) return false;
    return true;
}

function validateAddField(key, value) {
    if (typeof value !== 'string' || !value.length) return { ok: false, error: 'empty' };
    if (value.length > 2048) return { ok: false, error: 'too_long' };
    if (key === 'alias') {
        if (!ALIAS_REGEX.test(value)) return { ok: false, error: 'alias_bad_chars' };
    } else if (key === 'callback_url') {
        if (!URL_REGEX.test(value)) return { ok: false, error: 'url_bad_scheme' };
    } else if (key === 'device_ip') {
        if (!validateDeviceIp(value)) return { ok: false, error: 'device_ip_bad_format' };
    } else if (key === 'pair_code') {
        if (!PAIR_CODE_REGEX.test(value)) return { ok: false, error: 'pair_code_bad_format' };
    } else if (key === 'keep_balance') {
        if (!KEEP_BALANCE_REGEX.test(value)) return { ok: false, error: 'keep_balance_bad_format' };
        const n = parseInt(value, 10);
        if (n < 0 || n > KEEP_BALANCE_MAX) return { ok: false, error: 'keep_balance_bad_range' };
    } else if (value.length > 1024) {
        return { ok: false, error: 'too_long_1024' };
    }
    return { ok: true };
}

function maskAddForDisplay(key, value) {
    if (SENSITIVE_ADD_FIELDS.has(key)) return '••••••••';
    if (typeof value !== 'string') return '-';
    return value.length > 80 ? value.slice(0, 77) + '...' : value;
}

function nextAddStep(currentKey) {
    const idx = ADD_STEPS.findIndex(s => s.key === currentKey);
    if (idx < 0 || idx >= ADD_STEPS.length - 1) return null; // last field — go to confirm
    return ADD_STEPS[idx + 1];
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
    // v4.3.10 Sprint 3: rdp_hostname OPTIONAL (alias-only mode).
    // Operator policy: alias unique cross-RDP (not enforced by code).
    if (parts.length < 2) {
        await ctx.reply(
            'Usage: <code>/delete &lt;alias&gt; [rdp_hostname]</code>\n\n' +
            'Examples:\n' +
            '• <code>/delete fajar-brimo-01</code> — auto-resolve RDP\n' +
            '• <code>/delete fajar-brimo-01 RDP-TF-BRImo1</code> — explicit routing',
            { parse_mode: 'HTML' }
        );
        await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/delete', result: 'rejected', error_message: 'missing_args' });
        return;
    }
    const alias = parts[1];
    let rdp_hostname = parts[2]; // may be undefined

    if (!rdp_hostname) {
        const resolved = await resolveAliasOrPicker(ctx, 'delete', alias);
        if (resolved.pickerShown) {
            await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/delete', args: alias, result: 'success', error_message: 'picker_shown' });
            return;
        }
        if (resolved.error) {
            const msg = {
                no_rdps_in_scope: 'Operator has no approved RDPs in scope.',
                alias_not_found: `Alias <code>${escapeHtml(alias)}</code> not found${resolved.scanned ? ` in any of ${resolved.scanned} RDP(s)` : ''}.`,
                lookup_failed: `Alias lookup failed: ${escapeHtml(resolved.detail || '?')}`
            }[resolved.error] || `Error: ${escapeHtml(resolved.error)}`;
            await ctx.reply(`❌ ${msg}`, { parse_mode: 'HTML' });
            await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/delete', args: alias, result: 'rejected', error_message: resolved.error });
            return;
        }
        rdp_hostname = resolved.rdp_hostname;
    }

    return deleteShowConfirm(ctx, alias, rdp_hostname);
}

// Sprint 3 refactor: confirm-page rendering factored out so pick_rdp picker
// can resume into it after resolving the ambiguous alias.
async function deleteShowConfirm(ctx, alias, rdp_hostname) {
    const r = ctx.state.role;
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
    // v4.3.10 Sprint 3: rdp_hostname OPTIONAL.
    if (parts.length < 2) {
        await ctx.reply(
            'Usage: <code>/edit &lt;alias&gt; [rdp_hostname]</code>\n\n' +
            'Examples:\n' +
            '• <code>/edit fajar-brimo-01</code> — auto-resolve RDP\n' +
            '• <code>/edit fajar-brimo-01 RDP-TF-BRImo1</code> — explicit routing',
            { parse_mode: 'HTML' }
        );
        await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/edit', result: 'rejected', error_message: 'missing_args' });
        return;
    }
    const alias = parts[1];
    let rdp_hostname = parts[2];

    if (!rdp_hostname) {
        const resolved = await resolveAliasOrPicker(ctx, 'edit', alias);
        if (resolved.pickerShown) {
            await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/edit', args: alias, result: 'success', error_message: 'picker_shown' });
            return;
        }
        if (resolved.error) {
            const msg = {
                no_rdps_in_scope: 'Operator has no approved RDPs in scope.',
                alias_not_found: `Alias <code>${escapeHtml(alias)}</code> not found${resolved.scanned ? ` in any of ${resolved.scanned} RDP(s)` : ''}.`,
                lookup_failed: `Alias lookup failed: ${escapeHtml(resolved.detail || '?')}`
            }[resolved.error] || `Error: ${escapeHtml(resolved.error)}`;
            await ctx.reply(`❌ ${msg}`, { parse_mode: 'HTML' });
            await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/edit', args: alias, result: 'rejected', error_message: resolved.error });
            return;
        }
        rdp_hostname = resolved.rdp_hostname;
    }

    return editShowFieldPicker(ctx, alias, rdp_hostname);
}

// Sprint 3 refactor: field-picker rendering factored out so pick_rdp picker
// can resume into it after resolving the ambiguous alias.
async function editShowFieldPicker(ctx, alias, rdp_hostname) {
    const r = ctx.state.role;
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

    // Sprint 2e-3 (v4.3.9): device_id gets a dropdown of live devices from the RDP
    // instead of free-text input. Mirrors clientapp modal behavior (<select>).
    if (fieldKey === 'device_id') {
        return handleEditFieldDeviceIdPick(ctx, active, fieldDef);
    }

    try {
        await advanceWizard(r.chat_id, 'await_value', { field: fieldKey });
    } catch (e) {
        await ctx.answerCbQuery('⏱ Session expired.', { show_alert: true });
        return;
    }
    const hint = SENSITIVE_EDIT_FIELDS.has(fieldKey)
        ? '\n\n<i>⚠️ Sensitive field — value won\'t be echoed in audit.</i>'
        : (fieldKey === 'keep_balance' ? '\n\n<i>Integer ≥0 (Rp). Send <code>0</code> for no threshold.</i>' : '');
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
 * Sprint 2e-3: device_id picker. Queries clientapp for live ADB device list,
 * renders InlineKeyboard with 1 button per device. Index-based callback_data
 * (edit_dev:<idx>) stays well under Telegram's 64-byte cap regardless of serial
 * length. Falls back to text input if no devices online or the query fails.
 */
async function handleEditFieldDeviceIdPick(ctx, active, fieldDef) {
    const r = ctx.state.role;
    const rdp = active.data.rdp_hostname;
    await ctx.answerCbQuery(`Field: ${fieldDef.label}`);
    const resp = await getJson(`/account/devices?rdp_hostname=${encodeURIComponent(rdp)}`);
    const devices = Array.isArray(resp.data?.devices) ? resp.data.devices : [];

    // No devices OR query failed → fall back to text input (keeps flow usable).
    if (!resp.ok || devices.length === 0) {
        const reason = !resp.ok
            ? (resp.status === 502 ? 'RDP offline — clientapp not connected' :
               resp.status === 504 ? 'RDP timed out (30s)' :
               resp.data?.detail || 'query failed')
            : 'no devices currently connected';
        try {
            await advanceWizard(r.chat_id, 'await_value', { field: 'device_id' });
        } catch (_) {
            await ctx.answerCbQuery('⏱ Session expired.', { show_alert: true });
            return;
        }
        try {
            await ctx.editMessageText(
                `✏️ <b>Edit account</b>\n\n` +
                `Account: <code>${escapeHtml(active.data.alias)}</code>\n` +
                `RDP: <code>${escapeHtml(rdp)}</code>\n` +
                `Field: <b>Device ID</b>\n\n` +
                `⚠️ Device dropdown unavailable: ${escapeHtml(reason)}.\n\n` +
                `Send the device serial as text (e.g. <code>100.64.0.11:5555</code> or <code>R58N21ABC2</code>).\n\n` +
                `<i>Or /cancel to abort.</i>`,
                { parse_mode: 'HTML' }
            );
        } catch (_) {}
        await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/edit:pick_field', args: `${active.data.alias}@${rdp}:device_id_fallback_text`, result: 'success', error_message: reason });
        return;
    }

    // Cache the list in wizard state so edit_dev:<idx> callback can resolve
    // without re-querying. Cap at 20 to stay well below Telegram's inline
    // keyboard button limit + state_json size.
    const capped = devices.slice(0, 20);
    try {
        await advanceWizard(r.chat_id, 'await_device_pick', { field: 'device_id', devices_cached: capped });
    } catch (_) {
        await ctx.answerCbQuery('⏱ Session expired.', { show_alert: true });
        return;
    }
    const buttons = capped.map((d, i) => ([
        { text: (d.label || d.id).slice(0, 60), callback_data: `edit_dev:${i}` }
    ]));
    buttons.push([{ text: '✏️ Type manually', callback_data: 'edit_dev_manual' }]);
    buttons.push([{ text: '❌ Cancel', callback_data: 'edit_cancel' }]);
    try {
        await ctx.editMessageText(
            `✏️ <b>Edit account</b>\n\n` +
            `Account: <code>${escapeHtml(active.data.alias)}</code>\n` +
            `RDP: <code>${escapeHtml(rdp)}</code>\n` +
            `Field: <b>Device ID</b>\n\n` +
            `Pick device (${capped.length} online):`,
            {
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: buttons }
            }
        );
    } catch (_) {}
    await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/edit:pick_field', args: `${active.data.alias}@${rdp}:device_id (${capped.length} choices)`, result: 'success' });
}

/**
 * Sprint 2e-3: user clicked a device in the dropdown.
 * Resolves the index → serial from wizard.data.devices_cached, then advances
 * to confirm (reuses existing handleEditConfirm path).
 */
async function handleEditDevicePick(ctx) {
    const r = ctx.state.role;
    const idxStr = ctx.match[1];
    const idx = parseInt(idxStr, 10);
    const active = await getActiveWizard(r.chat_id);
    if (!active || active.wizard_type !== 'edit' || active.step !== 'await_device_pick') {
        await ctx.answerCbQuery('⏱ Session expired. Start again with /edit.', { show_alert: true });
        try { await ctx.editMessageText('⏱ <i>Wizard expired or already handled.</i>', { parse_mode: 'HTML' }); } catch (_) {}
        return;
    }
    const cached = Array.isArray(active.data.devices_cached) ? active.data.devices_cached : [];
    const picked = cached[idx];
    if (!picked || typeof picked.id !== 'string') {
        await ctx.answerCbQuery('❌ Device not found (list changed?).', { show_alert: true });
        return;
    }
    try {
        await advanceWizard(r.chat_id, 'confirm', { value: picked.id }, 'await_device_pick');
    } catch (_) {
        await ctx.answerCbQuery('⏱ Session expired.', { show_alert: true });
        return;
    }
    const fieldDef = EDIT_FIELDS.find(f => f.key === 'device_id');
    try {
        await ctx.editMessageText(
            `⚠️ <b>Confirm edit</b>\n\n` +
            `Account: <code>${escapeHtml(active.data.alias)}</code>\n` +
            `RDP: <code>${escapeHtml(active.data.rdp_hostname)}</code>\n` +
            `Field: <b>${escapeHtml(fieldDef?.label || 'Device ID')}</b>\n` +
            `New value: <code>${escapeHtml(picked.id)}</code>\n` +
            `Device: <code>${escapeHtml((picked.label || picked.id).slice(0, 80))}</code>\n\n` +
            `<i>Will stop the bot on this alias and auto-derive Remote IP from device_id.</i>`,
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
    } catch (_) {}
    await ctx.answerCbQuery(`Picked: ${picked.id}`);
    await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/edit:device_pick', args: `${active.data.alias}@${active.data.rdp_hostname}:${picked.id}`, result: 'success' });
}

/**
 * Sprint 2e-3: "Type manually" fallback from device-pick keyboard.
 * Advances wizard to await_value so user can send free-text serial.
 */
async function handleEditDeviceManual(ctx) {
    const r = ctx.state.role;
    const active = await getActiveWizard(r.chat_id);
    if (!active || active.wizard_type !== 'edit' || active.step !== 'await_device_pick') {
        await ctx.answerCbQuery('⏱ Session expired. Start again with /edit.', { show_alert: true });
        try { await ctx.editMessageText('⏱ <i>Wizard expired or already handled.</i>', { parse_mode: 'HTML' }); } catch (_) {}
        return;
    }
    try {
        // Clear devices_cached when going manual to keep state_json small.
        await advanceWizard(r.chat_id, 'await_value', { field: 'device_id', devices_cached: null }, 'await_device_pick');
    } catch (_) {
        await ctx.answerCbQuery('⏱ Session expired.', { show_alert: true });
        return;
    }
    try {
        await ctx.editMessageText(
            `✏️ <b>Edit account</b>\n\n` +
            `Account: <code>${escapeHtml(active.data.alias)}</code>\n` +
            `RDP: <code>${escapeHtml(active.data.rdp_hostname)}</code>\n` +
            `Field: <b>Device ID</b>\n\n` +
            `Send the device serial as text (e.g. <code>100.64.0.11:5555</code> or <code>R58N21ABC2</code>).\n\n` +
            `<i>Or /cancel to abort.</i>`,
            { parse_mode: 'HTML' }
        );
    } catch (_) {}
    await ctx.answerCbQuery('Manual entry');
    await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/edit:device_manual', args: `${active.data.alias}@${active.data.rdp_hostname}`, result: 'success' });
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
    // Sprint 2e-3 (v4.3.9): per-field validation (defense in depth — mirrors /add
    // validateAddField + REST /account/edit guards). Catches bad input before
    // scaffold / round-trip call, so user sees inline error immediately.
    if (active.data.field === 'keep_balance') {
        if (!KEEP_BALANCE_REGEX.test(value)) {
            await ctx.reply('❌ Saldo minimal must be a non-negative integer (no decimals, no separators). Send again or /cancel.', { parse_mode: 'HTML' });
            return true;
        }
        const n = parseInt(value, 10);
        if (n < 0 || n > KEEP_BALANCE_MAX) {
            await ctx.reply(`❌ Saldo minimal out of range (0 to ${KEEP_BALANCE_MAX.toLocaleString('en-US')}). Send again or /cancel.`, { parse_mode: 'HTML' });
            return true;
        }
    } else if (active.data.field === 'alias') {
        if (!ALIAS_REGEX.test(value)) {
            await ctx.reply('❌ Alias must be 1-128 printable chars (no control chars). Send again or /cancel.', { parse_mode: 'HTML' });
            return true;
        }
    } else if (active.data.field === 'callback_url') {
        if (!URL_REGEX.test(value) || value.length > 2048) {
            await ctx.reply('❌ Callback URL must start with http:// or https:// (max 2048 chars). Send again or /cancel.', { parse_mode: 'HTML' });
            return true;
        }
    }

    // v4.3.13 Sprint 3 polish: auto-delete sensitive input message from chat
    // history (private chat only — bot has delete rights on user messages
    // there, not in groups). Wrap in try/catch: non-blocking if message >48h
    // old or Telegram API transient. Executes AFTER validation pass so operator
    // doesn't lose their input accidentally on validation retry.
    if (SENSITIVE_EDIT_FIELDS.has(active.data.field)) {
        try { await ctx.deleteMessage(); } catch (_) { /* non-blocking */ }
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

// ==========================================================
// /add — Sprint 2d-1 (v4.3.6 hotfix: field schema realigned with clientapp)
// Wizard flow: pick_rdp → ask_alias → ask_password → ask_callback_url → confirm → POST
// ==========================================================

async function handleAdd(ctx) {
    const r = ctx.state.role;
    if (ctx.message?.text && ctx.message.text.trim().split(/\s+/).length > 1) {
        await ctx.reply(
            'Usage: <code>/add</code> (no args — wizard asks each field in turn).\n\n<i>Fields: alias, password, callback_url.</i>',
            { parse_mode: 'HTML' }
        );
        await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/add', result: 'rejected', error_message: 'unexpected_args' });
        return;
    }

    // Scope-filtered RDP list
    let rdps;
    try {
        [rdps] = await pool.execute(
            `SELECT rdp_hostname FROM rdp_registry WHERE status = 'approved' ORDER BY rdp_hostname`
        );
    } catch (e) {
        await ctx.reply(`❌ Error listing RDPs: ${escapeHtml(e.message)}`, { parse_mode: 'HTML' });
        return;
    }
    let inScope = rdps.map(x => x.rdp_hostname);
    if (r.role === 'operator') {
        const allowed = r.operator?.allowed_rdp_hostnames;
        if (allowed) {
            let allowedList;
            try { allowedList = typeof allowed === 'string' ? JSON.parse(allowed) : allowed; } catch { allowedList = []; }
            inScope = inScope.filter(h => Array.isArray(allowedList) && allowedList.includes(h));
        }
    }
    if (inScope.length === 0) {
        await ctx.reply('❌ No approved RDPs in your scope. Contact owner.', { parse_mode: 'HTML' });
        await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/add', result: 'rejected', error_message: 'no_rdp_in_scope' });
        return;
    }
    // Telegram callback_data cap 64 bytes — hostnames should fit comfortably ('add_rdp:' + 56)
    const buttons = inScope.slice(0, 20).map(h => ([
        { text: h, callback_data: `add_rdp:${h.slice(0, 55)}` }
    ]));
    buttons.push([{ text: '❌ Cancel', callback_data: 'add_cancel' }]);

    try {
        await startWizard(r.chat_id, 'add', 'pick_rdp', {});
    } catch (e) {
        await ctx.reply(`❌ Error starting wizard: ${escapeHtml(e.message)}`, { parse_mode: 'HTML' });
        return;
    }
    await ctx.reply(
        `➕ <b>Add new account</b>\n\n` +
        `Pick target RDP (${inScope.length} in scope):`,
        {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: buttons }
        }
    );
    await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/add', result: 'success', error_message: 'wizard_started' });
}

async function handleAddRdpPick(ctx) {
    const r = ctx.state.role;
    const rdpHostname = ctx.match[1];
    const active = await getActiveWizard(r.chat_id);
    if (!active || active.wizard_type !== 'add' || active.step !== 'pick_rdp') {
        await ctx.answerCbQuery('⏱ Session expired. Start again with /add.', { show_alert: true });
        try { await ctx.editMessageText('⏱ <i>Wizard expired or already handled.</i>', { parse_mode: 'HTML' }); } catch (_) {}
        return;
    }
    // Re-verify scope at click time (operator's allowed list may have changed)
    if (r.role === 'operator') {
        const allowed = r.operator?.allowed_rdp_hostnames;
        if (allowed) {
            let allowedList;
            try { allowedList = typeof allowed === 'string' ? JSON.parse(allowed) : allowed; } catch { allowedList = []; }
            if (!Array.isArray(allowedList) || !allowedList.includes(rdpHostname)) {
                await ctx.answerCbQuery('🚫 Not in your scope.', { show_alert: true });
                return;
            }
        }
    }
    try {
        await advanceWizard(r.chat_id, 'ask_alias', { rdp_hostname: rdpHostname }, 'pick_rdp');
    } catch (_) {
        await ctx.answerCbQuery('⏱ Session expired.', { show_alert: true });
        return;
    }
    try {
        await ctx.editMessageText(
            `➕ <b>Add new account</b>\n\n` +
            `RDP: <code>${escapeHtml(rdpHostname)}</code>\n\n` +
            ADD_STEPS[0].prompt +
            `\n\n<i>Or /cancel to abort.</i>`,
            { parse_mode: 'HTML' }
        );
    } catch (_) {}
    await ctx.answerCbQuery(`RDP: ${rdpHostname}`);
    await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/add:pick_rdp', args: rdpHostname, result: 'success' });
}

/**
 * Called from wizard text router when wizard_type='add' and step starts with 'ask_'.
 * Validates + advances to next step (or confirm after last field).
 */
async function handleAddValueInput(ctx, active) {
    const r = ctx.state.role;
    const value = (ctx.message?.text || '').trim();
    const stepKey = active.step.replace(/^ask_/, ''); // 'ask_alias' → 'alias'
    const stepDef = ADD_STEPS.find(s => s.key === stepKey);
    if (!stepDef) {
        await ctx.reply(`❌ Unexpected step: ${escapeHtml(active.step)}. Use /cancel.`, { parse_mode: 'HTML' });
        return true;
    }

    const check = validateAddField(stepKey, value);
    if (!check.ok) {
        const msgs = {
            empty: 'Empty value.',
            too_long: 'Too long (max 2048).',
            too_long_1024: 'Too long (max 1024).',
            alias_bad_chars: 'Alias must be 1-128 printable chars (no control chars).',
            url_bad_scheme: 'Callback URL must start with http:// or https://.',
            device_ip_bad_format: 'Device IP must be IP:PORT (e.g. 100.64.0.11:40123). Port 1-65535, octets 0-255.',
            pair_code_bad_format: 'Pair code must be exactly 6 digits.',
            keep_balance_bad_format: 'Saldo minimal must be a non-negative integer (no decimals, no separators).',
            keep_balance_bad_range: `Saldo minimal out of range (0 to ${KEEP_BALANCE_MAX.toLocaleString('en-US')}).`
        };
        await ctx.reply(`❌ ${msgs[check.error] || check.error}\n\nSend the value again or /cancel.`, { parse_mode: 'HTML' });
        return true;
    }

    // v4.3.13 Sprint 3 polish: auto-delete sensitive input (password, pair_code)
    // from chat history for security. Executes AFTER validation pass so bad
    // input doesn't get deleted (operator retry preserves what they typed).
    // Non-blocking try/catch: Telegram allows bot to delete incoming messages
    // in private chats but can fail silently if message >48h old / API transient.
    if (SENSITIVE_ADD_FIELDS.has(stepKey)) {
        try { await ctx.deleteMessage(); } catch (_) { /* non-blocking */ }
    }

    const next = nextAddStep(stepKey);
    const mergeData = { [stepKey]: value };
    try {
        if (next) {
            await advanceWizard(r.chat_id, `ask_${next.key}`, mergeData, active.step);
        } else {
            await advanceWizard(r.chat_id, 'confirm', mergeData, active.step);
        }
    } catch (_) {
        await ctx.reply('⏱ Wizard expired. Start again with /add.', { parse_mode: 'HTML' });
        return true;
    }

    if (next) {
        await ctx.reply(next.prompt + `\n\n<i>Or /cancel to abort.</i>`, { parse_mode: 'HTML' });
        await logAudit({ chat_id: r.chat_id, role: r.role, cmd: `/add:ask_${stepKey}`, args: SENSITIVE_ADD_FIELDS.has(stepKey) ? '***' : value.slice(0, 40), result: 'success' });
        return true;
    }

    // All fields collected — show confirm page
    const merged = { ...active.data, ...mergeData };
    const keepDisplay = `Rp ${parseInt(merged.keep_balance, 10).toLocaleString('id-ID')}`;
    const lines = [
        `⚠️ <b>Confirm new account</b>`,
        ``,
        `RDP: <code>${escapeHtml(merged.rdp_hostname)}</code>`,
        `Alias: <code>${escapeHtml(merged.alias)}</code>`,
        `Password: <code>${escapeHtml(maskAddForDisplay('password', merged.password))}</code>`,
        `Callback URL: <code>${escapeHtml(maskAddForDisplay('callback_url', merged.callback_url))}</code>`,
        `Saldo Minimal: <code>${escapeHtml(keepDisplay)}</code>`,
        `Device IP: <code>${escapeHtml(merged.device_ip)}</code>`,
        `Pair code: <code>${escapeHtml(maskAddForDisplay('pair_code', merged.pair_code))}</code>`,
        ``,
        `<i>Account will be created on the target RDP + <code>adb pair</code> will run with the code above.</i>`
    ];
    await ctx.reply(lines.join('\n'), {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: [[
                { text: '✅ YES, create', callback_data: 'add_confirm:ok' },
                { text: '❌ Cancel', callback_data: 'add_confirm:no' }
            ]]
        }
    });
    await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/add:confirm_prompt', args: `${merged.alias}@${merged.rdp_hostname}`, result: 'success' });
    return true;
}

async function handleAddConfirm(ctx) {
    const r = ctx.state.role;
    const decision = ctx.match[1]; // 'ok' | 'no'
    const active = await getActiveWizard(r.chat_id);
    if (!active || active.wizard_type !== 'add' || active.step !== 'confirm') {
        await ctx.answerCbQuery('⏱ Session expired or already handled.', { show_alert: true });
        try { await ctx.editMessageText('⏱ <i>Wizard expired or already handled.</i>', { parse_mode: 'HTML' }); } catch (_) {}
        return;
    }

    if (decision === 'no') {
        await cancelWizard(r.chat_id);
        try { await ctx.editMessageText('❌ <i>Add canceled.</i>', { parse_mode: 'HTML' }); } catch (_) {}
        await ctx.answerCbQuery('Canceled.');
        await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/add:cancel', args: `${active.data.alias}@${active.data.rdp_hostname}`, result: 'success' });
        return;
    }

    // Atomic CAS lock — prevent double-click destructive call (same F1 pattern as /edit)
    try {
        await advanceWizard(r.chat_id, 'applying', {}, 'confirm');
    } catch (_) {
        await ctx.answerCbQuery('⏳ Already processing.', { show_alert: false });
        return;
    }

    const { alias, rdp_hostname, password, callback_url, keep_balance, device_ip, pair_code } = active.data;
    const keepInt = parseInt(keep_balance, 10) || 0;
    const resp = await postJson('/account/add', {
        alias, rdp_hostname, password, callback_url,
        keep_balance: keepInt,
        device_ip, pair_code,
        operator_chat_id: r.chat_id
    });

    let replyText, auditResult, auditErrMsg = null;
    if (resp.ok) {
        replyText = `✅ Account created.\n<code>${escapeHtml(alias)}@${escapeHtml(rdp_hostname)}</code>`;
        auditResult = 'success';
    } else if (resp.status === 501) {
        replyText = `⚠️ <b>Scaffold accepted</b>\n\nBackend auth+scope+validation OK.\nClientapp support coming Sprint 2e.\n\n<code>${escapeHtml(alias)}@${escapeHtml(rdp_hostname)}</code>\n\n<i>Status 501: ${escapeHtml(resp.data?.detail || 'not implemented')}</i>`;
        auditResult = 'success';
        auditErrMsg = 'sprint2d1_scaffold_queued';
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

    await logAudit({
        chat_id: r.chat_id,
        role: r.role,
        cmd: '/add:confirm',
        args: `${alias}@${rdp_hostname} dev=${device_ip} keep=${keepInt} cb=${callback_url.slice(0, 60)}`,
        result: auditResult,
        error_message: auditErrMsg
    });

    if (r.role === 'operator') {
        await forwardToOwner({
            ctx,
            operatorChatId: r.chat_id,
            operatorLabel: r.operator?.display_name || 'operator',
            cmd: '/add',
            result: `${alias}@${rdp_hostname} → ${auditResult}`,
            eventType: resp.ok || resp.status === 501 ? 'destructive' : 'error'
        });
    }
    await cancelWizard(r.chat_id);
}

async function handleAddCancelAction(ctx) {
    const r = ctx.state.role;
    const active = await getActiveWizard(r.chat_id);
    if (active && active.wizard_type === 'add') {
        await cancelWizard(r.chat_id);
    }
    try { await ctx.editMessageText('❌ <i>Add canceled.</i>', { parse_mode: 'HTML' }); } catch (_) {}
    await ctx.answerCbQuery('Canceled.');
    await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/add:cancel', args: active?.data?.rdp_hostname || null, result: 'success' });
}

// ==========================================================
// /start + /stop — Sprint 3 (v4.3.10) runtime bot control
// ==========================================================

async function handleStart(ctx) { return handleStartStop(ctx, 'start'); }
async function handleStop(ctx)  { return handleStartStop(ctx, 'stop'); }

async function handleStartStop(ctx, action) {
    const r = ctx.state.role;
    const text = ctx.message?.text || '';
    const parts = text.trim().split(/\s+/);
    if (parts.length < 2) {
        await ctx.reply(
            `Usage: <code>/${action} &lt;alias&gt; [rdp_hostname]</code>\n\n` +
            'Examples:\n' +
            `• <code>/${action} fajar-brimo-01</code> — auto-resolve RDP\n` +
            `• <code>/${action} fajar-brimo-01 RDP-TF-BRImo1</code> — explicit routing`,
            { parse_mode: 'HTML' }
        );
        await logAudit({ chat_id: r.chat_id, role: r.role, cmd: `/${action}`, result: 'rejected', error_message: 'missing_args' });
        return;
    }
    const alias = parts[1];
    let rdp_hostname = parts[2];

    if (!rdp_hostname) {
        const resolved = await resolveAliasOrPicker(ctx, action, alias);
        if (resolved.pickerShown) {
            await logAudit({ chat_id: r.chat_id, role: r.role, cmd: `/${action}`, args: alias, result: 'success', error_message: 'picker_shown' });
            return;
        }
        if (resolved.error) {
            const msg = {
                no_rdps_in_scope: 'Operator has no approved RDPs in scope.',
                alias_not_found: `Alias <code>${escapeHtml(alias)}</code> not found${resolved.scanned ? ` in any of ${resolved.scanned} RDP(s)` : ''}.`,
                lookup_failed: `Alias lookup failed: ${escapeHtml(resolved.detail || '?')}`
            }[resolved.error] || `Error: ${escapeHtml(resolved.error)}`;
            await ctx.reply(`❌ ${msg}`, { parse_mode: 'HTML' });
            await logAudit({ chat_id: r.chat_id, role: r.role, cmd: `/${action}`, args: alias, result: 'rejected', error_message: resolved.error });
            return;
        }
        rdp_hostname = resolved.rdp_hostname;
    }

    return startStopExecute(ctx, action, alias, rdp_hostname);
}

async function startStopExecute(ctx, action, alias, rdp_hostname) {
    const r = ctx.state.role;
    // Direct execute — no confirm step per D3=C1 (operator-tempo freq ops).
    // Clientapp side: up to 15s wait for bot-started/-start-failed event (start),
    // or immediate ack after engine.stop() flip (stop). Backend timeout 20s.
    const typingMsg = await ctx.reply(action === 'start' ? '🟡 Starting bot...' : '🟡 Stopping bot...', { parse_mode: 'HTML' });
    const resp = await postJson(`/bot/${action}`, { alias, rdp_hostname, operator_chat_id: r.chat_id });

    let replyText, auditResult, auditErrMsg = null;
    if (resp.ok) {
        const state = resp.data?.bot_state || (action === 'start' ? 'running' : 'stopping');
        const emoji = state === 'running' ? '✅' : (state === 'stopping' ? '🛑' : 'ℹ️');
        replyText = `${emoji} <code>${escapeHtml(alias)}@${escapeHtml(rdp_hostname)}</code> — <b>${escapeHtml(state)}</b>`;
        auditResult = 'success';
    } else if (resp.status === 403) {
        replyText = `❌ Scope denied: ${escapeHtml(resp.data?.detail || 'unknown')}`;
        auditResult = 'denied';
        auditErrMsg = resp.data?.detail || 'scope_denied';
    } else if (resp.status === 404) {
        replyText = `❌ ${escapeHtml(resp.data?.detail || 'alias not found')}`;
        auditResult = 'rejected';
        auditErrMsg = 'alias_not_found';
    } else if (resp.data?.error === 'already_running' || resp.data?.error === 'not_running') {
        replyText = `ℹ️ <code>${escapeHtml(alias)}@${escapeHtml(rdp_hostname)}</code> — ${escapeHtml(resp.data.error === 'already_running' ? 'already running' : 'not running')}`;
        auditResult = 'rejected';
        auditErrMsg = resp.data.error;
    } else {
        replyText = `❌ ${escapeHtml(resp.data?.error || 'error')}: ${escapeHtml(resp.data?.detail || `status ${resp.status}`)}`;
        auditResult = 'error';
        auditErrMsg = `http_${resp.status}`;
    }

    try {
        await ctx.telegram.editMessageText(typingMsg.chat.id, typingMsg.message_id, undefined, replyText, { parse_mode: 'HTML' });
    } catch (_) {
        await ctx.reply(replyText, { parse_mode: 'HTML' });
    }

    await logAudit({
        chat_id: r.chat_id, role: r.role, cmd: `/${action}`,
        args: `${alias}@${rdp_hostname}`,
        result: auditResult, error_message: auditErrMsg
    });

    if (r.role === 'operator') {
        await forwardToOwner({
            ctx,
            operatorChatId: r.chat_id,
            operatorLabel: r.operator?.display_name || 'operator',
            cmd: `/${action}`,
            result: `${alias}@${rdp_hostname} → ${auditResult}`,
            eventType: resp.ok ? 'destructive' : 'error'
        });
    }
}

// ==========================================================
// Alias-picker callback — Sprint 3 (v4.3.10)
// Shared across /start /stop /edit /delete when alias resolves to multi-RDP.
// callback_data format: pick_rdp:<cbid>:<idx>|cancel
// ==========================================================

async function handlePickRdp(ctx) {
    const r = ctx.state.role;
    const cbid = ctx.match[1];
    const idxOrCancel = ctx.match[2];
    const pending = pendingPickers.get(cbid);

    if (!pending) {
        await ctx.answerCbQuery('⏱ Expired or already handled.', { show_alert: true });
        try { await ctx.editMessageText('⏱ <i>Picker expired.</i>', { parse_mode: 'HTML' }); } catch (_) {}
        return;
    }
    // Only original requester can pick
    if (String(ctx.from?.id) !== String(pending.operator_chat_id)) {
        await ctx.answerCbQuery('🚫 Not your picker.', { show_alert: true });
        return;
    }

    if (idxOrCancel === 'cancel') {
        pendingPickers.delete(cbid);
        try { await ctx.editMessageText('❌ <i>Canceled.</i>', { parse_mode: 'HTML' }); } catch (_) {}
        await ctx.answerCbQuery('Canceled.');
        await logAudit({ chat_id: r.chat_id, role: r.role, cmd: `/${pending.action}:pick_cancel`, args: pending.alias, result: 'success' });
        return;
    }

    const idx = parseInt(idxOrCancel, 10);
    const candidate = pending.candidates?.[idx];
    if (!candidate) {
        // Mini-scan G3 fix: drop pending entry on invalid idx to prevent zombie
        // state (unreachable under current regex but defense-in-depth).
        pendingPickers.delete(cbid);
        await ctx.answerCbQuery('❌ Invalid choice.', { show_alert: true });
        return;
    }
    pendingPickers.delete(cbid);
    const rdp_hostname = candidate.rdp_hostname;
    try {
        await ctx.editMessageText(
            `✅ Selected <code>${escapeHtml(rdp_hostname)}</code> — proceeding with <b>/${escapeHtml(pending.action)}</b>...`,
            { parse_mode: 'HTML' }
        );
    } catch (_) {}
    await ctx.answerCbQuery(`${rdp_hostname}`);
    await logAudit({ chat_id: r.chat_id, role: r.role, cmd: `/${pending.action}:pick_rdp`, args: `${pending.alias}@${rdp_hostname}`, result: 'success' });

    // Resume original action with resolved rdp_hostname
    switch (pending.action) {
        case 'start':
        case 'stop':
            return startStopExecute(ctx, pending.action, pending.alias, rdp_hostname);
        case 'edit':
            return editShowFieldPicker(ctx, pending.alias, rdp_hostname);
        case 'delete':
            return deleteShowConfirm(ctx, pending.alias, rdp_hostname);
        default:
            await ctx.reply(`❌ Unknown pending action: ${escapeHtml(pending.action)}`);
    }
}

// ==========================================================
// /list_accounts — Sprint 3 polish (v4.3.14)
// Fan-out ke semua RDP di operator scope, aggregate per RDP, kirim HTML
// dengan chunked message split kalau total render > ~3500 chars (Telegram
// per-message cap 4096, buffer 500 untuk safety + header/footer append).
// ==========================================================

const LIST_MSG_CAP = 3500;
const LIST_MAX_MESSAGES = 10;

function formatRupiah(n) {
    const v = parseInt(n, 10);
    if (!Number.isInteger(v)) return 'Rp 0';
    return 'Rp ' + v.toLocaleString('id-ID');
}

function renderAccountLine(acc) {
    const stateEmoji = acc.bot_state === 'running' ? '✅' : '⏸️';
    const device = acc.device_id || '-';
    const keep = formatRupiah(acc.keep_balance);
    const flags = [];
    if (acc.mutasi_enabled) flags.push('🔄 Mutasi');
    if (acc.mirror_enabled) flags.push('📺 Mirror');
    const flagsStr = flags.length ? flags.join(' • ') : '—';
    const remoteIpLine = acc.remote_ip ? `\n     Remote IP: <code>${escapeHtml(acc.remote_ip)}</code>` : '';
    return [
        `  ${stateEmoji} <b>${escapeHtml(acc.alias)}</b>`,
        `     Device: <code>${escapeHtml(device)}</code>${remoteIpLine}`,
        `     Saldo min: ${escapeHtml(keep)} • ${flagsStr}`,
    ].join('\n');
}

function renderRdpHeader(group) {
    if (group.status === 'ok') {
        return `🖥️ <b>${escapeHtml(group.rdp_hostname)}</b> • ${group.accounts.length} account(s)`;
    }
    if (group.status === 'offline') {
        return `🖥️ <b>${escapeHtml(group.rdp_hostname)}</b> • ⚠️ Unreachable (${escapeHtml(group.detail || 'offline')})`;
    }
    return `🖥️ <b>${escapeHtml(group.rdp_hostname)}</b> • ❌ Error (${escapeHtml(group.detail || 'unknown')})`;
}

async function handleListAccounts(ctx) {
    const r = ctx.state.role;
    const typingMsg = await ctx.reply('🔍 Scanning RDPs...', { parse_mode: 'HTML' });

    const resp = await getJson(`/accounts/list?operator_chat_id=${encodeURIComponent(r.chat_id)}`);
    if (!resp.ok) {
        const replyText = `❌ List failed: ${escapeHtml(resp.data?.detail || `status ${resp.status}`)}`;
        try { await ctx.telegram.editMessageText(typingMsg.chat.id, typingMsg.message_id, undefined, replyText, { parse_mode: 'HTML' }); }
        catch (_) { await ctx.reply(replyText, { parse_mode: 'HTML' }); }
        await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/list_accounts', result: 'error', error_message: resp.data?.error || `http_${resp.status}` });
        return;
    }

    const { groups, totals } = resp.data;
    if (!Array.isArray(groups) || groups.length === 0) {
        const replyText = `📋 No RDPs in your scope. Contact owner.`;
        try { await ctx.telegram.editMessageText(typingMsg.chat.id, typingMsg.message_id, undefined, replyText, { parse_mode: 'HTML' }); }
        catch (_) { await ctx.reply(replyText, { parse_mode: 'HTML' }); }
        await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/list_accounts', result: 'rejected', error_message: 'no_rdps_in_scope' });
        return;
    }

    // Build messages — per-account line iteration (mini-scan G1 fix: single
    // large RDP group was treated as atomic blob → could exceed 4096 Telegram
    // cap). Now flush per-line when buf would overflow; continuation header
    // ("(cont.)") inserted so operator sees RDP context preserved across split.
    const header = `📋 <b>Accounts Overview</b>`;
    const footer = `📊 ${totals.scanned} RDP scanned, ${totals.responded} responded. ${totals.accounts} account(s): ${totals.running} running, ${totals.stopped} stopped.`;
    const messages = [];
    let buf = header;
    let truncated = false;
    outer:
    for (const group of groups) {
        const groupHeader = renderRdpHeader(group);
        // Flush before header if buf + header overflows
        const headerAppend = (buf ? '\n\n' : '') + groupHeader;
        if ((buf + headerAppend).length > LIST_MSG_CAP) {
            messages.push(buf);
            if (messages.length >= LIST_MAX_MESSAGES - 1) { truncated = true; break; }
            buf = groupHeader;
        } else {
            buf += headerAppend;
        }
        // Iterate per-account line
        for (const acc of group.accounts) {
            const lineAppend = '\n' + renderAccountLine(acc);
            if ((buf + lineAppend).length > LIST_MSG_CAP) {
                messages.push(buf);
                if (messages.length >= LIST_MAX_MESSAGES - 1) { truncated = true; break outer; }
                buf = `${groupHeader} <i>(cont.)</i>` + lineAppend;
            } else {
                buf += lineAppend;
            }
        }
    }
    if (truncated) buf += '\n\n<i>... (truncated — too many RDPs/accounts)</i>';
    // Append footer to last buffer kalau muat, else push as separate message
    if ((buf + '\n\n' + footer).length <= LIST_MSG_CAP) {
        buf += '\n\n' + footer;
        messages.push(buf);
    } else {
        messages.push(buf);
        messages.push(footer);
    }

    // Send first message as edit of typingMsg (replaces "Scanning..."), rest as new replies
    try { await ctx.telegram.editMessageText(typingMsg.chat.id, typingMsg.message_id, undefined, messages[0], { parse_mode: 'HTML' }); }
    catch (_) { await ctx.reply(messages[0], { parse_mode: 'HTML' }); }
    for (let i = 1; i < messages.length; i++) {
        try { await ctx.reply(messages[i], { parse_mode: 'HTML' }); }
        catch (e) { console.error('[/list_accounts] send msg', i, 'failed:', e.message); }
    }

    await logAudit({
        chat_id: r.chat_id, role: r.role, cmd: '/list_accounts',
        args: `scanned=${totals.scanned} responded=${totals.responded} accounts=${totals.accounts}`,
        result: 'success'
    });

    if (r.role === 'operator') {
        await forwardToOwner({
            ctx,
            operatorChatId: r.chat_id,
            operatorLabel: r.operator?.display_name || 'operator',
            cmd: '/list_accounts',
            result: `${totals.accounts} accounts across ${totals.responded}/${totals.scanned} RDPs`
        });
    }
}

module.exports = {
    handleList, handleStatus,
    handleDelete, handleDeleteConfirm, handleDeleteCancel,
    handleEdit, handleEditFieldPick, handleEditValueInput, handleEditConfirm, handleEditCancelAction,
    handleEditDevicePick, handleEditDeviceManual,
    handleAdd, handleAddRdpPick, handleAddValueInput, handleAddConfirm, handleAddCancelAction,
    handleStart, handleStop, handlePickRdp,
    handleListAccounts
};
