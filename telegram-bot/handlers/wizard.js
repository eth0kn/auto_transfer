// Telegram Bot — Wizard Handlers
// Sprint 2a (2026-11-22): /cancel + text router scaffold
// Sprint 2c+: /delete, /edit, /add handlers will register step callbacks here

const { getActiveWizard, cancelWizard } = require('../wizard');
const { logAudit } = require('../audit');
const { escapeHtml } = require('../util');

async function handleCancel(ctx) {
    const r = ctx.state.role;
    try {
        const active = await getActiveWizard(r.chat_id);
        if (!active) {
            await ctx.reply('ℹ️ No active wizard to cancel.');
            await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/cancel', result: 'success', error_message: 'no_active' });
            return;
        }
        await cancelWizard(r.chat_id);
        await ctx.reply(`✅ Wizard <code>${escapeHtml(active.wizard_type)}</code> canceled.`, { parse_mode: 'HTML' });
        await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/cancel', args: active.wizard_type, result: 'success' });
    } catch (e) {
        console.error('[handler /cancel]', e.message);
        await ctx.reply(`❌ Error: ${e.message}`);
        await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/cancel', result: 'error', error_message: e.message });
    }
}

/**
 * Sprint 2a: router stub. Sprint 2c: dispatch to /edit await_value step.
 * Returns true if the message was handled by a wizard step, false otherwise.
 */
async function routeWizardText(ctx) {
    const r = ctx.state.role;
    if (!r?.chat_id) return false;
    // F3 mini-scan Sprint 2a fix: gate on role — only owner/operator can own wizard.
    // Prevents leaking wizard_type/step info to revoked/unknown users whose wizard row
    // may still exist in DB before cascade cleanup.
    if (r.role !== 'owner' && r.role !== 'operator') return false;
    const active = await getActiveWizard(r.chat_id);
    if (!active) return false;

    // Sprint 2c: /edit wizard await_value step
    if (active.wizard_type === 'edit' && active.step === 'await_value') {
        const { handleEditValueInput } = require('./operator');
        return await handleEditValueInput(ctx, active);
    }

    // Sprint 2d-1: /add wizard ask_<field> steps
    if (active.wizard_type === 'add' && typeof active.step === 'string' && active.step.startsWith('ask_')) {
        const { handleAddValueInput } = require('./operator');
        return await handleAddValueInput(ctx, active);
    }

    // Unknown wizard/step — stub reply for future sprints
    await ctx.reply(
        `⏳ Wizard <code>${escapeHtml(active.wizard_type)}</code> step <code>${escapeHtml(active.step)}</code> — handler not implemented yet.\n\nUse <code>/cancel</code> to exit.`,
        { parse_mode: 'HTML' }
    );
    return true;
}

module.exports = { handleCancel, routeWizardText };
