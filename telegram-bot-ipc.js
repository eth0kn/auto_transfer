// Telegram Bot — Backend IPC Routes
// Sprint 2b (2026-11-22): REST endpoints for bot ↔ backend.
// Decision Q5=C locked: REST via loopback + Bearer auth.
//
// Mounted at /api/tg from index.js.
// Auth: Bearer TG_BOT_API_KEY (shared .env) + 127.0.0.1-only enforcement.

const express = require('express');
const router = express.Router();

// Shared pool reference set by setDb()
let pool = null;
function setDb(p) { pool = p; }

// ==========================================================
// Middleware — loopback + Bearer auth
// ==========================================================
function tgAuth(req, res, next) {
    // 1. Loopback-only enforcement (even if someone exposes :3010 to WAN by mistake)
    const remoteIp = req.ip || req.socket?.remoteAddress || '';
    const isLoopback =
        remoteIp === '127.0.0.1' ||
        remoteIp === '::1' ||
        remoteIp === '::ffff:127.0.0.1';
    if (!isLoopback) {
        console.warn(`[TG-IPC] rejected non-loopback: ${remoteIp}`);
        return res.status(403).json({ error: 'forbidden', detail: 'loopback only' });
    }

    // 2. Bearer token check
    const expected = process.env.TG_BOT_API_KEY;
    if (!expected) {
        console.error('[TG-IPC] TG_BOT_API_KEY not set in .env');
        return res.status(500).json({ error: 'server_misconfigured' });
    }
    const got = req.get('Authorization') || '';
    if (got !== `Bearer ${expected}`) {
        return res.status(401).json({ error: 'unauthorized' });
    }
    next();
}

router.use(express.json({ limit: '32kb' }));
router.use(tgAuth);

// ==========================================================
// Helpers
// ==========================================================

/**
 * Validate operator has scope on the target rdp_hostname.
 * Owner always passes. Operator must have hostname in allowed_rdp_hostnames,
 * OR allowed_rdp_hostnames NULL (= all approved RDPs).
 */
async function validateOperatorScope(chatId, rdpHostname) {
    if (!pool) return { ok: false, error: 'db_not_ready' };

    // Owner check first (hardcoded env)
    if (String(chatId) === String(process.env.OWNER_CHAT_ID || '')) {
        return { ok: true, role: 'owner' };
    }

    // Operator check
    const [rows] = await pool.execute(
        `SELECT allowed_rdp_hostnames, status FROM operators WHERE chat_id = ? LIMIT 1`,
        [String(chatId)]
    );
    if (rows.length === 0) return { ok: false, error: 'not_registered' };
    if (rows[0].status !== 'approved') return { ok: false, error: `operator_status_${rows[0].status}` };

    const allowedJson = rows[0].allowed_rdp_hostnames;
    if (!allowedJson) {
        // NULL = all approved RDPs — verify hostname is in rdp_registry approved
        const [rdpRows] = await pool.execute(
            `SELECT 1 FROM rdp_registry WHERE rdp_hostname = ? AND status = 'approved' LIMIT 1`,
            [rdpHostname]
        );
        if (rdpRows.length === 0) return { ok: false, error: 'rdp_not_approved' };
        return { ok: true, role: 'operator', scope: 'all_approved' };
    }

    // Restricted scope — parse JSON array
    let allowed;
    try {
        allowed = typeof allowedJson === 'string' ? JSON.parse(allowedJson) : allowedJson;
    } catch (_) {
        return { ok: false, error: 'invalid_scope_json' };
    }
    if (!Array.isArray(allowed) || !allowed.includes(rdpHostname)) {
        return { ok: false, error: 'rdp_not_in_scope' };
    }
    return { ok: true, role: 'operator', scope: 'restricted' };
}

// ==========================================================
// Routes
// ==========================================================

// GET /api/tg/health — liveness check for bot
router.get('/health', (req, res) => {
    res.json({ ok: true, ts: new Date().toISOString() });
});

// POST /api/tg/account/delete
// Body: { alias, rdp_hostname, operator_chat_id }
// Response Sprint 2b: 501 — clientapp support coming Sprint 2e
router.post('/account/delete', async (req, res) => {
    const { alias, rdp_hostname, operator_chat_id } = req.body || {};
    if (!alias || !rdp_hostname || !operator_chat_id) {
        return res.status(400).json({
            error: 'missing_fields',
            detail: 'required: alias, rdp_hostname, operator_chat_id'
        });
    }

    // Validate scope
    const scopeCheck = await validateOperatorScope(operator_chat_id, rdp_hostname);
    if (!scopeCheck.ok) {
        // F2 mini-scan Sprint 2b fix: audit backend-side scope_denied (bot-side already logs,
        // but direct backend probes bypass bot — this closes the audit gap).
        try {
            await pool.execute(
                `INSERT INTO tg_audit_log (chat_id, role, cmd, args, result, error_message)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [String(operator_chat_id), 'unknown', '/delete', `${alias}@${rdp_hostname}`, 'denied', scopeCheck.error]
            );
        } catch (_) { /* non-blocking */ }
        return res.status(403).json({ error: 'scope_denied', detail: scopeCheck.error });
    }

    // Audit the delete request (persisted even though Sprint 2e completes it).
    // result enum is success|denied|error|rejected — use 'success' with note in error_message.
    try {
        await pool.execute(
            `INSERT INTO tg_audit_log (chat_id, role, cmd, args, result, error_message)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [String(operator_chat_id), scopeCheck.role, '/delete', `${alias}@${rdp_hostname}`, 'success', 'sprint2b_scaffold_queued']
        );
    } catch (e) {
        console.error('[TG-IPC] audit insert failed:', e.message);
    }

    // Sprint 2b scaffold — Phase 2e wires actual socket emit to clientapp
    return res.status(501).json({
        status: 'not_implemented_yet',
        detail: 'Backend auth + scope OK. Clientapp support coming Sprint 2e.',
        received: { alias, rdp_hostname, operator_chat_id },
        scope: scopeCheck
    });
});

module.exports = { router, setDb };
