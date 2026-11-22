// Telegram Bot — Public Handlers
// Scope: PUBLIC (semua role termasuk unknown)

const { logAudit } = require('../audit');
const { notifyOwnerUnknown } = require('../shadow');

async function handleStart(ctx) {
    const r = ctx.state.role;
    const roleLabel = {
        owner: '👑 Owner',
        operator: '👤 Operator (approved)',
        unknown: '❓ Unknown — contact admin for access'
    }[r.role] || '❓';

    const text = [
        `🤖 *Auto-Transfer Bot*`,
        ``,
        `Welcome. You are: ${roleLabel}`,
        ``,
        `Commands:`,
        `• \`/whoami\` — show your role`,
        `• \`/help\` — list commands available for your role`
    ].join('\n');

    await ctx.reply(text, { parse_mode: 'Markdown' });
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
        text = `👑 *Owner*\nchat_id: \`${chat_id}\`\nAll commands available.`;
    } else if (r.role === 'operator') {
        const op = r.operator;
        const scope = op.allowed_rdp_hostnames
            ? JSON.parse(op.allowed_rdp_hostnames).join(', ')
            : 'all approved RDPs';
        text = [
            `👤 *Operator (approved)*`,
            `chat_id: \`${chat_id}\``,
            `display_name: ${op.display_name || '-'}`,
            `scope: ${scope}`,
            `approved_at: ${op.approved_at || '-'}`
        ].join('\n');
    } else {
        text = [
            `❓ *Unknown*`,
            `chat_id: \`${chat_id}\``,
            ``,
            `You are not registered. Contact owner to add you as operator.`
        ].join('\n');
    }

    await ctx.reply(text, { parse_mode: 'Markdown' });
    await logAudit({ chat_id: r.chat_id || 'unknown', role: r.role, cmd: '/whoami', result: 'success' });
}

async function handleHelp(ctx) {
    const r = ctx.state.role;
    let text;

    if (r.role === 'owner') {
        text = [
            `👑 *Owner Commands*`,
            ``,
            `*Public*`,
            `• \`/start\`, \`/whoami\`, \`/help\``,
            ``,
            `*RDP Management*`,
            `• \`/list_rdp\` — list all registered RDPs`,
            `• \`/approve_rdp <hostname>\` — approve pending RDP`,
            `• \`/revoke_rdp <hostname>\` — revoke RDP`,
            ``,
            `*Operator Management*`,
            `• \`/list_operators\` — list all operators`,
            `• \`/create_operator <chat_id> <display_name>\` — add operator (auto-approved)`,
            `• \`/revoke_operator <chat_id>\` — revoke operator`,
            `• \`/delete_operator <chat_id>\` — hard delete`,
            ``,
            `*Observability*`,
            `• \`/shadow on|off|filter <level>\` — control shadow forward`,
            `• \`/audit [chat_id] [limit]\` — view audit log`,
            ``,
            `_Sprint 2+ (coming): /add /edit /delete /start-bot /stop-bot_`
        ].join('\n');
    } else if (r.role === 'operator') {
        text = [
            `👤 *Operator Commands*`,
            ``,
            `• \`/whoami\` — your role info`,
            `• \`/list\` — list your accessible accounts (coming Sprint 2)`,
            `• \`/status\` — RDP + bot health (coming Sprint 2)`,
            ``,
            `_Sprint 2+ (coming): /add /edit /delete /start-bot /stop-bot_`,
            `_Contact owner if you need more access._`
        ].join('\n');
    } else {
        text = [
            `❓ *Unknown User*`,
            ``,
            `You are not registered as owner or operator.`,
            `Available: \`/start\`, \`/whoami\`, \`/help\``,
            ``,
            `Contact owner with your chat_id to request access.`
        ].join('\n');
    }

    await ctx.reply(text, { parse_mode: 'Markdown' });
    await logAudit({ chat_id: r.chat_id || 'unknown', role: r.role, cmd: '/help', result: 'success' });
}

module.exports = { handleStart, handleWhoami, handleHelp };
