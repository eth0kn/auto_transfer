// Telegram Bot — Backend IPC Routes
// REST endpoints for bot ↔ backend.
//
// Mounted at /api/tg from index.js.
// Auth: Bearer TG_BOT_API_KEY (shared .env) + 127.0.0.1-only enforcement.

const crypto = require('crypto');
const express = require('express');
const router = express.Router();

// Shared pool reference set by setDb()
let pool = null;
function setDb(p) { pool = p; }

// Round-trip to clientapp control socket.
// `emitFn(app_source, rdp_hostname, event, payload) => bool` is injected by index.js.
// `resolveAck(payload)` is called from index.js tg:account_ack listener.
// `pendingTgRequests` map holds in-flight round trips; 30s timeout.
let emitFn = null;
function setEmitter(fn) { emitFn = fn; }
const pendingTgRequests = new Map(); // request_id → {resolve, reject, timer}
const DEFAULT_ROUNDTRIP_MS = parseInt(process.env.TG_ROUNDTRIP_MS || '30000', 10);

// Dynamic app_source resolver — backend is multi-clientapp aware. Satu RDP bisa
// run brimo, mybca atau seabank di waktu berbeda (atau multi simultaneously walau
// uncommon). Reference ke rdpControlSockets Map (keyed `${app_source}:
// ${rdp_hostname}`) di-inject dari index.js via setControlSocketMap.
let rdpControlSocketsRef = null;
function setControlSocketMap(map) { rdpControlSocketsRef = map; }

// botSockets Map reference — untuk /api/tg/status aggregate. Injected dari
// main backend index.js (same pattern as setControlSocketMap).
// Key format: `${app_source}:${alias}`. Untuk aggregate count per app_source.
let botSocketsRef = null;
function setBotSocketMap(map) { botSocketsRef = map; }

/**
 * Scan rdpControlSockets untuk cari ALL active app_sources di hostname tsb.
 * Returns array (0 = no active clientapp, 1 = typical, >1 = multi-app at same RDP rare case).
 * Cleanup path di index.js disconnect handler sudah .delete() dari Map → presence = active.
 */
function getActiveAppSourcesFor(rdp_hostname) {
    if (!rdpControlSocketsRef) return [];
    const sources = [];
    for (const key of rdpControlSocketsRef.keys()) {
        const sep = key.indexOf(':');
        if (sep < 0) continue;
        if (key.slice(sep + 1) === rdp_hostname) {
            sources.push(key.slice(0, sep));
        }
    }
    return sources;
}
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
 * List all approved RDP hostnames in operator's scope.
 * - Owner → all approved RDPs in rdp_registry
 * - Operator with allowed_rdp_hostnames NULL → all approved RDPs
 * - Operator with explicit allow-list → intersection of allow-list ∩ approved
 * Returns array of rdp_hostname strings (empty if none).
 */
async function getOperatorScopeRdps(chatId) {
    if (!pool) return [];
    // Owner
    if (String(chatId) === String(process.env.OWNER_CHAT_ID || '')) {
        const [rows] = await pool.execute(
            `SELECT rdp_hostname FROM rdp_registry WHERE status = 'approved' ORDER BY rdp_hostname`
        );
        return rows.map(r => r.rdp_hostname);
    }
    // Operator
    const [opRows] = await pool.execute(
        `SELECT allowed_rdp_hostnames, status FROM operators WHERE chat_id = ? LIMIT 1`,
        [String(chatId)]
    );
    if (opRows.length === 0 || opRows[0].status !== 'approved') return [];
    const allowedJson = opRows[0].allowed_rdp_hostnames;
    const [approvedRows] = await pool.execute(
        `SELECT rdp_hostname FROM rdp_registry WHERE status = 'approved' ORDER BY rdp_hostname`
    );
    const approved = approvedRows.map(r => r.rdp_hostname);
    if (!allowedJson) return approved;
    let allowed;
    try {
        allowed = typeof allowedJson === 'string' ? JSON.parse(allowedJson) : allowedJson;
    } catch (_) { return []; }
    if (!Array.isArray(allowed)) return [];
    return approved.filter(h => allowed.includes(h));
}

