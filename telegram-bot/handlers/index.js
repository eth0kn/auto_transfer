// Telegram Bot — Handler Registry
// Maps commands to handlers with role enforcement

const { requireRole } = require('../middleware');
const { escapeHtml } = require('../util');
const pub = require('./public');
const op = require('./operator');
const own = require('./owner');
const wiz = require('./wizard');

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
    bot.command('cancel', requireRole(['owner', 'operator']), wiz.handleCancel);

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

    // Catch-all for non-command text + unknown commands
    // Non-command text → route to active wizard step (if any)
    // Unknown /command → helpful hint
    bot.on('text', async (ctx) => {
        const text = ctx.message?.text || '';
        const r = ctx.state.role;
        if (!r || r.role === 'rejected') return; // middleware already handled

        if (text.startsWith('/')) {
            await ctx.reply(`❓ Unknown command: <code>${escapeHtml(text.split(' ')[0])}</code>\n\nUse <code>/help</code> to see available commands.`, { parse_mode: 'HTML' });
            return;
        }

        // Non-command text — route through wizard router first
        const handled = await wiz.routeWizardText(ctx);
        if (handled) return;

        // No wizard active + non-command — silent ignore (Sprint 1 behavior preserved)
    });
}

module.exports = { registerHandlers };
