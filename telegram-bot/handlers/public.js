// Telegram Bot — Public Handlers
// Scope: PUBLIC (semua role termasuk unknown)

const { logAudit } = require('../audit');
const { notifyOwnerUnknown } = require('../shadow');
const { escapeHtml } = require('../util');

async function handleStart(ctx) {
    const r = ctx.state.role;
    const roleLabel = {
        owner: '👑 Owner',
        operator: '👤 Operator (approved)',
        unknown: '❓ Unknown — contact admin for access'
    }[r.role] || '❓';

    const text = [
        `🤖 <b>Auto-Transfer Bot</b>`,
        ``,
        `Welcome. You are: ${roleLabel}`,
        ``,
        `Commands:`,
        `• <code>/whoami</code> — show your role`,
        `• <code>/help</code> — list commands available for your role`
    ].join('\n');

    await ctx.reply(text, { parse_mode: 'HTML' });
    await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/start', result: 'success' });

    // Unknown user attempting /start → notify owner (so they can decide to approve)
    if (r.role === 'unknown') {
        await notifyOwnerUnknown(ctx, '/start');
    }
}

async function handleWhoami(ctx) {
    const r = ctx.state.role;
    const chat_id = r.chat_id || 'n/a';
    let text;

    if (r.role === 'owner') {
        text = `👑 <b>Owner</b>\nID: <code>${escapeHtml(chat_id)}</code>\nAll commands available.`;
    } else if (r.role === 'operator') {
        const op = r.operator;
        const scope = op.allowed_rdp_hostnames
            ? JSON.parse(op.allowed_rdp_hostnames).join(', ')
            : 'all approved RDPs';
        text = [
            `👤 <b>Operator (approved)</b>`,
            `ID: <code>${escapeHtml(chat_id)}</code>`,
            `Name: ${escapeHtml(op.display_name || '-')}`,
            `Scope: ${escapeHtml(scope)}`,
            `Approved at: ${escapeHtml(op.approved_at || '-')}`
        ].join('\n');
    } else {
        text = [
            `❓ <b>Unknown</b>`,
            `ID: <code>${escapeHtml(chat_id)}</code>`,
            ``,
            `You are not registered. Contact owner to add you as operator.`
        ].join('\n');
    }

    await ctx.reply(text, { parse_mode: 'HTML' });
    await logAudit({ chat_id: r.chat_id || 'unknown', role: r.role, cmd: '/whoami', result: 'success' });
}

async function handleHelp(ctx) {
    const r = ctx.state.role;
    let text;

    if (r.role === 'owner') {
        text = [
            `👑 <b>Owner Commands</b>`,
            ``,
            `<b>Public</b>`,
            `• <code>/start</code>, <code>/whoami</code>, <code>/help</code>`,
            ``,
            `<b>RDP Management</b>`,
            `• <code>/list_rdp</code> — list all registered RDPs`,
            `• <code>/approve_rdp &lt;hostname&gt;</code> — approve pending RDP`,
            `• <code>/revoke_rdp &lt;hostname&gt;</code> — revoke RDP`,
            ``,
            `<b>Operator Management</b>`,
            `• <code>/list_operators</code> — list all operators`,
            `• <code>/create_operator &lt;chat_id&gt; &lt;display_name&gt;</code> — add operator (auto-approved)`,
            `• <code>/revoke_operator &lt;chat_id&gt;</code> — revoke operator`,
            `• <code>/delete_operator &lt;chat_id&gt;</code> — hard delete`,
            ``,
            `<b>Observability</b>`,
            `• <code>/shadow on|off|filter &lt;level&gt;</code> — control shadow forward`,
            `• <code>/audit [chat_id] [limit]</code> — view audit log`,
            ``,
            `<b>Account CRUD</b> <i>(rdp_hostname optional — fan-out resolver auto-finds; multi-hit shows picker)</i>`,
            `• <code>/add</code> — create account via wizard (RDP → alias → password → callback → Saldo Minimal → device IP → pair code)`,
            `• <code>/edit &lt;alias&gt; [rdp_hostname]</code> — edit field via wizard (alias/password/callback_url/device_id/keep_balance)`,
            `• <code>/delete &lt;alias&gt; [rdp_hostname]</code> — delete account (inline Y/N confirm)`,
            `• <code>/cancel</code> — abort active wizard`,
            ``,
            `<b>Runtime Control</b> (Sprint 3)`,
            `• <code>/start_bot &lt;alias&gt; [rdp_hostname]</code> — start bot engine for account`,
            `• <code>/stop_bot &lt;alias&gt; [rdp_hostname]</code> — stop bot engine`,
            ``,
            `<i>Policy: alias unik lintas RDP adalah konvensi operator (naming), bukan code-enforced. Kalau alias ambiguous → bot kasih picker inline.</i>`
        ].join('\n');
    } else if (r.role === 'operator') {
        text = [
            `👤 <b>Operator Commands</b>`,
            ``,
            `• <code>/whoami</code> — your role info`,
            `• <code>/list</code> — list your accessible RDPs`,
            `• <code>/status</code> — RDP + bot health summary`,
            ``,
            `<b>Account CRUD</b> <i>(rdp_hostname optional — fan-out resolver auto-finds)</i>`,
            `• <code>/add</code> — create account via wizard`,
            `• <code>/edit &lt;alias&gt; [rdp_hostname]</code> — edit field via wizard`,
            `• <code>/delete &lt;alias&gt; [rdp_hostname]</code> — delete account (inline confirm)`,
            `• <code>/cancel</code> — abort active wizard`,
            ``,
            `<b>Runtime Control</b>`,
            `• <code>/start_bot &lt;alias&gt; [rdp_hostname]</code> — start bot engine`,
            `• <code>/stop_bot &lt;alias&gt; [rdp_hostname]</code> — stop bot engine`,
            ``,
            `<i>Contact owner if you need more access.</i>`
        ].join('\n');
    } else {
        text = [
            `❓ <b>Unknown User</b>`,
            ``,
            `You are not registered as owner or operator.`,
            `Available: <code>/start</code>, <code>/whoami</code>, <code>/help</code>`,
            ``,
            `Contact owner with your chat_id to request access.`
        ].join('\n');
    }

    await ctx.reply(text, { parse_mode: 'HTML' });
    await logAudit({ chat_id: r.chat_id || 'unknown', role: r.role, cmd: '/help', result: 'success' });
}

module.exports = { handleStart, handleWhoami, handleHelp };