/**
 * Fan-out `tg:alias_lookup` to all RDPs in operator's scope.
 * Per-RDP timeout 5s (shorter than default 30s since this is pre-action resolution).
 * Returns array of hits: [{ rdp_hostname, account_id, alias, device_id, remote_ip, ...}].
 * Zero-hit = empty array; N-hit = array length N. Caller interprets:
 *   - 0 → alias_not_found
 *   - 1 → auto-select
 *   - N>1 → disambiguation picker (operator policy: alias should be unique cross-RDP,
 *            but DB only enforces per-RDP — guard is by operator naming convention, not code)
 */
async function fanoutAliasLookup(alias, operatorChatId, opts = {}) {
    const rdpList = await getOperatorScopeRdps(operatorChatId);
    if (rdpList.length === 0) return { hits: [], scanned: 0 };
    const timeout_ms = opts.timeout_ms || 5000;
    const settled = await Promise.allSettled(
        rdpList.map(rdp => callClientapp(rdp, 'tg:alias_lookup', { alias }, { timeout_ms }))
    );
    const hits = [];
    for (let i = 0; i < settled.length; i++) {
        const rdp = rdpList[i];
        const s = settled[i];
        if (s.status !== 'fulfilled') continue;
        const r = s.value;
        if (!r.ok) continue;
        const hit = r.result?.hit;
        if (hit && hit.account_id) {
            hits.push({ rdp_hostname: rdp, ...hit });
        }
    }
    return { hits, scanned: rdpList.length };
}

/**
 * Fan-out `tg:list_accounts` to all RDPs in operator scope.
 * Per-RDP 5s timeout, parallel. Returns:
 *   { groups: [{rdp_hostname, status: 'ok'|'offline'|'error', accounts: []}], totals: {scanned, responded, accounts, running, stopped} }
 * `status`:
 *   - 'ok' — clientapp responded with accounts array
 *   - 'offline' — no control socket OR timeout (treated identically for display)
 *   - 'error' — other failure (db_error at clientapp side etc)
 * Each account row (non-sensitive): { account_id, alias, device_id, remote_ip,
 *   keep_balance, mutasi_enabled, mirror_enabled, bot_state }
 */
async function fanoutListAccounts(operatorChatId, opts = {}) {
    const rdpList = await getOperatorScopeRdps(operatorChatId);
    const groups = [];
    let totalAccounts = 0, totalRunning = 0, totalStopped = 0, responded = 0;
    if (rdpList.length === 0) return { groups, totals: { scanned: 0, responded: 0, accounts: 0, running: 0, stopped: 0 } };
    const timeout_ms = opts.timeout_ms || 5000;
    const settled = await Promise.allSettled(
        rdpList.map(rdp => callClientapp(rdp, 'tg:list_accounts', {}, { timeout_ms }))
    );
    for (let i = 0; i < settled.length; i++) {
        const rdp = rdpList[i];
        const s = settled[i];
        if (s.status !== 'fulfilled') {
            groups.push({ rdp_hostname: rdp, status: 'error', accounts: [], detail: 'promise_rejected' });
            continue;
        }
        const r = s.value;
        if (!r.ok) {
            const mapped = (r.error === 'rdp_offline' || r.error === 'rdp_timeout') ? 'offline' : 'error';
            groups.push({ rdp_hostname: rdp, status: mapped, accounts: [], detail: r.detail || r.error });
            continue;
        }
        responded++;
        const accounts = Array.isArray(r.result?.accounts) ? r.result.accounts : [];
        totalAccounts += accounts.length;
        for (const a of accounts) {
            if (a.bot_state === 'running') totalRunning++;
            else totalStopped++;
        }
        // Sort accounts within RDP by alias (alphabetical) for consistent output
        accounts.sort((a, b) => String(a.alias).localeCompare(String(b.alias)));
        groups.push({ rdp_hostname: rdp, status: 'ok', accounts });
    }
    return {
        groups,
        totals: {
            scanned: rdpList.length,
            responded,
            accounts: totalAccounts,
            running: totalRunning,
            stopped: totalStopped
        }
    };
}

/**
 * Send event to the target RDP's control socket, await ack with timeout.
 * Returns: { ok: true, result } on success, { ok: false, error, detail, status } on failure.
 *
 * Dynamic app_source resolution:
 *   - If opts.app_source explicit → use it (preserve explicit callers).
 *   - Else → scan rdpControlSockets for active clientapp at this RDP. 1 hit =
 *     auto-pick. 0 hit = rdp_offline error. >1 hit = pick first + log warning
 *     (multi-clientapp at same RDP uncommon in current ops; future fan-out
 *     enhancement if needed).
 */
