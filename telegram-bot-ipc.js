// Telegram Bot — Backend IPC Routes
// Sprint 2b (2026-11-22): REST endpoints for bot ↔ backend.
// Decision Q5=C locked: REST via loopback + Bearer auth.
//
// Mounted at /api/tg from index.js.
// Auth: Bearer TG_BOT_API_KEY (shared .env) + 127.0.0.1-only enforcement.

const crypto = require('crypto');
const express = require('express');
const router = express.Router();

// Shared pool reference set by setDb()
let pool = null;
function setDb(p) { pool = p; }

// Sprint 2e (v4.3.8): round-trip to clientapp control socket.
// `emitFn(app_source, rdp_hostname, event, payload) => bool` is injected by index.js.
// `resolveAck(payload)` is called from index.js tg:account_ack listener.
// `pendingTgRequests` map holds in-flight round trips; 30s timeout.
let emitFn = null;
function setEmitter(fn) { emitFn = fn; }
const pendingTgRequests = new Map(); // request_id → {resolve, reject, timer}
const DEFAULT_ROUNDTRIP_MS = parseInt(process.env.TG_ROUNDTRIP_MS || '30000', 10);
function resolveAck(payload) {
    if (!payload?.request_id) return;
    const pending = pendingTgRequests.get(payload.request_id);
    if (!pending) return; // already timed out or ack for unknown request
    clearTimeout(pending.timer);
    pendingTgRequests.delete(payload.request_id);
    if (payload.ok) pending.resolve(payload);
    else pending.reject({ code: payload.error_code || 'client_error', detail: payload.error_message });
}

/**
 * Send event to the target RDP's control socket, await ack with timeout.
 * Returns: { ok: true, result } on success, { ok: false, error, detail, status } on failure.
 * app_source defaults to 'brimo' for Sprint 2e scope — Sprint 2f expands to mybca/seabank.
 */
async function callClientapp(rdp_hostname, event, payload, opts = {}) {
    const app_source = opts.app_source || 'brimo';
    const timeout_ms = opts.timeout_ms || DEFAULT_ROUNDTRIP_MS;
    if (!emitFn) return { ok: false, error: 'emit_not_wired', status: 500 };
    const request_id = crypto.randomUUID();
    const sent = emitFn(app_source, rdp_hostname, event, { ...payload, request_id });
    if (!sent) return { ok: false, error: 'rdp_offline', detail: `no control socket for ${app_source}:${rdp_hostname}`, status: 502 };
    try {
        const result = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                pendingTgRequests.delete(request_id);
                reject({ code: 'rdp_timeout', detail: `${timeout_ms}ms no response` });
            }, timeout_ms);
            pendingTgRequests.set(request_id, { resolve, reject, timer });
        });
        return { ok: true, result };
    } catch (err) {
        const code = err.code || 'client_error';
        const status = code === 'rdp_timeout' ? 504 : 502;
        return { ok: false, error: code, detail: err.detail, status };
    }
}

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

// ==========================================================
// Field whitelist for /edit — gate what's editable from bot
// v4.3.6 hotfix (scanner 2026-11-22): aligned with clientapp accounts table.
// NO username / api_key columns exist. Login BRImo pakai password saja.
// Editable: alias | password | callback_url | device_id | remote_ip (5 fields).
// Deferred (need toggle/number validation): keep_balance, mutasi_enabled, mirror_enabled.
// ==========================================================
const EDITABLE_FIELDS = new Set(['alias', 'password', 'callback_url', 'device_id', 'remote_ip']);
const SENSITIVE_FIELDS = new Set(['password']);
const ALIAS_REGEX     = /^[^\x00-\x1F\x7F]{1,128}$/;
const URL_REGEX       = /^https?:\/\/.+/i;
// Sprint 2d-2 (v4.3.7): ADB pair fields for /add.
const DEVICE_IP_REGEX = /^(\d{1,3}\.){3}\d{1,3}:\d{1,5}$/;
const PAIR_CODE_REGEX = /^\d{6}$/;
function isValidDeviceIp(v) {
    if (typeof v !== 'string' || !DEVICE_IP_REGEX.test(v)) return false;
    const [ipPart, portPart] = v.split(':');
    const octets = ipPart.split('.').map(n => parseInt(n, 10));
    if (octets.some(o => o < 0 || o > 255 || Number.isNaN(o))) return false;
    const port = parseInt(portPart, 10);
    return !Number.isNaN(port) && port >= 1 && port <= 65535;
}

