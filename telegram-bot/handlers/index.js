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
    bot.command('delete', requireRole(['owner', 'operator']), op.handleDelete);
    bot.command('edit',   requireRole(['owner', 'operator']), op.handleEdit);
    bot.command('add',    requireRole(['owner', 'operator']), op.handleAdd);
    // Runtime bot control + alias-only args
    bot.command('start_bot', requireRole(['owner', 'operator']), op.handleStart);
    bot.command('stop_bot',  requireRole(['owner', 'operator']), op.handleStop);
    // Aggregated accounts view across operator scope
    bot.command('list_accounts', requireRole(['owner', 'operator']), op.handleListAccounts);

    // Inline-button callbacks for /delete confirm flow
    // Pattern: del_ok:<cbid> and del_no:<cbid>, cbid = 12 hex chars
    bot.action(/^del_ok:([0-9a-f]{12})$/, requireRole(['owner', 'operator']), op.handleDeleteConfirm);
    bot.action(/^del_no:([0-9a-f]{12})$/, requireRole(['owner', 'operator']), op.handleDeleteCancel);

    // /edit wizard inline-button callbacks. Field whitelist aligned with clientapp schema:
    // 6 fields (alias, password, callback_url, device_id, keep_balance, mutasi_enabled).
    // device_id picker uses edit_dev:<idx> from a per-wizard cached device list (max 20)
    // — index-based so callback_data stays tiny regardless of serial length.
    bot.action(/^edit_field:(alias|password|callback_url|device_id|keep_balance|mutasi_enabled)$/, requireRole(['owner', 'operator']), op.handleEditFieldPick);
    bot.action(/^edit_dev:(\d{1,2})$/, requireRole(['owner', 'operator']), op.handleEditDevicePick);
    bot.action(/^edit_dev_manual$/, requireRole(['owner', 'operator']), op.handleEditDeviceManual);
    // mutasi_enabled picker — ON/OFF static buttons
    bot.action(/^edit_mutasi:(on|off)$/, requireRole(['owner', 'operator']), op.handleEditMutasiPick);
    bot.action(/^edit_confirm:(ok|no)$/, requireRole(['owner', 'operator']), op.handleEditConfirm);
    bot.action(/^edit_cancel$/, requireRole(['owner', 'operator']), op.handleEditCancelAction);

    // /add wizard inline-button callbacks.
    // add_rdp:<hostname> — accept any non-control char (spaces + case + special — Windows hostname
    // naming is loose at clientapp registration; backend re-validates scope at click time).
    bot.action(/^add_rdp:([^\x00-\x1F\x7F]{1,55})$/, requireRole(['owner', 'operator']), op.handleAddRdpPick);
    bot.action(/^add_confirm:(ok|no)$/, requireRole(['owner', 'operator']), op.handleAddConfirm);
    bot.action(/^add_cancel$/, requireRole(['owner', 'operator']), op.handleAddCancelAction);

    // alias→RDP picker for /start /stop /edit /delete without rdp_hostname.
    // callback_data: pick_rdp:<cbid=12hex>:<idx=0-9|cancel>
    bot.action(/^pick_rdp:([0-9a-f]{12}):(\d|cancel)$/, requireRole(['owner', 'operator']), op.handlePickRdp);

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

        // No wizard active + non-command — silent ignore
    });
}

module.exports = { registerHandlers };