async function callClientapp(rdp_hostname, event, payload, opts = {}) {
    let app_source = opts.app_source;
    if (!app_source) {
        const active = getActiveAppSourcesFor(rdp_hostname);
        if (active.length === 0) {
            return { ok: false, error: 'rdp_offline', detail: `no active clientapp socket at ${rdp_hostname}`, status: 502 };
        }
        if (active.length > 1) {
            console.warn(`[TG-IPC] ${rdp_hostname} has multiple active app_sources: ${active.join(', ')} — picking first (${active[0]})`);
        }
        app_source = active[0];
    }
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

// GET /api/tg/status — aggregate runtime snapshot for /status TG command.
// Pure backend-side: NO clientapp roundtrip. Data: rdp/operator counts, socket
// counts, queue depth, today stats. Per-RDP scope-filtered breakdown deferred
// (requires clientapp inventory query).
router.get('/status', async (req, res) => {
    if (!pool) return res.status(503).json({ error: 'db_unavailable' });
    try {
        const [rdpCounts] = await pool.execute(
            `SELECT status, COUNT(*) AS cnt FROM rdp_registry GROUP BY status`
        );
        const [operatorCounts] = await pool.execute(
            `SELECT status, COUNT(*) AS cnt FROM operators GROUP BY status`
        );
        const [queueCounts] = await pool.execute(
            `SELECT app_source, status, COUNT(*) AS cnt FROM transfer_request
             WHERE status IN ('PENDING','PROCESSING') GROUP BY app_source, status`
        );
        const [todayStats] = await pool.execute(
            `SELECT app_source,
                    COUNT(*) AS total,
                    SUM(status = 'SUCCESS') AS success_cnt,
                    SUM(status = 'FAILED') AS failed_cnt
             FROM transfer_request
             WHERE DATE(created_at) = CURDATE()
             GROUP BY app_source`
        );

        // Bot sockets online per app_source (iterate injected Map keys)
        const botsByApp = {};
        if (botSocketsRef) {
            for (const key of botSocketsRef.keys()) {
                const sep = key.indexOf(':');
                if (sep < 0) continue;
                const app = key.slice(0, sep);
                botsByApp[app] = (botsByApp[app] || 0) + 1;
            }
        }
        // Control sockets per app_source (reuse existing injected Map)
        const controlByApp = {};
        if (rdpControlSocketsRef) {
            for (const key of rdpControlSocketsRef.keys()) {
                const sep = key.indexOf(':');
                if (sep < 0) continue;
                const app = key.slice(0, sep);
                controlByApp[app] = (controlByApp[app] || 0) + 1;
            }
        }

        res.json({
            ok: true,
            rdps_by_status: Object.fromEntries(rdpCounts.map(r => [r.status, Number(r.cnt)])),
            operators_by_status: Object.fromEntries(operatorCounts.map(o => [o.status, Number(o.cnt)])),
            bots_online_by_app: botsByApp,
            control_sockets_by_app: controlByApp,
            queue_by_app: queueCounts.reduce((acc, r) => {
                acc[r.app_source] = acc[r.app_source] || {};
                acc[r.app_source][r.status] = Number(r.cnt);
                return acc;
            }, {}),
            today_by_app: todayStats.reduce((acc, r) => {
                const total = Number(r.total);
                const success = Number(r.success_cnt);
                acc[r.app_source] = {
                    total,
                    success,
                    failed: Number(r.failed_cnt),
                    success_rate_pct: total > 0 ? Math.round((success / total) * 100) : 0,
                };
                return acc;
            }, {}),
            ts: new Date().toISOString(),
        });
    } catch (e) {
        console.error('[tg-ipc /status]', e.message);
        res.status(500).json({ error: 'internal', detail: e.message });
    }
});

// ==========================================================
// Field whitelist for /edit — gate what's editable from bot.
// Aligned with clientapp accounts table schema. NO username / api_key columns
// exist. Login banking app pakai password saja. remote_ip auto-derived at
// clientapp side via CGNAT regex. mirror_enabled DEFERRED (toggle di card
// langsung via handleMirrorToggle, semantic lebih kompleks dgn passive socket
// lifecycle via applyMirrorToggle).
// Editable (6 fields): alias | password | callback_url | device_id | keep_balance | mutasi_enabled.
// ==========================================================
const EDITABLE_FIELDS = new Set(['alias', 'password', 'callback_url', 'device_id', 'keep_balance', 'mutasi_enabled']);
const SENSITIVE_FIELDS = new Set(['password']);
const ALIAS_REGEX        = /^[^\x00-\x1F\x7F]{1,128}$/;
const URL_REGEX          = /^https?:\/\/.+/i;
// ADB pair fields for /add.
const DEVICE_IP_REGEX    = /^(\d{1,3}\.){3}\d{1,3}:\d{1,5}$/;
const PAIR_CODE_REGEX    = /^\d{6}$/;
// keep_balance numeric field.
const KEEP_BALANCE_REGEX = /^\d+$/;
const KEEP_BALANCE_MAX   = 9_999_999_999;
function isValidDeviceIp(v) {
    if (typeof v !== 'string' || !DEVICE_IP_REGEX.test(v)) return false;
    const [ipPart, portPart] = v.split(':');
    const octets = ipPart.split('.').map(n => parseInt(n, 10));
    if (octets.some(o => o < 0 || o > 255 || Number.isNaN(o))) return false;
    const port = parseInt(portPart, 10);
    return !Number.isNaN(port) && port >= 1 && port <= 65535;
}
function coerceKeepBalance(v) {
    // Accepts number OR numeric string, returns {ok, value} or {ok:false, error}.
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= KEEP_BALANCE_MAX) {
        return { ok: true, value: v };
    }
    if (typeof v === 'string' && KEEP_BALANCE_REGEX.test(v)) {
        const n = parseInt(v, 10);
        if (n >= 0 && n <= KEEP_BALANCE_MAX) return { ok: true, value: n };
    }
    return { ok: false, error: 'invalid_keep_balance' };
}

