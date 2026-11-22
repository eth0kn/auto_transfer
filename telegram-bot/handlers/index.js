// Telegram Bot — Handler Registry
// Maps commands to handlers with role enforcement

const { requireRole } = require('../middleware');
const pub = require('./public');
const op = require('./operator');
const own = require('./owner');

/**
 * Register all handlers on a telegraf bot instance.
 */
function registerHandlers(bot) {
    // PUBLIC — no role requirement (middleware still resolves role for ctx.state)
    bot.start(pub.handleStart);
    bot.command('whoami', pub.handleWhoami);
    bot.command('help', pub.handleHelp);

    // OPERATOR_ALLOWED (operator + owner)
    bot.command('list', requireRole(['owner', 'operator']), op.handleList);
    bot.command('status', requireRole(['owner', 'operator']), op.handleStatus);

    // OWNER_ONLY — RDP mgmt
    bot.command('list_rdp', requireRole(['owner']), own.handleListRdp);
    bot.command('approve_rdp', requireRole(['owner']), own.handleApproveRdp);
    bot.command('revoke_rdp', requireRole(['owner']), own.handleRevokeRdp);

    // OWNER_ONLY — operator mgmt
    bot.command('list_operators', requireRole(['owner']), own.handleListOperators);
    bot.command('create_operator', requireRole(['owner']), own.handleCreateOperator);
    bot.command('revoke_operator', requireRole(['owner']), own.handleRevokeOperator);
    bot.command('delete_operator', requireRole(['owner']), own.handleDeleteOperator);

    // OWNER_ONLY — observability
    bot.command('shadow', requireRole(['owner']), own.handleShadow);
    bot.command('audit', requireRole(['owner']), own.handleAudit);

    // Catch-all for unknown commands (text that starts with /)
    bot.on('text', async (ctx) => {
        const text = ctx.message?.text || '';
        if (text.startsWith('/')) {
            const r = ctx.state.role;
            if (r.role === 'rejected') return; // middleware already replied
            await ctx.reply(`❓ Unknown command: \`${text.split(' ')[0]}\`\n\nUse \`/help\` to see available commands.`, { parse_mode: 'Markdown' });
        }
        // non-command text (plain message) — ignore for now, Sprint 2 wizard will handle
    });
}

module.exports = { registerHandlers };