function maskedArgs(alias, rdp, field, value) {
    const v = SENSITIVE_FIELDS.has(field) ? '***' : (typeof value === 'string' ? value.slice(0, 40) : '?');
    return `${alias}@${rdp}:${field}=${v}`;
}

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

    // Sprint 2e (v4.3.8): round-trip to clientapp control socket.
    const rt = await callClientapp(rdp_hostname, 'tg:account_delete', { alias });
    const auditResult = rt.ok ? 'success' : (rt.error === 'scope_denied' ? 'denied' : 'error');
    const auditMsg = rt.ok ? null : `${rt.error}${rt.detail ? ':' + String(rt.detail).slice(0, 80) : ''}`;
    try {
        await pool.execute(
            `INSERT INTO tg_audit_log (chat_id, role, cmd, args, result, error_message)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [String(operator_chat_id), scopeCheck.role, '/delete', `${alias}@${rdp_hostname}`, auditResult, auditMsg]
        );
    } catch (e) {
        console.error('[TG-IPC] audit insert failed:', e.message);
    }
    if (!rt.ok) return res.status(rt.status).json({ error: rt.error, detail: rt.detail });
    return res.json({ ok: true, ...rt.result });
});

// POST /api/tg/account/add
// Body: { alias, rdp_hostname, password, callback_url, device_ip, pair_code, operator_chat_id }
// v4.3.6 hotfix: username + api_key dropped — not in clientapp schema.
// v4.3.7 (Sprint 2d-2): device_ip + pair_code added per Q2=C ADB pair step.
// Response: 501 — clientapp support (DB insert + `adb pair` relay) coming Sprint 2e.
router.post('/account/add', async (req, res) => {
    const { alias, rdp_hostname, password, callback_url, device_ip, pair_code, operator_chat_id } = req.body || {};
    const missing = [];
    if (!alias) missing.push('alias');
    if (!rdp_hostname) missing.push('rdp_hostname');
    if (!password) missing.push('password');
    if (!callback_url) missing.push('callback_url');
    if (!device_ip) missing.push('device_ip');
    if (!pair_code) missing.push('pair_code');
    if (!operator_chat_id) missing.push('operator_chat_id');
    if (missing.length) {
        return res.status(400).json({ error: 'missing_fields', detail: `required: ${missing.join(', ')}` });
    }

    // Length + format guards (defense in depth against bot-side slip-through)
    if (typeof alias !== 'string' || !ALIAS_REGEX.test(alias)) {
        return res.status(400).json({ error: 'invalid_alias', detail: 'printable chars only, 1-128 length' });
    }
    if (typeof password !== 'string' || !password.length || password.length > 1024) {
        return res.status(400).json({ error: 'invalid_password', detail: 'password must be non-empty string ≤1024 chars' });
    }
    if (typeof callback_url !== 'string' || !URL_REGEX.test(callback_url) || callback_url.length > 2048) {
        return res.status(400).json({ error: 'invalid_callback_url', detail: 'must be http(s)://... ≤2048 chars' });
    }
    if (!isValidDeviceIp(device_ip)) {
        return res.status(400).json({ error: 'invalid_device_ip', detail: 'IP:PORT (e.g. 100.64.0.11:40123), octets 0-255, port 1-65535' });
    }
    if (typeof pair_code !== 'string' || !PAIR_CODE_REGEX.test(pair_code)) {
        return res.status(400).json({ error: 'invalid_pair_code', detail: 'exactly 6 digits' });
    }

    // Validate scope
    const scopeCheck = await validateOperatorScope(operator_chat_id, rdp_hostname);
    if (!scopeCheck.ok) {
        try {
            await pool.execute(
                `INSERT INTO tg_audit_log (chat_id, role, cmd, args, result, error_message)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [String(operator_chat_id), 'unknown', '/add', `${alias}@${rdp_hostname}`, 'denied', scopeCheck.error]
            );
        } catch (_) { /* non-blocking */ }
        return res.status(403).json({ error: 'scope_denied', detail: scopeCheck.error });
    }

    // Sprint 2e (v4.3.8): round-trip to clientapp — clientapp runs adb pair + DB insert.
    const rt = await callClientapp(rdp_hostname, 'tg:account_create', {
        alias, password, callback_url, device_ip, pair_code
    });
    const auditArgs = `${alias}@${rdp_hostname} dev=${device_ip} cb=${callback_url.slice(0, 60)}`;
    const auditResult = rt.ok ? 'success' : (rt.error === 'scope_denied' ? 'denied' : 'error');
    const auditMsg = rt.ok ? null : `${rt.error}${rt.detail ? ':' + String(rt.detail).slice(0, 80) : ''}`;
    try {
        await pool.execute(
            `INSERT INTO tg_audit_log (chat_id, role, cmd, args, result, error_message)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [String(operator_chat_id), scopeCheck.role, '/add', auditArgs, auditResult, auditMsg]
        );
    } catch (e) {
        console.error('[TG-IPC] audit insert failed:', e.message);
    }
    if (!rt.ok) return res.status(rt.status).json({ error: rt.error, detail: rt.detail });
    return res.json({ ok: true, ...rt.result });
});

// POST /api/tg/account/edit
// Body: { alias, rdp_hostname, field, value, operator_chat_id }
// Response Sprint 2c: 501 — clientapp support coming Sprint 2e
router.post('/account/edit', async (req, res) => {
    const { alias, rdp_hostname, field, value, operator_chat_id } = req.body || {};
    if (!alias || !rdp_hostname || !field || value === undefined || value === null || !operator_chat_id) {
        return res.status(400).json({
            error: 'missing_fields',
            detail: 'required: alias, rdp_hostname, field, value, operator_chat_id'
        });
    }

    // Field whitelist — reject unknown
    if (!EDITABLE_FIELDS.has(field)) {
        try {
            await pool.execute(
                `INSERT INTO tg_audit_log (chat_id, role, cmd, args, result, error_message)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [String(operator_chat_id), 'unknown', '/edit', `${alias}@${rdp_hostname}:${field}`, 'rejected', 'field_not_editable']
            );
        } catch (_) { /* non-blocking */ }
        return res.status(400).json({ error: 'field_not_editable', detail: `allowed: ${[...EDITABLE_FIELDS].join('|')}` });
    }

    // Per-field validation (defense in depth — mirrors /add constraints).
    if (typeof value !== 'string' || !value.length) {
        return res.status(400).json({ error: 'invalid_value', detail: 'value must be non-empty string' });
    }
    if (field === 'alias') {
        if (!ALIAS_REGEX.test(value)) return res.status(400).json({ error: 'invalid_alias', detail: 'printable chars only, 1-128 length' });
    } else if (field === 'callback_url') {
        if (!URL_REGEX.test(value) || value.length > 2048) return res.status(400).json({ error: 'invalid_callback_url', detail: 'must be http(s)://... ≤2048 chars' });
    } else if (value.length > 1024) {
        return res.status(400).json({ error: 'invalid_value', detail: 'value must be ≤1024 chars' });
    }

    // Validate scope (same logic as /delete)
    const scopeCheck = await validateOperatorScope(operator_chat_id, rdp_hostname);
    if (!scopeCheck.ok) {
        try {
            await pool.execute(
                `INSERT INTO tg_audit_log (chat_id, role, cmd, args, result, error_message)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [String(operator_chat_id), 'unknown', '/edit', maskedArgs(alias, rdp_hostname, field, value), 'denied', scopeCheck.error]
            );
        } catch (_) { /* non-blocking */ }
        return res.status(403).json({ error: 'scope_denied', detail: scopeCheck.error });
    }

    // Sprint 2e (v4.3.8): round-trip to clientapp — clientapp updates account row + bumps updated_at.
    const rt = await callClientapp(rdp_hostname, 'tg:account_edit', { alias, field, value });
    const auditArgsStr = maskedArgs(alias, rdp_hostname, field, value);
    const auditResult = rt.ok ? 'success' : (rt.error === 'scope_denied' ? 'denied' : 'error');
    const auditMsg = rt.ok ? null : `${rt.error}${rt.detail ? ':' + String(rt.detail).slice(0, 80) : ''}`;
    try {
        await pool.execute(
            `INSERT INTO tg_audit_log (chat_id, role, cmd, args, result, error_message)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [String(operator_chat_id), scopeCheck.role, '/edit', auditArgsStr, auditResult, auditMsg]
        );
    } catch (e) {
        console.error('[TG-IPC] audit insert failed:', e.message);
    }
    if (!rt.ok) return res.status(rt.status).json({ error: rt.error, detail: rt.detail });
    return res.json({ ok: true, ...rt.result });
});

module.exports = { router, setDb, setEmitter, resolveAck };
