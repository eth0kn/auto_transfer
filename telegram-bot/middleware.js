// Telegram Bot — Middleware (3-tier defense + role resolver)
// Compliance: B2.6 Role Matrix locked 2026-11-22
// - Tier 1: private chat only
// - Tier 2: no forward chain
// - Tier 3: role resolution (owner > operator > unknown)

const { pool } = require('./db');
const { logAudit } = require('./audit');

/**
 * Resolve role for incoming message.
 * Returns: { role, chat_id, operator?, reject_reason? }
 */
async function resolveRole(ctx) {
    const msg = ctx.message || ctx.update?.message || ctx.update?.edited_message;
    if (!msg) {
        return { role: 'rejected', reject_reason: 'no_message' };
    }

    // Tier 1 — Private chat only
    if (msg.chat?.type !== 'private') {
        return { role: 'rejected', reject_reason: 'group_chat_not_allowed', chat_id: String(msg.chat?.id || '') };
    }

    // Tier 2 — No forwarded commands
    if (msg.forward_from || msg.forward_sender_name || msg.forward_from_chat) {
        return { role: 'rejected', reject_reason: 'forwarded_not_allowed', chat_id: String(msg.from?.id || '') };
    }

    const chatId = String(msg.from?.id || '');
    if (!chatId) {
        return { role: 'rejected', reject_reason: 'no_from_id' };
    }

    // Tier 3 — Owner hardcode check
    const ownerChatId = process.env.OWNER_CHAT_ID;
    if (!ownerChatId) {
        console.error('[middleware] OWNER_CHAT_ID not set in .env — bot refuses to operate');
        return { role: 'rejected', reject_reason: 'bot_misconfig', chat_id: chatId };
    }
    if (chatId === ownerChatId) {
        return { role: 'owner', chat_id: chatId };
    }

    // Operator DB lookup
    try {
        const [rows] = await pool.execute(
            'SELECT * FROM operators WHERE chat_id = ? AND status = ? LIMIT 1',
            [chatId, 'approved']
        );
        if (rows.length > 0) {
            // Update last_active_at (fire-and-forget)
            pool.execute(
                'UPDATE operators SET last_active_at = NOW() WHERE chat_id = ?',
                [chatId]
            ).catch(e => console.error('[middleware] update last_active failed:', e.message));
            return { role: 'operator', chat_id: chatId, operator: rows[0] };
        }
    } catch (e) {
        console.error('[middleware] operator lookup failed:', e.message);
        return { role: 'rejected', reject_reason: 'db_error', chat_id: chatId };
    }

    return { role: 'unknown', chat_id: chatId, username: msg.from?.username, display_name: msg.from?.first_name };
}

/**
 * Telegraf middleware — attach role to ctx.state.role.
 * Handlers downstream use ctx.state.role.role for permission check.
 */
async function roleMiddleware(ctx, next) {
    const resolution = await resolveRole(ctx);
    ctx.state.role = resolution;

    // Handle rejection (Tier 1 + 2)
    if (resolution.role === 'rejected') {
        const reason = resolution.reject_reason;
        if (reason === 'group_chat_not_allowed') {
            try { await ctx.reply('❌ Bot ini hanya menerima private chat. Buka DM dengan bot.'); } catch (_) {}
        } else if (reason === 'forwarded_not_allowed') {
            try { await ctx.reply('❌ Forward command tidak diizinkan. Ketik sendiri.'); } catch (_) {}
        } else if (reason === 'bot_misconfig') {
            try { await ctx.reply('❌ Bot misconfigured. Contact admin.'); } catch (_) {}
        }
        await logAudit({
            chat_id: resolution.chat_id || 'unknown',
            role: 'unknown',
            cmd: ctx.message?.text?.split(' ')[0] || null,
            args: ctx.message?.text || null,
            result: 'rejected',
            error_message: reason
        });
        return; // stop chain
    }

    return next();
}

/**
 * Require specific role(s). Usage:
 *   bot.command('approve', requireRole(['owner']), handler)
 *   bot.command('add', requireRole(['owner', 'operator']), handler)
 */
function requireRole(allowedRoles) {
    return async (ctx, next) => {
        const r = ctx.state.role;
        if (!allowedRoles.includes(r.role)) {
            const cmd = ctx.message?.text?.split(' ')[0] || 'unknown';
            await ctx.reply(`❌ Insufficient permission.\nYou are: *${r.role}*\nRequired: *${allowedRoles.join(' or ')}*`, { parse_mode: 'Markdown' });
            await logAudit({
                chat_id: r.chat_id,
                role: r.role,
                cmd,
                args: ctx.message?.text,
                result: 'denied',
                error_message: `requires ${allowedRoles.join('|')}`
            });

            // Notify owner about denied attempt (unless requester IS owner, or unknown handled elsewhere)
            if (r.role === 'operator') {
                try {
                    const { notifyOwnerDenied } = require('./shadow');
                    await notifyOwnerDenied(ctx, cmd);
                } catch (e) {
                    console.error('[middleware] notifyOwnerDenied failed:', e.message);
                }
            }
            return;
        }
        return next();
    };
}

module.exports = { resolveRole, roleMiddleware, requireRole };