/**
 * mutasi_enabled coerce.
 * Accepts: boolean | integer 0/1 | string '0'/'1'/'on'/'off'/'true'/'false' (case-insensitive).
 * Returns integer 0 or 1 for forwarding to clientapp.
 */
function coerceMutasiEnabled(v) {
    if (v === true || v === 1) return { ok: true, value: 1 };
    if (v === false || v === 0) return { ok: true, value: 0 };
    if (typeof v === 'string') {
        const s = v.trim().toLowerCase();
        if (s === '1' || s === 'on' || s === 'true' || s === 'yes') return { ok: true, value: 1 };
        if (s === '0' || s === 'off' || s === 'false' || s === 'no') return { ok: true, value: 0 };
    }
    return { ok: false, error: 'invalid_mutasi_enabled' };
}

function maskedArgs(alias, rdp, field, value) {
    const v = SENSITIVE_FIELDS.has(field) ? '***' : (typeof value === 'string' ? value.slice(0, 40) : '?');
    return `${alias}@${rdp}:${field}=${v}`;
}

// POST /api/tg/account/delete
// Body: { alias, rdp_hostname?, operator_chat_id }
// rdp_hostname OPTIONAL — if omitted, fan-out alias_lookup resolves to single RDP
// automatically. Multi-hit returns 300 w/ candidates for bot picker. Zero-hit
// returns 404 alias_not_found.
router.post('/account/delete', async (req, res) => {
    const { alias, rdp_hostname, operator_chat_id } = req.body || {};
    if (!alias || !operator_chat_id) {
        return res.status(400).json({
            error: 'missing_fields',
            detail: 'required: alias, operator_chat_id (rdp_hostname optional)'
        });
    }

    // Resolve rdp_hostname via fan-out if not provided.
    let resolvedRdp = rdp_hostname;
    if (!resolvedRdp) {
        const { hits, scanned } = await fanoutAliasLookup(alias, operator_chat_id);
        if (scanned === 0) return res.status(403).json({ error: 'no_rdps_in_scope', detail: 'operator has no approved RDPs in scope' });
        if (hits.length === 0) return res.status(404).json({ error: 'alias_not_found', detail: `alias "${alias}" not found in any of ${scanned} RDP(s)` });
        if (hits.length > 1) {
            return res.status(300).json({
                error: 'alias_ambiguous',
                detail: `alias "${alias}" found in ${hits.length} RDPs`,
                candidates: hits.map(h => ({ rdp_hostname: h.rdp_hostname, account_id: h.account_id, device_id: h.device_id }))
            });
        }
        resolvedRdp = hits[0].rdp_hostname;
    }

    // Validate scope
    const scopeCheck = await validateOperatorScope(operator_chat_id, resolvedRdp);
    if (!scopeCheck.ok) {
        // Audit backend-side scope_denied (bot-side already logs, but direct
        // backend probes bypass bot — this closes the audit gap).
        try {
            await pool.execute(
                `INSERT INTO tg_audit_log (chat_id, role, cmd, args, result, error_message)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [String(operator_chat_id), 'unknown', '/delete', `${alias}@${resolvedRdp}`, 'denied', scopeCheck.error]
            );
        } catch (_) { /* non-blocking */ }
        return res.status(403).json({ error: 'scope_denied', detail: scopeCheck.error });
    }

    // Round-trip to clientapp control socket.
    const rt = await callClientapp(resolvedRdp, 'tg:account_delete', { alias });
    const auditResult = rt.ok ? 'success' : (rt.error === 'scope_denied' ? 'denied' : 'error');
    const auditMsg = rt.ok ? null : `${rt.error}${rt.detail ? ':' + String(rt.detail).slice(0, 80) : ''}`;
    try {
        await pool.execute(
            `INSERT INTO tg_audit_log (chat_id, role, cmd, args, result, error_message)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [String(operator_chat_id), scopeCheck.role, '/delete', `${alias}@${resolvedRdp}`, auditResult, auditMsg]
        );
    } catch (e) {
        console.error('[TG-IPC] audit insert failed:', e.message);
    }
    if (!rt.ok) return res.status(rt.status).json({ error: rt.error, detail: rt.detail });
    return res.json({ ok: true, resolved_rdp: resolvedRdp, ...rt.result });
});

// POST /api/tg/account/add
// Body: { alias, rdp_hostname, password, callback_url, device_ip, pair_code, operator_chat_id }
// Clientapp runs `adb pair <device_ip> <pair_code>` then DB insert via control-socket
// round-trip. username + api_key intentionally absent from schema — not required
// by banking app login flow.
router.post('/account/add', async (req, res) => {
    const { alias, rdp_hostname, password, callback_url, keep_balance, device_ip, pair_code, operator_chat_id } = req.body || {};
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
    // keep_balance optional — default 0 if omitted (back-compat).
    let keepBalanceCoerced = 0;
    if (keep_balance !== undefined && keep_balance !== null && keep_balance !== '') {
        const kb = coerceKeepBalance(keep_balance);
        if (!kb.ok) {
            return res.status(400).json({ error: 'invalid_keep_balance', detail: `non-negative integer, 0 to ${KEEP_BALANCE_MAX}` });
        }
        keepBalanceCoerced = kb.value;
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

    // Round-trip to clientapp — clientapp runs `adb pair` + DB insert.
    // keep_balance (coerced) forwarded; clientapp binds directly.
    const rt = await callClientapp(rdp_hostname, 'tg:account_create', {
        alias, password, callback_url, device_ip, pair_code,
        keep_balance: keepBalanceCoerced
    });
    const auditArgs = `${alias}@${rdp_hostname} dev=${device_ip} keep=${keepBalanceCoerced} cb=${callback_url.slice(0, 60)}`;
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
// Body: { alias, rdp_hostname?, field, value, operator_chat_id }
// rdp_hostname OPTIONAL — if omitted, fan-out alias_lookup resolves to single
// RDP. Multi-hit returns 300 w/ candidates for bot picker.
router.post('/account/edit', async (req, res) => {
    const { alias, rdp_hostname, field, value, operator_chat_id } = req.body || {};
    if (!alias || !field || value === undefined || value === null || !operator_chat_id) {
        return res.status(400).json({
            error: 'missing_fields',
            detail: 'required: alias, field, value, operator_chat_id (rdp_hostname optional)'
        });
    }

    // Field whitelist — reject unknown (before expensive fan-out)
    if (!EDITABLE_FIELDS.has(field)) {
        try {
            await pool.execute(
                `INSERT INTO tg_audit_log (chat_id, role, cmd, args, result, error_message)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [String(operator_chat_id), 'unknown', '/edit', `${alias}:${field}`, 'rejected', 'field_not_editable']
            );
        } catch (_) { /* non-blocking */ }
        return res.status(400).json({ error: 'field_not_editable', detail: `allowed: ${[...EDITABLE_FIELDS].join('|')}` });
    }

    // Per-field validation (defense in depth — mirrors /add constraints).
    if (typeof value !== 'string' || !value.length) {
        return res.status(400).json({ error: 'invalid_value', detail: 'value must be non-empty string' });
    }
    // Coerce keep_balance + mutasi_enabled here; forwards numeric to clientapp.
    let forwardedValue = value;
    if (field === 'alias') {
        if (!ALIAS_REGEX.test(value)) return res.status(400).json({ error: 'invalid_alias', detail: 'printable chars only, 1-128 length' });
    } else if (field === 'callback_url') {
        if (!URL_REGEX.test(value) || value.length > 2048) return res.status(400).json({ error: 'invalid_callback_url', detail: 'must be http(s)://... ≤2048 chars' });
    } else if (field === 'keep_balance') {
        const kb = coerceKeepBalance(value);
        if (!kb.ok) return res.status(400).json({ error: 'invalid_keep_balance', detail: `non-negative integer, 0 to ${KEEP_BALANCE_MAX}` });
        forwardedValue = kb.value;
    } else if (field === 'mutasi_enabled') {
        const m = coerceMutasiEnabled(value);
        if (!m.ok) return res.status(400).json({ error: 'invalid_mutasi_enabled', detail: 'accept: 0|1|on|off|true|false' });
        forwardedValue = m.value;
    } else if (value.length > 1024) {
        return res.status(400).json({ error: 'invalid_value', detail: 'value must be ≤1024 chars' });
    }

    // Resolve rdp_hostname via fan-out if not provided.
    let resolvedRdp = rdp_hostname;
    if (!resolvedRdp) {
        const { hits, scanned } = await fanoutAliasLookup(alias, operator_chat_id);
        if (scanned === 0) return res.status(403).json({ error: 'no_rdps_in_scope', detail: 'operator has no approved RDPs in scope' });
        if (hits.length === 0) return res.status(404).json({ error: 'alias_not_found', detail: `alias "${alias}" not found in any of ${scanned} RDP(s)` });
        if (hits.length > 1) {
            return res.status(300).json({
                error: 'alias_ambiguous',
                detail: `alias "${alias}" found in ${hits.length} RDPs`,
                candidates: hits.map(h => ({ rdp_hostname: h.rdp_hostname, account_id: h.account_id, device_id: h.device_id }))
            });
        }
        resolvedRdp = hits[0].rdp_hostname;
    }

    // Validate scope (same logic as /delete)
    const scopeCheck = await validateOperatorScope(operator_chat_id, resolvedRdp);
    if (!scopeCheck.ok) {
        try {
            await pool.execute(
                `INSERT INTO tg_audit_log (chat_id, role, cmd, args, result, error_message)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [String(operator_chat_id), 'unknown', '/edit', maskedArgs(alias, resolvedRdp, field, value), 'denied', scopeCheck.error]
            );
        } catch (_) { /* non-blocking */ }
        return res.status(403).json({ error: 'scope_denied', detail: scopeCheck.error });
    }

    // Round-trip to clientapp — clientapp updates account row + bumps updated_at.
    const rt = await callClientapp(resolvedRdp, 'tg:account_edit', { alias, field, value: forwardedValue });
    const auditArgsStr = maskedArgs(alias, resolvedRdp, field, value);
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
    return res.json({ ok: true, resolved_rdp: resolvedRdp, ...rt.result });
});

// GET /api/tg/account/alias_lookup?alias=X&operator_chat_id=Y
// Fan-out alias→RDP resolution for bot commands that accept alias-only (no RDP
// hostname). Returns array of hits across operator's scope.
// Bot inspects hits.length to pick:
//   0 → "alias not found"
//   1 → auto-use that rdp_hostname
//   N>1 → render inline keyboard picker (bot_pick_rdp:<cbid>)
router.get('/account/alias_lookup', async (req, res) => {
    const alias = req.query?.alias;
    const operator_chat_id = req.query?.operator_chat_id;
    if (!alias || !operator_chat_id) {
        return res.status(400).json({ error: 'missing_fields', detail: 'required: alias, operator_chat_id' });
    }
    const { hits, scanned } = await fanoutAliasLookup(alias, operator_chat_id);
    return res.json({ ok: true, alias, scanned, hits });
});

// POST /api/tg/bot/start
// Body: { alias, rdp_hostname?, operator_chat_id }
// Remote start bot engine for account.
router.post('/bot/start', async (req, res) => {
    return handleBotControl(req, res, 'start');
});

// POST /api/tg/bot/stop
// Body: { alias, rdp_hostname?, operator_chat_id }
// Remote stop bot engine for account.
router.post('/bot/stop', async (req, res) => {
    return handleBotControl(req, res, 'stop');
});

// Core bot start/stop logic. Pure async fn — returns { status, data } object.
// Used by both Express wrapper (handleBotControl) and in-process callers
// (e.g. dashboard remote control routes in index.js).
//
// Fan-out alias resolution + scope check + round-trip to clientapp's
// `tg:bot_control` handler (via tg:bot_control_ack).
//
// For 'start', clientapp may await bot-started/bot-start-failed internal events
// up to 15s. For 'stop', clientapp acks immediately after engine.stop() flip
// (teardown happens asynchronously in the engine's .finally()). 20s backend
// timeout = 5s safety over clientapp's 15s internal wait.
async function botControl({ alias, rdp_hostname, operator_chat_id, action, audit_role }) {
    if (!alias || !operator_chat_id) {
        return { status: 400, data: { error: 'missing_fields', detail: 'required: alias, operator_chat_id (rdp_hostname optional)' } };
    }
    if (action !== 'start' && action !== 'stop') {
        return { status: 400, data: { error: 'bad_action', detail: 'action must be start|stop' } };
    }

    // Resolve alias → RDP if not provided
    let resolvedRdp = rdp_hostname;
    if (!resolvedRdp) {
        const { hits, scanned } = await fanoutAliasLookup(alias, operator_chat_id);
        if (scanned === 0) return { status: 403, data: { error: 'no_rdps_in_scope', detail: 'operator has no approved RDPs in scope' } };
        if (hits.length === 0) return { status: 404, data: { error: 'alias_not_found', detail: `alias "${alias}" not found in any of ${scanned} RDP(s)` } };
        if (hits.length > 1) {
            return {
                status: 300,
                data: {
                    error: 'alias_ambiguous',
                    detail: `alias "${alias}" found in ${hits.length} RDPs`,
                    candidates: hits.map(h => ({ rdp_hostname: h.rdp_hostname, account_id: h.account_id, device_id: h.device_id }))
                }
            };
        }
        resolvedRdp = hits[0].rdp_hostname;
    }

    // Validate scope
    const scopeCheck = await validateOperatorScope(operator_chat_id, resolvedRdp);
    if (!scopeCheck.ok) {
        try {
            await pool.execute(
                `INSERT INTO tg_audit_log (chat_id, role, cmd, args, result, error_message)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [String(operator_chat_id), audit_role || 'unknown', `/${action}`, `${alias}@${resolvedRdp}`, 'denied', scopeCheck.error]
            );
        } catch (_) { /* non-blocking */ }
        return { status: 403, data: { error: 'scope_denied', detail: scopeCheck.error } };
    }

    // Round-trip to clientapp `tg:bot_control`.
    const rt = await callClientapp(resolvedRdp, 'tg:bot_control', { action, alias }, { timeout_ms: 20000 });
    const auditResult = rt.ok ? 'success' : (rt.error === 'scope_denied' ? 'denied' : 'error');
    const auditMsg = rt.ok ? null : `${rt.error}${rt.detail ? ':' + String(rt.detail).slice(0, 80) : ''}`;
    try {
        await pool.execute(
            `INSERT INTO tg_audit_log (chat_id, role, cmd, args, result, error_message)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [String(operator_chat_id), audit_role || scopeCheck.role, `/${action}`, `${alias}@${resolvedRdp}`, auditResult, auditMsg]
        );
    } catch (e) {
        console.error('[TG-IPC] audit insert failed:', e.message);
    }
    if (!rt.ok) return { status: rt.status, data: { error: rt.error, detail: rt.detail } };
    return { status: 200, data: { ok: true, resolved_rdp: resolvedRdp, action, ...rt.result } };
}

// Thin Express wrapper for /api/tg/bot/start + /bot/stop.
async function handleBotControl(req, res, action) {
    const { alias, rdp_hostname, operator_chat_id } = req.body || {};
    const result = await botControl({ alias, rdp_hostname, operator_chat_id, action });
    return res.status(result.status).json(result.data);
}

// GET /api/tg/account/devices?rdp_hostname=X
// Returns ADB device list live from target clientapp, used by /edit device_id
// picker to show a dropdown instead of free-text input.
// Round-trip via `tg:devices_query` control-socket event; clientapp acks with
// `tg:devices_ack` carrying `{ ok, devices: [{id, label}] }`.
router.get('/account/devices', async (req, res) => {
    const rdp_hostname = req.query?.rdp_hostname;
    if (!rdp_hostname) {
        return res.status(400).json({ error: 'missing_fields', detail: 'required: rdp_hostname' });
    }
    // Note: no scope check on this read-only endpoint — the bot's /edit flow
    // already verified scope before issuing the pick_field callback, so by the
    // time the dropdown fetch happens the operator's scope has been validated.
    const rt = await callClientapp(rdp_hostname, 'tg:devices_query', {});
    if (!rt.ok) return res.status(rt.status).json({ error: rt.error, detail: rt.detail });
    const devices = Array.isArray(rt.result?.devices) ? rt.result.devices : [];
    return res.json({ ok: true, devices });
});

// POST /api/tg/rdp/revoke_kick
// Force-disconnect all bot sockets + control sockets attached to a revoked RDP.
// Called by owner.js handleRevokeRdp AFTER DB UPDATE status='revoked'.
// Clientapp socket.io default reconnect → backend rejects at register gate (revoked).
// Returns count disconnected per bucket.
router.post('/rdp/revoke_kick', async (req, res) => {
    const { hostname } = req.body || {};
    if (!hostname) return res.status(400).json({ error: 'missing_fields', detail: 'required: hostname' });

    let botDisconnected = 0;
    let controlDisconnected = 0;

    // Bot sockets — key: `${app_source}:${alias}`, socket has rdp_hostname stored at register time
    if (botSocketsRef) {
        for (const sock of botSocketsRef.values()) {
            if (sock.rdp_hostname === hostname) {
                try {
                    sock.disconnect(true);
                    botDisconnected++;
                } catch (_) { /* already dead */ }
            }
        }
    }

    // Control sockets — key: `${app_source}:${rdp_hostname}` — straight-match on map key suffix
    if (rdpControlSocketsRef) {
        for (const [key, sock] of rdpControlSocketsRef.entries()) {
            const sep = key.indexOf(':');
            if (sep < 0) continue;
            if (key.slice(sep + 1) === hostname) {
                try {
                    sock.disconnect(true);
                    controlDisconnected++;
                } catch (_) { /* already dead */ }
            }
        }
    }

    console.log(`[tg-ipc /rdp/revoke_kick] hostname=${hostname} bot=${botDisconnected} control=${controlDisconnected}`);
    return res.json({ ok: true, hostname, bot_disconnected: botDisconnected, control_disconnected: controlDisconnected });
});

// GET /api/tg/accounts/list?operator_chat_id=X
// Fan-out list of all accounts across operator's scope. Returns groups-by-RDP
// structure + totals summary.
// Each account row: non-sensitive metadata only (NO password, NO callback_url).
router.get('/accounts/list', async (req, res) => {
    const operator_chat_id = req.query?.operator_chat_id;
    if (!operator_chat_id) {
        return res.status(400).json({ error: 'missing_fields', detail: 'required: operator_chat_id' });
    }
    const result = await fanoutListAccounts(operator_chat_id);
    return res.json({ ok: true, ...result });
});

module.exports = {
    router, setDb, setEmitter, setControlSocketMap, setBotSocketMap, resolveAck,
    // In-process API for dashboard remote control (Phase 1 v4.6.0).
    // Bypasses loopback+Bearer gate since these are called from the same Node
    // process (index.js dashboard routes under cookie auth).
    fanoutListAccounts,  // GET /api/dashboard/accounts proxy
    botControl,          // POST /api/dashboard/bot/{start,stop} proxy
};
