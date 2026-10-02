/**
 * auto_transfer — Unified Backend
 * Version: 2.0.0
 * Merge dari 2 backend legacy (brimo :3005 + mybca :3006) → unified :3010
 *
 * Baca docs/ARCHITECTURE.md untuk system design lengkap.
 * Baca docs/API-CONTRACT.md untuk endpoint + socket spec.
 * Baca docs/MIGRATION.md untuk cutover plan.
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mysql = require('mysql2/promise');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');

// ==========================================================
// CONSTANTS
// ==========================================================
const APP_SOURCES = ['brimo', 'mybca', 'seabank'];
const PORT = parseInt(process.env.PORT) || 3010;
const VALIDATION_TIMEOUT_MS = parseInt(process.env.VALIDATION_TIMEOUT_MS) || 60000;
const PROCESSING_STALE_MS = parseInt(process.env.PROCESSING_STALE_MS) || 180000;
const PENDING_STALE_MS = parseInt(process.env.PENDING_STALE_MS) || 10 * 60 * 1000; // 10 min
const LEGACY_UNPREFIXED = process.env.LEGACY_UNPREFIXED_ROUTES === 'true';

// ==========================================================
// APP + DB + IO
// ==========================================================
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'auto_transfer_db_unified',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// ==========================================================
// IN-MEMORY STATE
// ==========================================================
const botSockets = new Map();       // key: `${app_source}:${alias}` → socket
const validationTimers = new Map(); // key: task_id → setTimeout handle
const taskOwner = new Map();        // key: task_id → { app, alias }

// ==========================================================
// MIDDLEWARE
// ==========================================================
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ==========================================================
// HELPERS
// ==========================================================
function emitToBot(app_source, alias, event, payload) {
    const sock = botSockets.get(`${app_source}:${alias}`);
    if (!sock) return false;
    sock.emit(event, payload);
    return true;
}

function generateTrxId() {
    const random = crypto.randomBytes(4).toString('hex').toUpperCase();
    return `TRX-${random}`;
}

function getApiKey(app_source) {
    const perApp = process.env[`API_KEY_${app_source.toUpperCase()}`];
    return perApp || process.env.API_KEY;
}

function requireAuth(req, res, next) {
    if (req.cookies.isLoggedIn === 'true') return next();
    res.redirect('/login');
}

function requireApiKey(app_source) {
    return (req, res, next) => {
        const key = req.headers['x-api-key'];
        const expected = getApiKey(app_source);
        if (!key || key !== expected) {
            console.log(`🛑 [${app_source}] Unauthorized POST /transfer attempt`);
            return res.status(401).json({ success: false, msg: 'Invalid or Missing X-API-KEY' });
        }
        next();
    };
}

// ==========================================================
// ROUTER FACTORY (per app_source)
// ==========================================================
function createBotRouter(app_source) {
    const r = express.Router();

    // A. External submit — /{app}/transfer
    r.post('/transfer', requireApiKey(app_source), async (req, res) => {
        try {
            const { alias, bank, dest, amount, pin } = req.body;
            if (!alias || !dest || !amount || !pin) {
                return res.status(400).json({ success: false, msg: 'Data wajib diisi' });
            }
            const newTaskId = generateTrxId();
            await pool.execute(
                `INSERT INTO transfer_request (id, app_source, bot_alias, bank_type, dest, amount, pin, status)
                 VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING')`,
                [newTaskId, app_source, alias, bank || 'BRI', dest, amount, pin]
            );

            const dispatched = emitToBot(app_source, alias, 'task:new', {
                task_id: newTaskId,
                bank_type: bank || 'BRI',
                destination: dest,
                amount: parseFloat(amount),
                pin,
                alias
            });
            if (dispatched) {
                taskOwner.set(newTaskId, { app: app_source, alias });
                console.log(`[${app_source}] [SOCKET EMIT] Task ${newTaskId} -> ${alias}`);
            }

            // Dashboard realtime — task masuk queue
            io.emit('new_task', {
                task_id: newTaskId,
                app_source,
                alias,
                bot_alias: alias,
                bank_type: bank || 'BRI',
                dest,
                amount: parseFloat(amount),
                status: dispatched ? 'PENDING' : 'PENDING',
                created_at: new Date().toISOString()
            });

            res.json({ success: true, msg: 'Request masuk antrian', task_id: newTaskId });
        } catch (err) {
            res.status(500).json({ success: false, msg: err.message });
        }
    });

    // B. Deprecated polling (410 Gone)
    r.post('/get-task', (req, res) => res.status(410).json({
        success: false,
        msg: 'Polling disabled. Use WebSocket only.'
    }));
    r.get('/get-validation-decision/:task_id', (req, res) => res.status(410).json({
        success: false,
        msg: 'Polling disabled. Decision via WebSocket only.'
    }));

    // C. Bot final report — /{app}/update-task
    r.post('/update-task', async (req, res) => {
        try {
            const { task_id, status, message } = req.body;
            if (!['SUCCESS', 'FAILED'].includes(status)) {
                return res.status(400).json({ msg: 'Invalid Status' });
            }
            let msgObj = null;
            try {
                msgObj = typeof message === 'string' ? JSON.parse(message) : message;
            } catch (_) {
                msgObj = { text: String(message) };
            }
            const finalMessage = msgObj?.text || msgObj?.reason || '';
            const refNumber = msgObj?.ref_number || null;

            await pool.execute(
                `UPDATE transfer_request SET status = ?, message = ?, ref_number = ?, updated_at = NOW()
                 WHERE id = ? AND app_source = ?`,
                [status, finalMessage, refNumber, task_id, app_source]
            );
            taskOwner.delete(task_id);
            io.emit('task_completed', { task_id, status, app_source });
            console.log(`[${app_source}] [REPORT] Task ${task_id} -> ${status}`);
            res.json({ success: true });
        } catch (err) {
            console.error(`[${app_source}] [UPDATE-TASK ERROR]`, err.message);
            res.status(500).json({ success: false });
        }
    });

    // D. Bot validation request — /{app}/validate-confirmation
    r.post('/validate-confirmation', async (req, res) => {
        try {
            const d = req.body;
            await pool.execute(
                `INSERT INTO transfer_validations
                   (task_id, app_source, device_id, account_name, target_name_extracted, target_rek_extracted, bank_name, total_amount, status)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'WAITING')
                 ON DUPLICATE KEY UPDATE
                   status = 'WAITING',
                   target_name_extracted = VALUES(target_name_extracted),
                   target_rek_extracted = VALUES(target_rek_extracted),
                   bank_name = VALUES(bank_name),
                   total_amount = VALUES(total_amount),
                   updated_at = NOW()`,
                [d.task_id, app_source, d.device_id, d.account_name,
                 d.account_name_extracted, d.account_number_extracted,
                 d.bank_name, d.total_amount]
            );

            const [reqData] = await pool.execute(
                `SELECT amount, dest FROM transfer_request WHERE id = ? AND app_source = ?`,
                [d.task_id, app_source]
            );

            io.emit('new_validation', {
                ...d,
                app_source,
                alias: d.account_name,
                bot_alias: d.account_name,
                target_name_extracted: d.account_name_extracted,
                target_rek_extracted: d.account_number_extracted,
                original_amount: reqData[0]?.amount || 0,
                original_dest: reqData[0]?.dest || '-',
                created_at: new Date().toISOString()
            });

            // Validation timeout
            if (!validationTimers.has(d.task_id)) {
                const timer = setTimeout(async () => {
                    console.log(`⏰ [${app_source}] Validation timeout: ${d.task_id}`);
                    try {
                        await pool.execute(
                            `UPDATE transfer_validations SET status = 'ABORT'
                             WHERE task_id = ? AND status = 'WAITING'`,
                            [d.task_id]
                        );
                        await pool.execute(
                            `UPDATE transfer_request SET status = 'FAILED', message = 'Validation timeout'
                             WHERE id = ? AND status = 'PROCESSING'`,
                            [d.task_id]
                        );
                    } catch (e) {
                        console.error(`[${app_source}] Timeout DB error:`, e.message);
                    }
                    const owner = taskOwner.get(d.task_id);
                    if (owner) {
                        emitToBot(owner.app, owner.alias, 'decision', {
                            task_id: d.task_id, status: 'ABORT', source: 'TIMEOUT'
                        });
                    }
                    io.emit('decision_updated', { task_id: d.task_id, status: 'ABORT', app_source });
                    validationTimers.delete(d.task_id);
                }, VALIDATION_TIMEOUT_MS);
                validationTimers.set(d.task_id, timer);
            }

            res.json({ success: true });
        } catch (e) {
            console.error(`[${app_source}] [VALIDATE ERROR]`, e.message);
            res.status(500).json({ error: e.message });
        }
    });

    // E. Bot decision report — /{app}/update-decision
    r.post('/update-decision', async (req, res) => {
        try {
            const { task_id, status } = req.body;
            const msg = req.body.message || 'Rejected by Admin';

            await pool.execute(
                `UPDATE transfer_validations SET status = ? WHERE task_id = ? AND app_source = ?`,
                [status, task_id, app_source]
            );
            if (validationTimers.has(task_id)) {
                clearTimeout(validationTimers.get(task_id));
                validationTimers.delete(task_id);
            }
            const owner = taskOwner.get(task_id);
            if (owner) {
                emitToBot(owner.app, owner.alias, 'decision', {
                    task_id, status, source: 'ADMIN'
                });
            }
            if (status === 'ABORT') {
                if (msg === 'Rejected by Admin') {
                    await pool.execute(
                        `UPDATE transfer_request SET status = 'FAILED', message = ? WHERE id = ? AND app_source = ?`,
                        [msg, task_id, app_source]
                    );
                } else {
                    await pool.execute(
                        `UPDATE transfer_request SET status = 'FAILED', message = ? WHERE id = ? AND app_source = ? AND message != 'Rejected by Admin'`,
                        [msg, task_id, app_source]
                    );
                }
            }
            io.emit('decision_updated', { task_id, status, app_source });
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    return r;
}

// Mount router per app
for (const src of APP_SOURCES) {
    app.use(`/${src}`, createBotRouter(src));
}

// Legacy unprefixed routes (backward compat, opt-in via env)
if (LEGACY_UNPREFIXED) {
    console.log('⚠️ LEGACY_UNPREFIXED_ROUTES=true — mounting unprefixed routes as brimo');
    app.use('/', createBotRouter('brimo'));
}

// ==========================================================
// DASHBOARD ACTION — /update-decision (default namespace, any app)
// ==========================================================
app.post('/update-decision', requireAuth, async (req, res) => {
    try {
        const { task_id, status } = req.body;
        const msg = req.body.message || 'Rejected by Admin';

        // Detect app_source dari validation row
        const [rows] = await pool.execute(
            'SELECT app_source FROM transfer_validations WHERE task_id = ?',
            [task_id]
        );
        const app_source = rows[0]?.app_source;
        if (!app_source) {
            return res.status(404).json({ error: 'validation not found' });
        }

        await pool.execute(
            'UPDATE transfer_validations SET status = ? WHERE task_id = ?',
            [status, task_id]
        );
        if (validationTimers.has(task_id)) {
            clearTimeout(validationTimers.get(task_id));
            validationTimers.delete(task_id);
        }
        const owner = taskOwner.get(task_id);
        if (owner) {
            emitToBot(owner.app, owner.alias, 'decision', {
                task_id, status, source: 'ADMIN'
            });
        }
        if (status === 'ABORT' && msg === 'Rejected by Admin') {
            await pool.execute(
                `UPDATE transfer_request SET status = 'FAILED', message = ? WHERE id = ?`,
                [msg, task_id]
            );
        }
        io.emit('decision_updated', { task_id, status, app_source });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ==========================================================
// DASHBOARD API ENDPOINTS
// ==========================================================

// GET /api/history — filter: app, status, search, days, limit
app.get('/api/history', requireAuth, async (req, res) => {
    const appFilter = (req.query.app || 'all').toLowerCase();
    const statusFilter = (req.query.status || 'all').toUpperCase();
    const search = req.query.search || '';
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const days = Math.min(Math.max(parseInt(req.query.days) || 7, 1), 90);

    const args = [];
    let where = `WHERE r.status IN ('SUCCESS','FAILED') AND r.updated_at >= (NOW() - INTERVAL ${days} DAY)`;
    if (appFilter !== 'all' && APP_SOURCES.includes(appFilter)) {
        where += ' AND r.app_source = ?';
        args.push(appFilter);
    }
    if (['SUCCESS', 'FAILED'].includes(statusFilter)) {
        where += ' AND r.status = ?';
        args.push(statusFilter);
    }
    if (search) {
        where += ' AND (r.id LIKE ? OR r.ref_number LIKE ? OR r.dest LIKE ? OR v.target_name_extracted LIKE ?)';
        const like = `%${search}%`;
        args.push(like, like, like, like);
    }

    try {
        const [rows] = await pool.execute(
            `SELECT r.id, r.app_source, r.bot_alias, r.dest, r.amount, r.status, r.ref_number, r.message, r.updated_at,
                    v.target_name_extracted, v.bank_name
             FROM transfer_request r
             LEFT JOIN transfer_validations v ON r.id = v.task_id
             ${where}
             ORDER BY r.updated_at DESC
             LIMIT ${limit}`,
            args
        );
        res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/pending-validations — filter: app
app.get('/api/pending-validations', requireAuth, async (req, res) => {
    const appFilter = (req.query.app || 'all').toLowerCase();
    const args = [];
    let where = "WHERE v.status = 'WAITING'";
    if (appFilter !== 'all' && APP_SOURCES.includes(appFilter)) {
        where += ' AND v.app_source = ?';
        args.push(appFilter);
    }
    try {
        const [rows] = await pool.execute(
            `SELECT v.*, r.amount AS original_amount, r.dest AS original_dest, r.bot_alias
             FROM transfer_validations v
             JOIN transfer_request r ON v.task_id = r.id
             ${where}
             ORDER BY v.created_at DESC`,
            args
        );
        res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/queue/:task_id — admin cancel task PENDING (belum di-pickup bot)
app.delete('/api/queue/:task_id', requireAuth, async (req, res) => {
    try {
        const task_id = req.params.task_id;
        const [rows] = await pool.execute(
            'SELECT status, app_source, bot_alias FROM transfer_request WHERE id = ?',
            [task_id]
        );
        if (!rows.length) return res.status(404).json({ success: false, error: 'task not found' });

        const cur = rows[0];
        if (cur.status !== 'PENDING') {
            return res.status(409).json({
                success: false,
                error: `Hanya task PENDING yang bisa di-cancel. Task ini status ${cur.status}.`
            });
        }

        await pool.execute(
            `UPDATE transfer_request SET status = 'FAILED', message = 'Cancelled by admin' WHERE id = ? AND status = 'PENDING'`,
            [task_id]
        );
        taskOwner.delete(task_id);
        io.emit('task_completed', {
            task_id,
            status: 'FAILED',
            app_source: cur.app_source,
            message: 'Cancelled by admin'
        });
        console.log(`[${cur.app_source}] [ADMIN CANCEL] Task ${task_id} by dashboard admin`);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// GET /api/queue — pending + processing tasks
app.get('/api/queue', requireAuth, async (req, res) => {
    const appFilter = (req.query.app || 'all').toLowerCase();
    const args = [];
    let where = "WHERE status IN ('PENDING','PROCESSING')";
    if (appFilter !== 'all' && APP_SOURCES.includes(appFilter)) {
        where += ' AND app_source = ?';
        args.push(appFilter);
    }
    try {
        const [rows] = await pool.execute(
            `SELECT id, app_source, bot_alias, bank_type, dest, amount, status, created_at
             FROM transfer_request
             ${where}
             ORDER BY created_at ASC
             LIMIT 100`,
            args
        );
        res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/stats — today stats
app.get('/api/stats', requireAuth, async (req, res) => {
    try {
        const [totalRows] = await pool.execute(
            `SELECT COUNT(*) c FROM transfer_request WHERE DATE(created_at)=CURDATE()`
        );
        const [sumRows] = await pool.execute(
            `SELECT COALESCE(SUM(amount),0) s FROM transfer_request WHERE DATE(created_at)=CURDATE() AND status='SUCCESS'`
        );
        const [statusRows] = await pool.execute(
            `SELECT status, COUNT(*) c FROM transfer_request WHERE DATE(created_at)=CURDATE() GROUP BY status`
        );
        const [avgRows] = await pool.execute(
            `SELECT AVG(TIMESTAMPDIFF(SECOND, created_at, updated_at)) avg_sec
             FROM transfer_request WHERE DATE(created_at)=CURDATE() AND status='SUCCESS'`
        );

        const by_bank = {};
        for (const src of APP_SOURCES) {
            const [c] = await pool.execute(
                `SELECT COUNT(*) c FROM transfer_request WHERE DATE(created_at)=CURDATE() AND app_source=?`,
                [src]
            );
            const [s] = await pool.execute(
                `SELECT COALESCE(SUM(amount),0) s FROM transfer_request WHERE DATE(created_at)=CURDATE() AND app_source=? AND status='SUCCESS'`,
                [src]
            );
            const [ss] = await pool.execute(
                `SELECT status, COUNT(*) c FROM transfer_request WHERE DATE(created_at)=CURDATE() AND app_source=? GROUP BY status`,
                [src]
            );
            const succ = Number(ss.find(r => r.status === 'SUCCESS')?.c || 0);
            const fail = Number(ss.find(r => r.status === 'FAILED')?.c || 0);
            const total = succ + fail;
            by_bank[src] = {
                count: Number(c[0].c),
                sum: parseFloat(s[0].s),
                success_count: succ,
                failed_count: fail,
                success_rate: total > 0 ? +(succ / total).toFixed(4) : null
            };
        }

        const successCount = Number(statusRows.find(r => r.status === 'SUCCESS')?.c || 0);
        const failedCount = Number(statusRows.find(r => r.status === 'FAILED')?.c || 0);
        const totalDone = successCount + failedCount;

        res.json({
            today_count: Number(totalRows[0].c),
            today_sum: parseFloat(sumRows[0].s),
            success_count: successCount,
            failed_count: failedCount,
            success_rate: totalDone > 0 ? +(successCount / totalDone).toFixed(4) : null,
            avg_processing_sec: avgRows[0].avg_sec ? Math.round(Number(avgRows[0].avg_sec)) : null,
            by_bank
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/bots — online bot list
app.get('/api/bots', requireAuth, (req, res) => {
    const appFilter = (req.query.app || 'all').toLowerCase();
    const bots = [];
    for (const [key, sock] of botSockets.entries()) {
        const idx = key.indexOf(':');
        const app_source = key.substring(0, idx);
        const alias = key.substring(idx + 1);
        if (appFilter !== 'all' && app_source !== appFilter) continue;
        bots.push({
            alias,
            app_source,
            device_id: sock.device_id || null,
            bot_id: sock.bot_id || null,
            connected_at: sock.connected_at || null,
            online: true
        });
    }
    bots.sort((a, b) => a.alias.localeCompare(b.alias));
    res.json(bots);
});

// ==========================================================
// AUTH + UI ROUTES
// ==========================================================
app.get(['/', '/dashboard', '/history'], requireAuth, (req, res) => res.send(getUnifiedHtmlUI()));

app.get('/login', (req, res) => res.send(getLoginUI()));

// ==========================================================
// TAILSCALE NODE REGISTER (v2.1.0 — added 2026-09-29)
// UX: admin login dashboard → menu "Tailscale Register" → paste auth-id → submit
// Backend: exec `sudo docker exec headscale headscale auth register --auth-id X --user kn-fleet`
// Auth: dashboard session cookie (requireAuth middleware)
// ==========================================================

const TAILSCALE_AUTH_ID_REGEX = /^hskey-authreq-[a-zA-Z0-9_-]+$/;
const HEADSCALE_USER = 'kn-fleet';
const AUTO_ACCEPT_MAX_DURATION_MS = 60 * 60 * 1000; // 1 hour

// v2.2.0: auto-accept state (in-memory, reset on backend restart)
const autoAcceptState = {
    enabled: false,
    expires_at: null,   // ms epoch
    disable_timer: null // setTimeout handle
};

// Dedup auth-ids sudah di-handle dalam session ini (prevent race between manual + watcher)
const processedAuthIds = new Set();

// Helper: register auth-id via headscale CLI
function registerAuthId(authId, source, callback) {
    execFile('sudo', [
        '-n', 'docker', 'exec', 'headscale',
        'headscale', 'auth', 'register',
        '--auth-id', authId,
        '--user', HEADSCALE_USER
    ], { timeout: 10000 }, (err, stdout, stderr) => {
        const output = ((stdout || '') + (stderr || '')).trim();
        if (err) {
            console.error(`❌ [tailscale-register:${source}] FAILED auth-id=${authId}:`, output || err.message);
            callback({ success: false, error: output || err.message, auth_id: authId });
        } else {
            console.log(`✅ [tailscale-register:${source}] SUKSES: ${output}`);
            callback({ success: true, message: output, auth_id: authId });
        }
    });
}

app.get('/tailscale/register', requireAuth, (req, res) => res.send(getTailscaleRegisterUI()));

app.post('/tailscale/register', requireAuth, (req, res) => {
    const authId = (req.body?.auth_id || '').trim();
    if (!TAILSCALE_AUTH_ID_REGEX.test(authId)) {
        return res.status(400).json({
            success: false,
            error: 'Invalid auth-id format. Harus dimulai dgn "hskey-authreq-" diikuti [A-Za-z0-9_-].'
        });
    }
    registerAuthId(authId, 'manual', (result) => {
        processedAuthIds.add(authId);
        // Emit ke dashboard biar pending card auto-dismiss
        io.emit('tailscale:register_completed', { auth_id: authId, success: result.success });
        res.status(result.success ? 200 : 500).json(result);
    });
});

// v2.2.0: Auto-accept toggle API
app.get('/api/tailscale/auto-accept/status', requireAuth, (req, res) => {
    const now = Date.now();
    const remaining = (autoAcceptState.enabled && autoAcceptState.expires_at)
        ? Math.max(0, autoAcceptState.expires_at - now)
        : 0;
    res.json({
        enabled: autoAcceptState.enabled,
        expires_at: autoAcceptState.expires_at,
        remaining_ms: remaining,
        max_duration_ms: AUTO_ACCEPT_MAX_DURATION_MS
    });
});

app.post('/api/tailscale/auto-accept/enable', requireAuth, (req, res) => {
    if (autoAcceptState.disable_timer) clearTimeout(autoAcceptState.disable_timer);
    autoAcceptState.enabled = true;
    autoAcceptState.expires_at = Date.now() + AUTO_ACCEPT_MAX_DURATION_MS;
    autoAcceptState.disable_timer = setTimeout(() => {
        autoAcceptState.enabled = false;
        autoAcceptState.expires_at = null;
        autoAcceptState.disable_timer = null;
        console.log('⏱️ [tailscale-auto-accept] Auto-disabled after 1h');
        io.emit('tailscale:auto_accept_state', { enabled: false, expires_at: null, remaining_ms: 0 });
    }, AUTO_ACCEPT_MAX_DURATION_MS);
    console.log(`✅ [tailscale-auto-accept] ENABLED — expires ${new Date(autoAcceptState.expires_at).toISOString()}`);
    io.emit('tailscale:auto_accept_state', {
        enabled: true,
        expires_at: autoAcceptState.expires_at,
        remaining_ms: AUTO_ACCEPT_MAX_DURATION_MS
    });
    res.json({ success: true, expires_at: autoAcceptState.expires_at, remaining_ms: AUTO_ACCEPT_MAX_DURATION_MS });
});

app.post('/api/tailscale/auto-accept/disable', requireAuth, (req, res) => {
    if (autoAcceptState.disable_timer) clearTimeout(autoAcceptState.disable_timer);
    autoAcceptState.enabled = false;
    autoAcceptState.expires_at = null;
    autoAcceptState.disable_timer = null;
    console.log('🚫 [tailscale-auto-accept] DISABLED manually');
    io.emit('tailscale:auto_accept_state', { enabled: false, expires_at: null, remaining_ms: 0 });
    res.json({ success: true });
});

// v2.2.0: Log watcher — tail Headscale docker log, extract new auth-ids
const AUTH_ID_LOG_REGEX = /starting node registration using auth id: (hskey-authreq-[a-zA-Z0-9_-]+)/;
let headscaleLogWatcher = null;
let logWatcherBuffer = '';

function startHeadscaleLogWatcher() {
    console.log('👀 [tailscale-watcher] Starting Headscale log watcher...');
    headscaleLogWatcher = spawn('sudo', ['-n', 'docker', 'logs', '-f', '--tail=0', 'headscale']);

    const processData = (data) => {
        logWatcherBuffer += data.toString();
        const lines = logWatcherBuffer.split('\n');
        logWatcherBuffer = lines.pop() || ''; // Keep incomplete last line for next chunk
        for (const line of lines) {
            const match = line.match(AUTH_ID_LOG_REGEX);
            if (!match) continue;
            const authId = match[1];
            if (processedAuthIds.has(authId)) continue;
            processedAuthIds.add(authId);
            handleNewAuthId(authId);
        }
    };

    headscaleLogWatcher.stdout.on('data', processData);
    headscaleLogWatcher.stderr.on('data', processData);

    headscaleLogWatcher.on('close', (code) => {
        console.error(`⚠️ [tailscale-watcher] exited (code=${code}), restart in 5s`);
        headscaleLogWatcher = null;
        setTimeout(startHeadscaleLogWatcher, 5000);
    });

    headscaleLogWatcher.on('error', (err) => {
        console.error(`⚠️ [tailscale-watcher] error:`, err.message);
    });
}

function handleNewAuthId(authId) {
    if (autoAcceptState.enabled) {
        // Auto-register
        console.log(`🔔 [tailscale-watcher] Auto-accepting ${authId}`);
        registerAuthId(authId, 'auto', (result) => {
            io.emit('tailscale:auto_register', {
                auth_id: authId,
                success: result.success,
                message: result.message || result.error,
                timestamp: new Date().toISOString()
            });
        });
    } else {
        // Broadcast pending
        console.log(`🔔 [tailscale-watcher] Pending register (auto-accept OFF): ${authId}`);
        io.emit('tailscale:register_pending', {
            auth_id: authId,
            timestamp: new Date().toISOString()
        });
    }
}

// Start watcher after server listen (async)
setTimeout(startHeadscaleLogWatcher, 2000);

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const validUser = process.env.DASHBOARD_USER || 'admin';
    const validPass = process.env.DASHBOARD_PASS || 'admin123';
    if (username === validUser && password === validPass) {
        res.cookie('isLoggedIn', 'true', { maxAge: 4 * 60 * 60 * 1000, httpOnly: true });
        return res.json({ success: true });
    }
    res.status(401).json({ success: false, msg: 'Username atau Password salah' });
});

app.get('/logout', (req, res) => {
    res.clearCookie('isLoggedIn');
    res.redirect('/login');
});

// ==========================================================
// SOCKET.IO — BOT NAMESPACES (/brimo, /mybca, /seabank — auto dari APP_SOURCES)
// ==========================================================
function setupBotNamespace(app_source) {
    const ns = io.of(`/${app_source}`);
    ns.on('connection', (socket) => {
        console.log(`🔌 [${app_source}] Socket connected: ${socket.id}`);
        socket.app_source = app_source;

        socket.on('bot:register', async (payload) => {
            const { bot_id, alias, device_id } = payload || {};
            if (!alias) return console.log(`❌ [${app_source}] bot:register missing alias`);
            if (!bot_id) return console.log(`⚠️ [${app_source}] bot:register without bot_id`);

            const key = `${app_source}:${alias}`;
            const isReRegister = botSockets.has(key);

            socket.bot_id = bot_id;
            socket.device_id = device_id;
            socket.alias = alias;
            socket.connected_at = new Date().toISOString();

            botSockets.set(key, socket);

            if (isReRegister) {
                console.log(`🔁 [${app_source}] BOT RE-REGISTERED: ${bot_id} ${alias} (${device_id || '-'})`);
            } else {
                console.log(`🤖 [${app_source}] BOT REGISTERED: ${bot_id} ${alias} (${device_id || '-'})`);
            }
            io.emit('bot:status', { alias, app_source, device_id, online: true, connected_at: socket.connected_at });

            // Backlog dispatch — pending tasks yang belum di-execute
            try {
                const [rows] = await pool.execute(
                    `SELECT * FROM transfer_request
                     WHERE app_source = ? AND bot_alias = ? AND status = 'PENDING'
                     ORDER BY created_at ASC`,
                    [app_source, alias]
                );
                for (const task of rows) {
                    socket.emit('task:new', {
                        task_id: task.id,
                        bank_type: task.bank_type,
                        destination: task.dest,
                        amount: parseFloat(task.amount),
                        pin: task.pin,
                        alias: task.bot_alias
                    });
                    taskOwner.set(task.id, { app: app_source, alias });
                    console.log(`[${app_source}] [BACKLOG DISPATCH] ${task.id} -> ${alias}`);
                }
            } catch (e) {
                console.error(`[${app_source}] Backlog dispatch error:`, e.message);
            }
        });

        socket.on('task:ack', async ({ task_id }) => {
            try {
                await pool.execute(
                    `UPDATE transfer_request
                     SET status = 'PROCESSING', updated_at = NOW()
                     WHERE id = ? AND status = 'PENDING' AND bot_alias = ? AND app_source = ?`,
                    [task_id, socket.alias, app_source]
                );
                console.log(`[${app_source}] [ACK] ${socket.alias} accepted task ${task_id}`);
                io.emit('task_ack', { task_id, app_source, alias: socket.alias });
            } catch (e) {
                console.error(`[${app_source}] [ACK ERROR] ${task_id}`, e.message);
            }
        });

        socket.on('bot:unregister', ({ bot_id }) => {
            if (!bot_id || !socket.alias) return;
            const key = `${app_source}:${socket.alias}`;
            botSockets.delete(key);
            console.log(`👋 [${app_source}] BOT UNREGISTERED: ${bot_id} ${socket.alias}`);
            io.emit('bot:status', { alias: socket.alias, app_source, online: false });
        });

        socket.on('disconnect', async (reason) => {
            if (!socket.bot_id) return;
            const key = `${app_source}:${socket.alias}`;
            const alias = socket.alias;
            botSockets.delete(key);
            console.log(`🔴 [${app_source}] BOT DISCONNECTED: ${socket.bot_id} ${alias} | ${reason}`);
            io.emit('bot:status', { alias, app_source, online: false });

            // Fail PROCESSING task milik bot ini
            for (const [taskId, owner] of taskOwner.entries()) {
                if (owner.app === app_source && owner.alias === alias) {
                    try {
                        await pool.execute(
                            `UPDATE transfer_request SET status = 'FAILED', message = 'Bot disconnected'
                             WHERE id = ? AND status = 'PROCESSING'`,
                            [taskId]
                        );
                    } catch (_) {}
                    taskOwner.delete(taskId);
                }
            }
        });
    });
}

for (const src of APP_SOURCES) setupBotNamespace(src);

// Default namespace — dashboard clients only
io.on('connection', (socket) => {
    console.log(`🖥️ Dashboard client connected: ${socket.id}`);
    socket.on('disconnect', () => {
        console.log(`🖥️ Dashboard client disconnected: ${socket.id}`);
    });
});

// ==========================================================
// AUTO-CLEANUP INTERVAL
// ==========================================================
setInterval(async () => {
    try {
        // 1. PROCESSING > threshold → auto-fail (bot crash / hang)
        const staleSec = Math.round(PROCESSING_STALE_MS / 1000);
        const [processingStale] = await pool.execute(
            `SELECT id, app_source FROM transfer_request
             WHERE status = 'PROCESSING' AND updated_at < (NOW() - INTERVAL ${staleSec} SECOND)`
        );
        if (processingStale.length) {
            const placeholders = processingStale.map(() => '?').join(',');
            await pool.execute(
                `UPDATE transfer_request SET status = 'FAILED', message = 'Auto-reset by system -> PROCESSING > ${staleSec}s'
                 WHERE id IN (${placeholders})`,
                processingStale.map(r => r.id)
            );
            for (const r of processingStale) {
                taskOwner.delete(r.id);
                io.emit('task_completed', { task_id: r.id, status: 'FAILED', app_source: r.app_source });
            }
            console.log(`♻️ [CLEANUP] Reset ${processingStale.length} stale PROCESSING task(s)`);
        }

        // 2. PENDING > threshold (default 10 min) → auto-cancel (antisipasi tumpukan queue)
        const pendingSec = Math.round(PENDING_STALE_MS / 1000);
        const pendingMin = Math.round(pendingSec / 60);
        const [pendingStale] = await pool.execute(
            `SELECT id, app_source FROM transfer_request
             WHERE status = 'PENDING' AND created_at < (NOW() - INTERVAL ${pendingSec} SECOND)`
        );
        if (pendingStale.length) {
            const placeholders = pendingStale.map(() => '?').join(',');
            await pool.execute(
                `UPDATE transfer_request SET status = 'FAILED', message = 'Auto-cancelled: PENDING > ${pendingMin} min'
                 WHERE id IN (${placeholders})`,
                pendingStale.map(r => r.id)
            );
            for (const r of pendingStale) {
                taskOwner.delete(r.id);
                io.emit('task_completed', { task_id: r.id, status: 'FAILED', app_source: r.app_source });
            }
            console.log(`♻️ [CLEANUP] Auto-cancelled ${pendingStale.length} stale PENDING task(s) (>${pendingMin} min)`);
        }
    } catch (e) {
        console.error('[CLEANUP ERROR]', e.message);
    }
}, 60000);

// ==========================================================
// SERVER START
// ==========================================================
server.listen(PORT, () => {
    console.log('==========================================');
    console.log(`🚀 auto_transfer unified backend v2.0.0`);
    console.log(`   Port: ${PORT}`);
    console.log(`   DB: ${process.env.DB_NAME || 'auto_transfer_db_unified'}`);
    console.log(`   Namespaces: ${APP_SOURCES.map(s => `/${s}`).join(', ')}`);
    console.log(`   Validation timeout: ${VALIDATION_TIMEOUT_MS}ms`);
    console.log(`   Stale PROCESSING threshold: ${PROCESSING_STALE_MS}ms`);
    console.log(`   Stale PENDING threshold: ${PENDING_STALE_MS}ms (${Math.round(PENDING_STALE_MS/60000)} min)`);
    console.log(`   Legacy unprefixed routes: ${LEGACY_UNPREFIXED ? 'ENABLED' : 'disabled'}`);
    console.log('==========================================');
});

// ==========================================================
// HTML TEMPLATES
// ==========================================================

function getLoginUI() {
    return `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>Transfer Center · Sign in</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #f6f7fb; --shell: #ffffff; --input: #f2f5fa; --border: #e4e8f0;
    --fg: #0b1220; --fg-muted: #5a6b83;
    --brimo: #2563eb; --mybca: #f97316; --seabank: #0284c7;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #070b14; --shell: #0d1421; --input: #0d1523; --border: #223047;
      --fg: #eaf1fa; --fg-muted: #94a5be;
      --brimo: #60a5fa; --mybca: #fb923c; --seabank: #38bdf8;
      color-scheme: dark;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh;
    display: flex; align-items: center; justify-content: center;
    background: var(--bg); color: var(--fg);
    font-family: 'Inter', system-ui, sans-serif;
    padding: 20px;
  }
  .card {
    background: var(--shell);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 32px 28px;
    width: 100%; max-width: 380px;
    box-shadow: 0 12px 32px -8px rgb(11 18 32 / 0.14);
  }
  .brand {
    display: flex; align-items: center; gap: 10px;
    margin-bottom: 22px;
  }
  .brand-mark {
    width: 40px; height: 40px; border-radius: 10px;
    background: linear-gradient(135deg, var(--brimo), var(--mybca));
    display: flex; align-items: center; justify-content: center;
    color: white; font-weight: 800; font-size: 15px;
  }
  h1 { margin: 0; font-size: 20px; font-weight: 700; letter-spacing: -0.01em; }
  .sub { color: var(--fg-muted); font-size: 12px; margin-top: 3px; }
  label { display: block; font-size: 12px; font-weight: 600; margin: 14px 0 6px 0; color: var(--fg-muted); text-transform: uppercase; letter-spacing: 0.06em; }
  input[type=text], input[type=password] {
    width: 100%; padding: 10px 12px; border-radius: 8px;
    border: 1px solid var(--border); background: var(--input);
    color: var(--fg); font-family: inherit; font-size: 14px;
    outline: none; transition: border-color 0.15s;
  }
  input:focus { border-color: var(--brimo); }
  button.primary {
    width: 100%; margin-top: 20px;
    padding: 11px 16px; border-radius: 8px;
    background: var(--fg); color: var(--bg);
    border: none; font-weight: 600; font-size: 14px;
    cursor: pointer; transition: opacity 0.15s;
    font-family: inherit;
  }
  button.primary:hover { opacity: 0.9; }
  .err { color: #dc2626; font-size: 12px; margin-top: 12px; text-align: center; min-height: 16px; }
</style>
</head>
<body>
  <div class="card">
    <div class="brand">
      <div class="brand-mark">TC</div>
      <div>
        <h1>Transfer Center</h1>
        <div class="sub">Admin sign in</div>
      </div>
    </div>
    <label>Username</label>
    <input type="text" id="user" autocomplete="username" autofocus>
    <label>Password</label>
    <input type="password" id="pass" autocomplete="current-password">
    <button class="primary" id="btn" onclick="doLogin()">Sign in</button>
    <div class="err" id="err"></div>
  </div>
  <script>
    async function doLogin() {
      const u = document.getElementById('user').value;
      const p = document.getElementById('pass').value;
      const btn = document.getElementById('btn');
      const err = document.getElementById('err');
      err.textContent = '';
      btn.textContent = 'Signing in...';
      btn.disabled = true;
      try {
        const res = await fetch('/api/login', {
          method: 'POST',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ username: u, password: p })
        });
        const data = await res.json();
        if (data.success) { window.location.href = '/dashboard'; return; }
        err.textContent = data.msg || 'Login failed';
      } catch (e) {
        err.textContent = 'Network error';
      }
      btn.textContent = 'Sign in';
      btn.disabled = false;
    }
    document.querySelectorAll('input').forEach(el => {
      el.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
    });
  </script>
</body>
</html>`;
}

function getUnifiedHtmlUI() {
    return HTML_DASHBOARD;
}

// v2.1.0: Tailscale register form — admin paste auth-id → backend exec `headscale auth register`.
// Style consistent dgn getLoginUI (same tokens, same dark/light behavior).
function getTailscaleRegisterUI() {
    return `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>Tailscale Register · Transfer Center</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #f6f7fb; --shell: #ffffff; --input: #f2f5fa; --border: #e4e8f0;
    --fg: #0b1220; --fg-muted: #5a6b83;
    --brimo: #2563eb; --mybca: #f97316; --seabank: #0284c7;
    --success: #059669; --success-bg: #ecfdf5;
    --danger: #dc2626; --danger-bg: #fee2e2;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #070b14; --shell: #0d1421; --input: #0d1523; --border: #223047;
      --fg: #eaf1fa; --fg-muted: #94a5be;
      --brimo: #60a5fa; --mybca: #fb923c; --seabank: #38bdf8;
      --success: #34d399; --success-bg: rgb(5 150 105 / 0.14);
      --danger: #f87171; --danger-bg: rgb(220 38 38 / 0.14);
      color-scheme: dark;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh;
    display: flex; align-items: center; justify-content: center;
    background: var(--bg); color: var(--fg);
    font-family: 'Inter', system-ui, sans-serif;
    padding: 20px;
  }
  .card {
    background: var(--shell); border: 1px solid var(--border);
    border-radius: 16px; padding: 32px 28px;
    width: 100%; max-width: 520px;
    box-shadow: 0 12px 32px -8px rgb(11 18 32 / 0.14);
  }
  .brand { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
  .brand-mark {
    width: 40px; height: 40px; border-radius: 10px;
    background: linear-gradient(135deg, var(--brimo), var(--mybca));
    display: flex; align-items: center; justify-content: center;
    color: white; font-weight: 800; font-size: 15px;
  }
  h1 { margin: 0; font-size: 20px; font-weight: 700; letter-spacing: -0.01em; }
  .sub { color: var(--fg-muted); font-size: 12px; margin-top: 3px; }
  .desc { color: var(--fg-muted); font-size: 13px; margin: 18px 0 10px 0; line-height: 1.5; }
  code { font-family: 'JetBrains Mono', monospace; font-size: 12px; background: var(--input); padding: 2px 6px; border-radius: 4px; }
  label { display: block; font-size: 12px; font-weight: 600; margin: 14px 0 6px 0; color: var(--fg-muted); text-transform: uppercase; letter-spacing: 0.06em; }
  input[type=text] {
    width: 100%; padding: 10px 12px; border-radius: 8px;
    border: 1px solid var(--border); background: var(--input); color: var(--fg);
    font-family: 'JetBrains Mono', monospace; font-size: 13px;
    outline: none; transition: border-color 0.15s;
  }
  input:focus { border-color: var(--brimo); }
  .btn-row { display: flex; gap: 10px; margin-top: 20px; }
  button.primary {
    flex: 1; padding: 11px 16px; border-radius: 8px;
    background: var(--fg); color: var(--bg);
    border: none; font-weight: 600; font-size: 14px;
    cursor: pointer; transition: opacity 0.15s;
    font-family: inherit;
  }
  button.primary:hover { opacity: 0.9; }
  button.primary:disabled { opacity: 0.5; cursor: not-allowed; }
  button.secondary {
    padding: 11px 16px; border-radius: 8px;
    background: transparent; color: var(--fg-muted);
    border: 1px solid var(--border);
    font-weight: 500; font-size: 14px; cursor: pointer;
    font-family: inherit;
  }
  .result {
    margin-top: 18px; padding: 14px; border-radius: 8px;
    font-size: 13px; word-break: break-word;
    display: none;
  }
  .result.success { background: var(--success-bg); color: var(--success); border: 1px solid var(--success); display: block; }
  .result.error { background: var(--danger-bg); color: var(--danger); border: 1px solid var(--danger); display: block; }
  .result strong { display: block; margin-bottom: 4px; font-size: 14px; }
</style>
</head>
<body>
  <div class="card">
    <div class="brand">
      <div class="brand-mark">TS</div>
      <div>
        <h1>Tailscale Node Register</h1>
        <div class="sub">Registrasi HP/RDP baru ke VPN mesh</div>
      </div>
    </div>
    <div class="desc">
      Setelah client tap <strong>Sign in</strong> di Tailscale app + Chrome buka page Headscale, catat <strong>auth-id</strong> (bagian setelah <code>/register/</code> di URL, contoh: <code>hskey-authreq-XXXXX</code>) → paste di sini → klik <strong>Register</strong>.
    </div>
    <label for="auth-id">Auth ID dari Tailscale client</label>
    <input type="text" id="auth-id" placeholder="hskey-authreq-..." autofocus autocomplete="off">
    <div class="btn-row">
      <button class="secondary" onclick="window.location.href='/dashboard'">← Dashboard</button>
      <button class="primary" id="btn-register" onclick="doRegister()">Register Node</button>
    </div>
    <div class="result" id="result"></div>
  </div>
  <script>
    async function doRegister() {
      const authId = document.getElementById('auth-id').value.trim();
      const btn = document.getElementById('btn-register');
      const result = document.getElementById('result');
      result.style.display = 'none';
      if (!authId) { showResult('error', 'Auth ID wajib diisi.'); return; }
      if (!/^hskey-authreq-[a-zA-Z0-9_-]+$/.test(authId)) {
        showResult('error', 'Format auth-id tidak valid. Harus mulai dgn "hskey-authreq-" diikuti [A-Za-z0-9_-].');
        return;
      }
      btn.disabled = true; btn.textContent = 'Registering...';
      try {
        const res = await fetch('/tailscale/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ auth_id: authId })
        });
        const data = await res.json();
        if (data.success) {
          showResult('success', '<strong>✅ Register sukses.</strong>' + (data.message ? '<br><code>' + escapeHtml(data.message) + '</code>' : ''));
          document.getElementById('auth-id').value = '';
        } else {
          showResult('error', '<strong>❌ Register gagal.</strong><br>' + escapeHtml(data.error || 'Unknown error'));
        }
      } catch (e) {
        showResult('error', '<strong>❌ Network error.</strong><br>' + escapeHtml(e.message));
      }
      btn.disabled = false; btn.textContent = 'Register Node';
    }
    function showResult(kind, html) {
      const el = document.getElementById('result');
      el.className = 'result ' + kind;
      el.innerHTML = html;
    }
    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    }
    document.getElementById('auth-id').addEventListener('keydown', e => {
      if (e.key === 'Enter') doRegister();
    });
  </script>
</body>
</html>`;
}

// Dashboard HTML embedded as a single template literal for maintainability.
// Adapted from approved preview at https://claude.ai/artifact/LAAoYD9YVBNWkBJNF85joH
const HTML_DASHBOARD = `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>Transfer Command Center</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root {
    --bg-page: #f6f7fb; --bg-shell: #ffffff; --bg-surface: #fbfcfe;
    --bg-elev: #ffffff; --bg-input: #f2f5fa;
    --border: #e4e8f0; --border-strong: #d4dae5;
    --fg: #0b1220; --fg-muted: #5a6b83; --fg-subtle: #8b9aae;
    --brimo: #2563eb; --brimo-bg: #eff5ff; --brimo-strong: #1d4ed8;
    --mybca: #f97316; --mybca-bg: #fff4e6; --mybca-strong: #ea580c;
    --seabank: #0284c7; --seabank-bg: #e0f2fe; --seabank-strong: #0369a1;
    --success: #059669; --success-bg: #ecfdf5;
    --warning: #d97706; --warning-bg: #fef3c7;
    --danger: #dc2626; --danger-bg: #fee2e2;
    --pending: #eab308; --pending-bg: #fef9c3;
    --info: #0891b2;
    --shadow-sm: 0 1px 2px rgb(11 18 32 / 0.05);
    --shadow-md: 0 4px 12px -2px rgb(11 18 32 / 0.08);
    --shadow-lg: 0 12px 32px -8px rgb(11 18 32 / 0.14);
    --radius-sm: 6px; --radius-md: 10px; --radius-lg: 14px; --radius-pill: 999px;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg-page: #070b14; --bg-shell: #0d1421; --bg-surface: #101927;
      --bg-elev: #141d2e; --bg-input: #0d1523;
      --border: #223047; --border-strong: #2d3d58;
      --fg: #eaf1fa; --fg-muted: #94a5be; --fg-subtle: #6a7a92;
      --brimo: #60a5fa; --brimo-bg: rgb(37 99 235 / 0.14); --brimo-strong: #93c5fd;
      --mybca: #fb923c; --mybca-bg: rgb(249 115 22 / 0.14); --mybca-strong: #fdba74;
      --seabank: #38bdf8; --seabank-bg: rgb(2 132 199 / 0.14); --seabank-strong: #7dd3fc;
      --success: #34d399; --success-bg: rgb(5 150 105 / 0.14);
      --warning: #fbbf24; --warning-bg: rgb(217 119 6 / 0.14);
      --danger: #f87171; --danger-bg: rgb(220 38 38 / 0.14);
      --pending: #facc15; --pending-bg: rgb(234 179 8 / 0.14);
      --info: #22d3ee;
      --shadow-sm: 0 1px 2px rgb(0 0 0 / 0.3);
      --shadow-md: 0 4px 12px -2px rgb(0 0 0 / 0.4);
      --shadow-lg: 0 12px 32px -8px rgb(0 0 0 / 0.5);
      color-scheme: dark;
    }
  }
  :root[data-theme="dark"] {
    --bg-page: #070b14; --bg-shell: #0d1421; --bg-surface: #101927;
    --bg-elev: #141d2e; --bg-input: #0d1523;
    --border: #223047; --border-strong: #2d3d58;
    --fg: #eaf1fa; --fg-muted: #94a5be; --fg-subtle: #6a7a92;
    --brimo: #60a5fa; --brimo-bg: rgb(37 99 235 / 0.14); --brimo-strong: #93c5fd;
    --mybca: #fb923c; --mybca-bg: rgb(249 115 22 / 0.14); --mybca-strong: #fdba74;
    --seabank: #38bdf8; --seabank-bg: rgb(2 132 199 / 0.14); --seabank-strong: #7dd3fc;
    --success: #34d399; --success-bg: rgb(5 150 105 / 0.14);
    --warning: #fbbf24; --warning-bg: rgb(217 119 6 / 0.14);
    --danger: #f87171; --danger-bg: rgb(220 38 38 / 0.14);
    --pending: #facc15; --pending-bg: rgb(234 179 8 / 0.14);
    --info: #22d3ee;
    --shadow-sm: 0 1px 2px rgb(0 0 0 / 0.3);
    --shadow-md: 0 4px 12px -2px rgb(0 0 0 / 0.4);
    --shadow-lg: 0 12px 32px -8px rgb(0 0 0 / 0.5);
    color-scheme: dark;
  }

  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg-page); color: var(--fg);
    font-family: 'Inter', system-ui, -apple-system, "Segoe UI", sans-serif;
    font-size: 14px; line-height: 1.5;
    -webkit-font-smoothing: antialiased;
    min-height: 100vh;
  }
  .mono { font-family: 'JetBrains Mono', 'SF Mono', ui-monospace, monospace; font-variant-numeric: tabular-nums; }
  .num-tab { font-variant-numeric: tabular-nums; }

  .app { display: grid; grid-template-columns: 260px 1fr; min-height: 100vh; }

  .sidebar {
    background: var(--bg-shell); border-right: 1px solid var(--border);
    padding: 20px 16px;
    display: flex; flex-direction: column; gap: 18px;
    position: sticky; top: 0; height: 100vh; overflow-y: auto;
  }
  .brand { display: flex; align-items: center; gap: 10px; padding: 6px 4px 14px 4px; border-bottom: 1px solid var(--border); }
  .brand-mark {
    width: 34px; height: 34px; border-radius: 9px;
    background: linear-gradient(135deg, var(--brimo), var(--mybca));
    display: flex; align-items: center; justify-content: center;
    color: white; font-weight: 800; font-size: 14px;
    box-shadow: var(--shadow-sm);
  }
  .brand-title { display: flex; flex-direction: column; line-height: 1.1; }
  .brand-title .name { font-weight: 700; font-size: 14px; letter-spacing: -0.01em; }
  .brand-title .sub { color: var(--fg-subtle); font-size: 11px; margin-top: 2px; }

  .sidebar-section-label {
    text-transform: uppercase; letter-spacing: 0.08em;
    font-size: 10px; color: var(--fg-subtle); font-weight: 600;
    padding: 0 4px; margin-bottom: -6px;
    display: flex; justify-content: space-between;
  }
  .bot-list { display: flex; flex-direction: column; gap: 4px; }
  .bot-item {
    display: grid; grid-template-columns: 8px 1fr auto;
    gap: 10px; align-items: center;
    padding: 9px 10px; border-radius: var(--radius-sm);
    transition: background 0.12s; cursor: pointer;
  }
  .bot-item:hover { background: var(--bg-input); }
  .bot-dot { width: 8px; height: 8px; border-radius: 50%; }
  .bot-dot.online { background: var(--success); box-shadow: 0 0 0 3px color-mix(in oklab, var(--success) 25%, transparent); }
  .bot-dot.offline { background: var(--fg-subtle); opacity: 0.5; }
  .bot-meta { display: flex; flex-direction: column; line-height: 1.2; overflow: hidden; }
  .bot-name { font-weight: 600; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bot-info { font-size: 11px; color: var(--fg-subtle); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bot-bank { font-size: 9px; text-transform: uppercase; letter-spacing: 0.06em; padding: 2px 6px; border-radius: 4px; font-weight: 700; }
  .bot-bank.brimo { color: var(--brimo-strong); background: var(--brimo-bg); }
  .bot-bank.mybca { color: var(--mybca-strong); background: var(--mybca-bg); }
  .bot-bank.seabank { color: var(--seabank-strong); background: var(--seabank-bg); }

  .sidebar-footer {
    margin-top: auto; padding-top: 14px; border-top: 1px solid var(--border);
    display: flex; align-items: center; gap: 10px;
    font-size: 12px; color: var(--fg-muted);
  }
  .user-avatar {
    width: 28px; height: 28px; border-radius: 50%;
    background: var(--fg); color: var(--bg-shell);
    display: flex; align-items: center; justify-content: center;
    font-weight: 700; font-size: 11px;
  }

  main { padding: 20px 24px 40px 24px; display: flex; flex-direction: column; gap: 22px; min-width: 0; }

  .top-header { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
  .page-title h1 { margin: 0; font-size: 22px; font-weight: 700; letter-spacing: -0.015em; text-wrap: balance; }
  .page-title .subtitle { font-size: 12px; color: var(--fg-muted); margin-top: 2px; }
  .header-actions { display: flex; gap: 8px; align-items: center; }
  .icon-btn {
    background: var(--bg-elev); border: 1px solid var(--border);
    width: 36px; height: 36px; border-radius: var(--radius-sm);
    display: inline-flex; align-items: center; justify-content: center;
    cursor: pointer; color: var(--fg-muted); transition: all 0.12s;
  }
  .icon-btn:hover { color: var(--fg); border-color: var(--border-strong); background: var(--bg-input); }

  /* v2.2.0: Tailscale Auto-Accept toggle di header */
  .ts-toggle {
    display: inline-flex; align-items: center; gap: 8px;
    padding: 8px 12px; border-radius: var(--radius-sm);
    background: var(--bg-elev); border: 1px solid var(--border);
    color: var(--fg-muted); cursor: pointer;
    font-family: inherit; font-size: 12px; font-weight: 600;
    transition: all 0.15s;
  }
  .ts-toggle:hover { border-color: var(--border-strong); background: var(--bg-input); }
  .ts-toggle.on {
    color: #a855f7; border-color: #a855f7;
    background: color-mix(in oklab, #a855f7 12%, transparent);
  }
  .ts-toggle-dot {
    width: 8px; height: 8px; border-radius: 50%;
    background: var(--fg-subtle); flex-shrink: 0;
  }
  .ts-toggle.on .ts-toggle-dot {
    background: #a855f7;
    box-shadow: 0 0 0 3px color-mix(in oklab, #a855f7 25%, transparent);
    animation: ts-pulse 2s infinite;
  }
  @keyframes ts-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }

  /* v2.2.0: Section Tailscale Pending Register — violet accent untuk distinguish */
  .ts-pending-section { display: none; }
  .ts-pending-section.has-items { display: block; }
  .ts-pending-section .section-header h3 { color: #a855f7; }
  .ts-pending-grid {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
    gap: 14px; padding: 16px;
  }
  .ts-card {
    background: var(--bg-elev); border: 1px solid var(--border);
    border-left: 3px solid #a855f7;
    border-radius: var(--radius-md); overflow: hidden;
    padding: 14px;
    display: flex; flex-direction: column; gap: 12px;
    animation: ts-slide-in 0.3s ease-out;
  }
  @keyframes ts-slide-in {
    from { opacity: 0; transform: translateY(-8px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .ts-card-head {
    display: flex; justify-content: space-between; align-items: center;
  }
  .ts-card-title {
    font-size: 12px; font-weight: 700; color: #a855f7;
    text-transform: uppercase; letter-spacing: 0.05em;
    display: inline-flex; align-items: center; gap: 6px;
  }
  .ts-card-time { font-size: 11px; color: var(--fg-subtle); font-family: 'JetBrains Mono', monospace; }
  .ts-card-authid {
    background: var(--bg-input); padding: 8px 10px; border-radius: 6px;
    font-family: 'JetBrains Mono', monospace; font-size: 11px;
    color: var(--fg); word-break: break-all; line-height: 1.35;
  }
  .ts-card-actions { display: flex; gap: 8px; }
  .btn-ts-accept {
    flex: 1; padding: 8px 14px; border-radius: 6px;
    background: #a855f7; color: white;
    border: 1px solid #a855f7; font-weight: 600; font-size: 13px;
    cursor: pointer; transition: filter 0.15s;
    font-family: inherit;
    display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  }
  .btn-ts-accept:hover { filter: brightness(1.05); }
  .btn-ts-accept:disabled { opacity: 0.6; cursor: not-allowed; }

  .stats-grid { display: grid; grid-template-columns: repeat(4, minmax(0,1fr)); gap: 14px; }
  .stat-card {
    background: var(--bg-elev); border: 1px solid var(--border);
    border-radius: var(--radius-md); padding: 16px 18px;
    display: flex; flex-direction: column; gap: 8px;
    position: relative; overflow: hidden;
  }
  .stat-card::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 2px; background: var(--accent, var(--brimo)); opacity: 0.7; }
  .stat-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.07em; color: var(--fg-subtle); font-weight: 600; display: flex; align-items: center; gap: 6px; }
  .stat-value { font-size: 26px; font-weight: 700; letter-spacing: -0.02em; line-height: 1; font-variant-numeric: tabular-nums; }
  .stat-value.small { font-size: 20px; }
  .stat-value .unit { font-size: 12px; font-weight: 500; color: var(--fg-subtle); margin-left: 6px; }
  .stat-delta { font-size: 11px; color: var(--fg-subtle); display: flex; align-items: center; gap: 6px; font-weight: 500; }

  .tabs-wrap { display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap; border-bottom: 1px solid var(--border); }
  .tabs { display: flex; gap: 4px; }
  .tab {
    background: transparent; border: none;
    padding: 12px 14px 14px 14px;
    display: flex; align-items: center; gap: 8px;
    color: var(--fg-muted); font-family: inherit; font-size: 13px; font-weight: 600;
    cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -1px;
    transition: color 0.12s; position: relative;
  }
  .tab:hover { color: var(--fg); }
  .tab.active { color: var(--fg); border-bottom-color: var(--tab-accent, var(--fg)); }
  .tab[data-tab="brimo"] { --tab-accent: var(--brimo); }
  .tab[data-tab="mybca"] { --tab-accent: var(--mybca); }
  .tab[data-tab="seabank"] { --tab-accent: var(--seabank); }
  .tab[data-tab="brimo"].active { color: var(--brimo-strong); }
  .tab[data-tab="mybca"].active { color: var(--mybca-strong); }
  .tab[data-tab="seabank"].active { color: var(--seabank-strong); }
  .tab-notif {
    display: inline-flex; align-items: center; justify-content: center;
    min-width: 20px; height: 20px; padding: 0 6px;
    border-radius: var(--radius-pill);
    background: var(--fg-subtle); color: var(--bg-page);
    font-size: 11px; font-weight: 700; font-variant-numeric: tabular-nums;
    transition: transform 0.2s, background 0.2s;
  }
  .tab[data-tab="brimo"] .tab-notif { background: var(--brimo); color: white; }
  .tab[data-tab="mybca"] .tab-notif { background: var(--mybca); color: white; }
  .tab[data-tab="seabank"] .tab-notif { background: var(--seabank); color: white; }
  .tab-notif.pulse { animation: pulse 1.4s ease-out; }
  @keyframes pulse {
    0% { transform: scale(1); }
    50% { transform: scale(1.25); }
    100% { transform: scale(1); }
  }
  .tab-notif[data-count="0"] { display: none; }

  .tabs-tools { display: flex; align-items: center; gap: 10px; padding: 8px 0; }
  .status-pill {
    display: inline-flex; align-items: center; gap: 6px;
    background: var(--bg-input); padding: 5px 10px; border-radius: var(--radius-pill);
    font-size: 11px; color: var(--fg-muted); font-weight: 500;
  }
  .status-pill .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--danger); }
  .status-pill.online .dot { background: var(--success); box-shadow: 0 0 0 3px color-mix(in oklab, var(--success) 25%, transparent); animation: ping 2s infinite; }
  @keyframes ping { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }

  .section { background: var(--bg-shell); border: 1px solid var(--border); border-radius: var(--radius-lg); overflow: hidden; }
  .section-header { padding: 14px 18px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--border); gap: 12px; }
  .section-header h3 { margin: 0; font-size: 14px; font-weight: 600; display: flex; align-items: center; gap: 10px; }
  .section-header .count-chip { background: var(--bg-input); color: var(--fg-muted); padding: 2px 8px; border-radius: var(--radius-pill); font-size: 11px; font-weight: 700; }

  .queue-list { display: flex; flex-direction: column; }
  .queue-row {
    display: grid; grid-template-columns: 6px 100px 1fr auto auto 110px 32px;
    gap: 14px; align-items: center; padding: 12px 18px;
    border-top: 1px solid var(--border); font-size: 13px;
    transition: background 0.12s;
  }
  .queue-delete {
    background: transparent; border: 1px solid transparent;
    color: var(--fg-subtle); width: 28px; height: 28px;
    border-radius: 6px; cursor: pointer;
    display: inline-flex; align-items: center; justify-content: center;
    transition: all 0.12s;
    padding: 0;
  }
  .queue-row[data-status="PROCESSING"] .queue-delete { visibility: hidden; pointer-events: none; }
  .queue-delete:hover { color: var(--danger); background: var(--danger-bg); border-color: color-mix(in oklab, var(--danger) 30%, transparent); }
  .queue-delete svg { width: 14px; height: 14px; }
  .queue-list .queue-row:first-child { border-top: none; }
  .queue-row:hover { background: var(--bg-surface); }
  .queue-status-bar { width: 3px; height: 24px; border-radius: 2px; background: var(--pending); }
  .queue-row[data-status="PROCESSING"] .queue-status-bar { background: var(--info); animation: pulse-slow 1.5s ease-in-out infinite; }
  @keyframes pulse-slow { 50% { opacity: 0.5; } }
  .queue-id { font-family: 'JetBrains Mono', monospace; font-size: 12px; color: var(--fg-muted); font-weight: 600; }
  .queue-detail { display: flex; flex-direction: column; line-height: 1.35; overflow: hidden; }
  .queue-detail .primary { font-weight: 600; }
  .queue-detail .secondary { font-size: 11px; color: var(--fg-subtle); font-family: 'JetBrains Mono', monospace; }
  .queue-amount { font-weight: 700; font-variant-numeric: tabular-nums; }
  .empty { padding: 40px 20px; text-align: center; color: var(--fg-subtle); font-size: 13px; }
  .empty .emoji { font-size: 28px; opacity: 0.5; display: block; margin-bottom: 10px; }

  .bank-badge {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 3px 9px 3px 8px; border-radius: var(--radius-pill);
    font-size: 11px; font-weight: 700; letter-spacing: 0.02em;
  }
  .bank-badge::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
  .bank-badge.brimo { color: var(--brimo-strong); background: var(--brimo-bg); }
  .bank-badge.mybca { color: var(--mybca-strong); background: var(--mybca-bg); }
  .bank-badge.seabank { color: var(--seabank-strong); background: var(--seabank-bg); }
  .status-chip {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 3px 9px; border-radius: var(--radius-pill);
    font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em;
  }
  .status-chip.PENDING { color: var(--pending); background: var(--pending-bg); }
  .status-chip.PROCESSING { color: var(--info); background: color-mix(in oklab, var(--info) 15%, transparent); }
  .status-chip.SUCCESS { color: var(--success); background: var(--success-bg); }
  .status-chip.FAILED { color: var(--danger); background: var(--danger-bg); }
  .status-cell { display: flex; flex-direction: column; gap: 4px; align-items: flex-start; min-width: 160px; }
  .status-message {
    font-size: 11px; color: var(--fg-muted); line-height: 1.35;
    max-width: 240px;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
    overflow: hidden; word-break: break-word;
  }
  .status-message.empty { font-style: italic; opacity: 0.7; }

  .val-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 14px; padding: 16px; }
  .val-card {
    background: var(--bg-elev); border: 1px solid var(--border);
    border-radius: var(--radius-md); overflow: hidden;
    display: flex; flex-direction: column;
    transition: transform 0.15s, box-shadow 0.15s, border-color 0.15s;
    position: relative;
  }
  .val-card:hover { border-color: var(--border-strong); box-shadow: var(--shadow-md); transform: translateY(-1px); }
  .val-card::before { content: ''; position: absolute; top: 0; left: 0; bottom: 0; width: 3px; background: var(--brimo); }
  .val-card.brimo::before { background: var(--brimo); }
  .val-card.mybca::before { background: var(--mybca); }
  .val-card.seabank::before { background: var(--seabank); }
  .val-card-head { padding: 12px 14px 10px 14px; display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  .val-tx-id { font-family: 'JetBrains Mono', monospace; font-size: 11px; color: var(--fg-muted); font-weight: 600; }
  .val-time { font-size: 11px; color: var(--fg-subtle); display: flex; align-items: center; gap: 5px; }
  .val-time .countdown { color: var(--warning); font-weight: 700; font-family: 'JetBrains Mono', monospace; font-variant-numeric: tabular-nums; }
  .val-body { padding: 4px 14px 14px 14px; display: flex; flex-direction: column; gap: 10px; }
  .val-recipient { display: flex; align-items: center; gap: 10px; padding: 10px; background: var(--bg-input); border-radius: var(--radius-sm); }
  .val-avatar {
    width: 38px; height: 38px; border-radius: 8px;
    color: white; display: flex; align-items: center; justify-content: center;
    font-weight: 700; font-size: 12px; flex-shrink: 0;
  }
  .val-card.brimo .val-avatar { background: var(--brimo); }
  .val-card.mybca .val-avatar { background: var(--mybca); }
  .val-card.seabank .val-avatar { background: var(--seabank); }
  .val-name-block { display: flex; flex-direction: column; line-height: 1.2; overflow: hidden; min-width: 0; }
  .val-name { font-weight: 600; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .val-rek { font-family: 'JetBrains Mono', monospace; font-size: 11px; color: var(--fg-muted); }
  .val-figures { display: grid; grid-template-columns: 1fr 1fr 1fr; border: 1px solid var(--border); border-radius: var(--radius-sm); overflow: hidden; }
  .val-figures > div { padding: 8px 10px; border-right: 1px solid var(--border); }
  .val-figures > div:last-child { border-right: none; }
  .val-fig-label { font-size: 10px; color: var(--fg-subtle); text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; margin-bottom: 3px; }
  .val-fig-value { font-weight: 700; font-size: 13px; font-variant-numeric: tabular-nums; }
  .val-card.brimo .val-fig-value.total { color: var(--brimo-strong); }
  .val-card.mybca .val-fig-value.total { color: var(--mybca-strong); }
  .val-card.seabank .val-fig-value.total { color: var(--seabank-strong); }
  .val-meta { display: flex; gap: 6px; flex-wrap: wrap; font-size: 11px; color: var(--fg-subtle); }
  .val-actions { padding: 10px 14px; background: var(--bg-input); display: flex; gap: 8px; justify-content: flex-end; border-top: 1px solid var(--border); }
  .btn {
    font-family: inherit; font-size: 13px; font-weight: 600;
    border: 1px solid var(--border-strong); background: var(--bg-elev); color: var(--fg);
    padding: 7px 14px; border-radius: 6px; cursor: pointer; transition: all 0.15s;
    display: inline-flex; align-items: center; gap: 6px;
  }
  .btn:hover { background: var(--bg-input); }
  .btn.small { padding: 5px 10px; font-size: 12px; }
  .btn.success { background: var(--success); color: white; border-color: var(--success); }
  .btn.success:hover { filter: brightness(1.05); }
  .btn.danger { background: var(--danger); color: white; border-color: var(--danger); }
  .btn.danger:hover { filter: brightness(1.05); }
  .btn.ghost { background: transparent; border-color: transparent; color: var(--fg-muted); }
  .btn.ghost:hover { color: var(--fg); background: var(--bg-input); }

  .filter-bar { padding: 14px 18px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; border-bottom: 1px solid var(--border); background: var(--bg-surface); }
  .search-box { flex: 1; min-width: 200px; position: relative; }
  .search-box input {
    width: 100%; background: var(--bg-elev);
    border: 1px solid var(--border); color: var(--fg);
    padding: 8px 12px 8px 34px; border-radius: var(--radius-sm);
    font-family: inherit; font-size: 13px; outline: none;
  }
  .search-box input:focus { border-color: var(--brimo); }
  .search-box svg { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); color: var(--fg-subtle); width: 15px; height: 15px; }
  .filter-select {
    background: var(--bg-elev); border: 1px solid var(--border); color: var(--fg);
    padding: 7px 26px 7px 12px; border-radius: var(--radius-sm);
    font-family: inherit; font-size: 13px; cursor: pointer;
    appearance: none;
    background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20' fill='%2394a5be'><path d='M5.23 7.21a.75.75 0 011.06.02L10 11.06l3.71-3.83a.75.75 0 011.08 1.04l-4.25 4.4a.75.75 0 01-1.08 0l-4.25-4.4a.75.75 0 01.02-1.06z'/></svg>");
    background-repeat: no-repeat; background-position: right 6px center; background-size: 18px;
  }
  .history-table-wrap { overflow-x: auto; }
  table.history { width: 100%; border-collapse: collapse; font-size: 13px; }
  table.history th, table.history td { text-align: left; padding: 10px 14px; border-bottom: 1px solid var(--border); }
  table.history th { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--fg-subtle); font-weight: 600; background: var(--bg-surface); position: sticky; top: 0; }
  table.history tbody tr:hover { background: var(--bg-surface); }
  table.history tbody tr:last-child td { border-bottom: none; }
  table.history .col-tx { font-family: 'JetBrains Mono', monospace; font-size: 12px; color: var(--fg-muted); font-weight: 600; }
  table.history .col-amount { font-weight: 700; font-variant-numeric: tabular-nums; }
  table.history .col-time { color: var(--fg-muted); font-size: 12px; font-family: 'JetBrains Mono', monospace; white-space: nowrap; }
  table.history .col-ref { font-family: 'JetBrains Mono', monospace; font-size: 12px; }

  #toast-container { position: fixed; bottom: 20px; right: 20px; display: flex; flex-direction: column; gap: 10px; z-index: 1000; max-width: 340px; }
  .toast {
    background: var(--bg-elev); border: 1px solid var(--border);
    border-left: 3px solid var(--info); border-radius: var(--radius-md);
    padding: 12px 14px; box-shadow: var(--shadow-lg);
    animation: toast-in 0.25s ease-out; font-size: 13px;
    display: flex; align-items: center; gap: 10px;
  }
  .toast.success { border-left-color: var(--success); }
  .toast.danger { border-left-color: var(--danger); }
  @keyframes toast-in { from { opacity: 0; transform: translateX(20px); } to { opacity: 1; transform: translateX(0); } }

  @media (max-width: 900px) {
    .app { grid-template-columns: 1fr; }
    .sidebar { position: static; height: auto; border-right: none; border-bottom: 1px solid var(--border); }
    .stats-grid { grid-template-columns: repeat(2, 1fr); }
    .queue-row { grid-template-columns: 6px 1fr auto 32px; gap: 8px; }
    .queue-row .queue-id, .queue-row .bank-badge { display: none; }
  }
  @media (max-width: 500px) {
    main { padding: 16px; }
    .stats-grid { gap: 10px; }
    .stat-card { padding: 12px 14px; }
    .stat-value { font-size: 22px; }
    .val-grid { grid-template-columns: 1fr; padding: 12px; }
  }
</style>
</head>
<body>
<div class="app">

  <aside class="sidebar">
    <div class="brand">
      <div class="brand-mark">TC</div>
      <div class="brand-title">
        <div class="name">Transfer Center</div>
        <div class="sub">v2.0 · unified</div>
      </div>
    </div>

    <div class="sidebar-section-label">
      <span>Bot Fleet</span>
      <span id="bot-online-count" class="mono">0 online</span>
    </div>
    <div class="bot-list" id="bot-list">
      <div class="empty" style="padding: 12px 6px; font-size: 12px;">Memuat…</div>
    </div>

    <div class="sidebar-footer">
      <div class="user-avatar">A</div>
      <div>
        <div style="color: var(--fg); font-weight: 600; font-size: 12px;">admin</div>
        <div style="font-size: 10px;" id="session-time">signed in</div>
      </div>
      <button class="icon-btn" style="margin-left: auto; width: 28px; height: 28px;" title="Sign out" onclick="handleLogout()">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/></svg>
      </button>
    </div>
  </aside>

  <main>
    <div class="top-header">
      <div class="page-title">
        <h1>Command Center</h1>
        <div class="subtitle">Kelola validasi transfer BRImo, myBCA, dan SeaBank di satu tempat</div>
      </div>
      <div class="header-actions">
        <button class="icon-btn" onclick="toggleTheme()" title="Toggle theme">
          <svg id="theme-icon" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>
        </button>
        <button class="icon-btn" onclick="refreshAll()" title="Refresh">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>
        </button>
        <button class="icon-btn" onclick="window.location.href='/tailscale/register'" title="Tailscale Register (add HP/RDP baru ke VPN)">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s-8-4.5-8-11.8A8 8 0 0 1 12 2a8 8 0 0 1 8 8.2c0 7.3-8 11.8-8 11.8z"/><circle cx="12" cy="10" r="3"/></svg>
        </button>
        <button class="ts-toggle" id="ts-toggle" onclick="toggleAutoAccept()" title="Toggle Tailscale Auto-Accept (max 1 jam)">
          <span class="ts-toggle-dot" id="ts-toggle-dot"></span>
          <span class="ts-toggle-text" id="ts-toggle-text">Auto-Accept: OFF</span>
        </button>
      </div>
    </div>

    <div class="stats-grid">
      <div class="stat-card" style="--accent: var(--brimo);">
        <div class="stat-label">Transaksi hari ini</div>
        <div class="stat-value num-tab" id="stat-count">—</div>
        <div class="stat-delta" id="stat-count-sub">memuat…</div>
      </div>
      <div class="stat-card" style="--accent: var(--success);">
        <div class="stat-label">Nilai hari ini</div>
        <div class="stat-value small num-tab" id="stat-sum">—</div>
        <div class="stat-delta" id="stat-sum-sub">memuat…</div>
      </div>
      <div class="stat-card" style="--accent: var(--mybca);">
        <div class="stat-label">Success rate</div>
        <div class="stat-value num-tab" id="stat-rate">—</div>
        <div class="stat-delta" id="stat-rate-sub">memuat…</div>
      </div>
      <div class="stat-card" style="--accent: var(--info);">
        <div class="stat-label">Avg processing</div>
        <div class="stat-value num-tab" id="stat-avg">—</div>
        <div class="stat-delta" id="stat-avg-sub">memuat…</div>
      </div>
    </div>

    <div class="tabs-wrap">
      <div class="tabs">
        <button class="tab active" data-tab="all" onclick="switchTab('all')">Semua <span class="tab-notif" data-count="0">0</span></button>
        <button class="tab" data-tab="brimo" onclick="switchTab('brimo')">BRImo <span class="tab-notif" data-count="0">0</span></button>
        <button class="tab" data-tab="mybca" onclick="switchTab('mybca')">myBCA <span class="tab-notif" data-count="0">0</span></button>
        <button class="tab" data-tab="seabank" onclick="switchTab('seabank')">SeaBank <span class="tab-notif" data-count="0">0</span></button>
      </div>
      <div class="tabs-tools">
        <div class="status-pill" id="socket-status">
          <span class="dot"></span>
          <span id="socket-status-label">Connecting…</span>
        </div>
      </div>
    </div>

    <!-- v2.2.0: Tailscale Pending Register — muncul saat ada request + auto-accept OFF -->
    <section class="section ts-pending-section" id="ts-pending-section">
      <div class="section-header">
        <h3>
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s-8-4.5-8-11.8A8 8 0 0 1 12 2a8 8 0 0 1 8 8.2c0 7.3-8 11.8-8 11.8z"/><circle cx="12" cy="10" r="3"/></svg>
          Tailscale — Permintaan Register
          <span class="count-chip" id="ts-pending-count">0</span>
        </h3>
        <div class="section-actions">
          <span style="font-size: 11px; color: var(--fg-muted);">Auto-accept OFF · perlu approval admin</span>
        </div>
      </div>
      <div class="ts-pending-grid" id="ts-pending-grid"></div>
    </section>

    <section class="section">
      <div class="section-header">
        <h3>Antrian transfer <span class="count-chip" id="queue-count">0</span></h3>
      </div>
      <div class="queue-list" id="queue-list">
        <div class="empty"><span class="emoji">📥</span>Belum ada antrian</div>
      </div>
    </section>

    <section class="section">
      <div class="section-header">
        <h3>Menunggu keputusan <span class="count-chip" id="val-count">0</span></h3>
      </div>
      <div class="val-grid" id="val-grid">
        <div class="empty" style="grid-column: 1/-1;"><span class="emoji">✅</span>All caught up! Tidak ada validasi menunggu.</div>
      </div>
    </section>

    <section class="section">
      <div class="section-header">
        <h3>Riwayat transaksi</h3>
      </div>
      <div class="filter-bar">
        <div class="search-box">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
          <input type="text" id="search-input" placeholder="Cari ref number, rekening, nama penerima, TX ID…" oninput="onFilterChange()">
        </div>
        <select class="filter-select" id="filter-status" onchange="onFilterChange()">
          <option value="all">Semua status</option>
          <option value="SUCCESS">Success</option>
          <option value="FAILED">Failed</option>
        </select>
        <select class="filter-select" id="filter-days" onchange="onFilterChange()">
          <option value="1">Hari ini</option>
          <option value="7" selected>7 hari terakhir</option>
          <option value="30">30 hari terakhir</option>
          <option value="90">90 hari terakhir</option>
        </select>
      </div>
      <div class="history-table-wrap">
        <table class="history">
          <thead>
            <tr>
              <th>Waktu</th>
              <th>TX ID</th>
              <th>App</th>
              <th>Bot</th>
              <th>Penerima</th>
              <th>Nominal</th>
              <th>Status</th>
              <th>Ref Number</th>
            </tr>
          </thead>
          <tbody id="history-tbody">
            <tr><td colspan="8" style="text-align:center; padding: 24px; color: var(--fg-subtle);">Memuat…</td></tr>
          </tbody>
        </table>
      </div>
    </section>
  </main>
</div>

<div id="toast-container"></div>

<script src="/socket.io/socket.io.js"></script>
<script>
  // ------- State -------
  let currentTab = 'all';
  let socket;

  // ------- Theme -------
  function toggleTheme() {
    const root = document.documentElement;
    const cur = root.getAttribute('data-theme');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const next = !cur ? (prefersDark ? 'light' : 'dark') : (cur === 'dark' ? 'light' : 'dark');
    root.setAttribute('data-theme', next);
    try { localStorage.setItem('tcc-theme', next); } catch(_) {}
    updateThemeIcon();
  }
  function updateThemeIcon() {
    const theme = document.documentElement.getAttribute('data-theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const icon = document.getElementById('theme-icon');
    if (theme === 'dark') {
      icon.innerHTML = '<path d="M12 3a6.36 6.36 0 0 0 9 9 9 9 0 1 1-9-9Z"/>';
    } else {
      icon.innerHTML = '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>';
    }
  }
  try { const s = localStorage.getItem('tcc-theme'); if (s) document.documentElement.setAttribute('data-theme', s); } catch(_) {}
  updateThemeIcon();

  // ------- Utils -------
  function formatRupiah(n) {
    if (n === null || n === undefined) return 'Rp —';
    return new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(Number(n));
  }
  function formatTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
  function formatDateTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
  function initials(name) {
    if (!name) return '?';
    const parts = String(name).trim().split(/\\s+/);
    return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
  }
  // Mapping bank identity. Tambah entry baru di sini untuk support fleet baru.
  const BANK_LABELS = {
    brimo:   { label: 'BRImo',   short: 'BRI' },
    mybca:   { label: 'myBCA',   short: 'BCA' },
    seabank: { label: 'SeaBank', short: 'SeaBank' }
  };
  function bankLabel(app_source)  { return BANK_LABELS[app_source]?.label || app_source; }
  function bankShort(app_source)  { return BANK_LABELS[app_source]?.short || app_source; }
  function bankPill(app_source) {
    return \`<span class="bank-badge \${app_source}">\${bankLabel(app_source)}</span>\`;
  }
  function el(id) { return document.getElementById(id); }
  function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function displayMessage(status, message) {
    // Kalau SUCCESS, backend biasanya store JSON blob dari bot payload (ref_number, details).
    // Cek: kalau raw JSON, extract ref_number saja. Kalau text plain, tampilkan.
    if (!message) {
      return status === 'FAILED'
        ? '<div class="status-message empty">(no reason)</div>'
        : '';
    }
    let text = String(message);
    // Coba parse JSON untuk pesan bot yang dikirim as JSON string
    if (text.startsWith('{')) {
      try {
        const obj = JSON.parse(text);
        text = obj.text || obj.reason || obj.message || (obj.ref_number ? \`Ref: \${obj.ref_number}\` : text);
      } catch (_) { /* fall through, tampilkan as-is */ }
    }
    return \`<div class="status-message" title="\${escapeHtml(text)}">\${escapeHtml(text)}</div>\`;
  }

  // ------- Tabs -------
  function switchTab(tab) {
    currentTab = tab;
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelector(\`.tab[data-tab="\${tab}"]\`).classList.add('active');
    reloadSections();
  }

  // ------- Notif badges -------
  function setNotifBadge(tab, count) {
    const badge = document.querySelector(\`.tab[data-tab="\${tab}"] .tab-notif\`);
    if (!badge) return;
    const prev = parseInt(badge.dataset.count) || 0;
    badge.textContent = count;
    badge.dataset.count = count;
    if (count > prev) {
      badge.classList.remove('pulse');
      void badge.offsetWidth;
      badge.classList.add('pulse');
    }
  }

  // ------- Toast -------
  function showToast(kind, msg) {
    const c = el('toast-container');
    const t = document.createElement('div');
    t.className = 'toast ' + kind;
    const emoji = kind === 'success' ? '✅' : kind === 'danger' ? '⛔' : '🔔';
    t.innerHTML = \`<span>\${emoji}</span><span>\${msg}</span>\`;
    c.appendChild(t);
    setTimeout(() => {
      t.style.transition = 'opacity 0.3s, transform 0.3s';
      t.style.opacity = '0';
      t.style.transform = 'translateX(20px)';
      setTimeout(() => t.remove(), 300);
    }, 3800);
  }

  // ------- Load stats -------
  async function loadStats() {
    try {
      const res = await fetch('/api/stats');
      const s = await res.json();
      el('stat-count').textContent = (s.today_count ?? 0).toLocaleString('id-ID');
      el('stat-count-sub').textContent = Object.keys(BANK_LABELS)
        .map(src => \`\${bankLabel(src)} \${s.by_bank?.[src]?.count ?? 0}\`)
        .join(' · ');
      el('stat-sum').textContent = formatRupiah(s.today_sum || 0);
      el('stat-sum-sub').textContent = \`\${s.success_count ?? 0} sukses · \${s.failed_count ?? 0} gagal\`;
      el('stat-rate').innerHTML = s.success_rate === null ? '—' : \`\${(s.success_rate * 100).toFixed(1)}<span class="unit">%</span>\`;
      el('stat-rate-sub').textContent = s.today_count > 0 ? \`\${s.success_count}/\${s.success_count + s.failed_count} berhasil\` : 'belum ada transaksi';
      if (s.avg_processing_sec === null) {
        el('stat-avg').textContent = '—';
        el('stat-avg-sub').textContent = 'belum ada sukses';
      } else {
        const m = Math.floor(s.avg_processing_sec / 60);
        const sec = s.avg_processing_sec % 60;
        el('stat-avg').innerHTML = m > 0 ? \`\${m}<span class="unit">m \${sec}s</span>\` : \`\${sec}<span class="unit">s</span>\`;
        el('stat-avg-sub').textContent = 'dari task SUCCESS hari ini';
      }
    } catch (e) { console.error('loadStats', e); }
  }

  // ------- Load queue -------
  async function loadQueue() {
    try {
      const q = currentTab === 'all' ? '' : \`?app=\${currentTab}\`;
      const res = await fetch('/api/queue' + q);
      const rows = await res.json();
      const list = el('queue-list');
      if (!rows.length) {
        list.innerHTML = '<div class="empty"><span class="emoji">📥</span>Belum ada antrian</div>';
      } else {
        list.innerHTML = rows.map(r => \`
          <div class="queue-row" data-status="\${r.status}" data-bank="\${r.app_source}" data-id="\${r.id}">
            <div class="queue-status-bar"></div>
            <div class="queue-id">\${r.id}</div>
            <div class="queue-detail">
              <div class="primary">\${r.bot_alias || '—'}</div>
              <div class="secondary">\${r.dest || '—'} · \${(r.bank_type || '').toUpperCase()}</div>
            </div>
            \${bankPill(r.app_source)}
            <span class="queue-amount">\${formatRupiah(r.amount)}</span>
            <span class="status-chip \${r.status}">\${r.status}</span>
            <button class="queue-delete" onclick="cancelTask('\${r.id}')" title="Batalkan queue (hanya PENDING)">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>
            </button>
          </div>
        \`).join('');
      }
      el('queue-count').textContent = \`\${rows.length} aktif\`;
    } catch (e) { console.error('loadQueue', e); }
  }

  // ------- Load validations -------
  const activeCards = new Map(); // task_id → { intervalId }
  async function loadValidations() {
    try {
      // Load all first, then compute per-app counts for badges
      const res = await fetch('/api/pending-validations');
      const rows = await res.json();
      const filtered = currentTab === 'all' ? rows : rows.filter(r => r.app_source === currentTab);
      const grid = el('val-grid');
      if (!filtered.length) {
        grid.innerHTML = '<div class="empty" style="grid-column: 1/-1;"><span class="emoji">✅</span>All caught up! Tidak ada validasi menunggu.</div>';
      } else {
        grid.innerHTML = filtered.map(r => renderValCard(r)).join('');
        filtered.forEach(r => startCountdown(r.task_id, r.created_at));
      }
      el('val-count').textContent = \`\${filtered.length} perlu aksi\`;
      // Notif badges (semua data, bukan filtered) — dynamic per bank di BANK_LABELS
      let totalN = 0;
      for (const src of Object.keys(BANK_LABELS)) {
        const n = rows.filter(r => r.app_source === src).length;
        setNotifBadge(src, n);
        totalN += n;
      }
      setNotifBadge('all', totalN);
    } catch (e) { console.error('loadValidations', e); }
  }

  function renderValCard(r) {
    const label = bankLabel(r.app_source);
    const nameShort = r.target_name_extracted || '—';
    const rek = r.target_rek_extracted || '—';
    return \`
      <div class="val-card \${r.app_source}" data-bank="\${r.app_source}" data-id="\${r.task_id}">
        <div class="val-card-head">
          <div>
            <span class="val-tx-id">\${r.task_id}</span>
            <span class="bank-badge \${r.app_source}" style="margin-left: 6px;">\${label}</span>
          </div>
          <div class="val-time">
            expires in <span class="countdown" id="cd-\${r.task_id}">--:--</span>
          </div>
        </div>
        <div class="val-body">
          <div class="val-recipient">
            <div class="val-avatar">\${initials(nameShort)}</div>
            <div class="val-name-block">
              <div class="val-name">\${nameShort}</div>
              <div class="val-rek">\${rek} · \${r.bank_name || '—'}</div>
            </div>
          </div>
          <div class="val-figures">
            <div>
              <div class="val-fig-label">Original</div>
              <div class="val-fig-value">\${formatRupiah(r.original_amount)}</div>
            </div>
            <div>
              <div class="val-fig-label">Fee</div>
              <div class="val-fig-value">\${formatRupiah(Number(r.total_amount) - Number(r.original_amount))}</div>
            </div>
            <div>
              <div class="val-fig-label">Total</div>
              <div class="val-fig-value total">\${formatRupiah(r.total_amount)}</div>
            </div>
          </div>
          <div class="val-meta">
            <span>Bot: <strong style="color: var(--fg);">\${r.bot_alias || r.account_name}</strong></span>
            <span>· \${r.device_id || '—'}</span>
          </div>
        </div>
        <div class="val-actions">
          <button class="btn danger small" onclick="decide('\${r.task_id}','ABORT')">REJECT</button>
          <button class="btn success small" onclick="decide('\${r.task_id}','PROCEED')">ACCEPT</button>
        </div>
      </div>
    \`;
  }

  function startCountdown(task_id, createdIso) {
    if (activeCards.has(task_id)) {
      clearInterval(activeCards.get(task_id).intervalId);
    }
    const startMs = createdIso ? new Date(createdIso).getTime() : Date.now();
    const expiresMs = startMs + 60000;
    function tick() {
      const remaining = Math.max(0, Math.round((expiresMs - Date.now()) / 1000));
      const cd = document.getElementById('cd-' + task_id);
      if (!cd) { clearInterval(intervalId); return; }
      const mm = String(Math.floor(remaining / 60)).padStart(2, '0');
      const ss = String(remaining % 60).padStart(2, '0');
      cd.textContent = \`\${mm}:\${ss}\`;
      if (remaining < 15) cd.style.color = 'var(--danger)';
      else if (remaining < 30) cd.style.color = 'var(--warning)';
      else cd.style.color = 'var(--warning)';
      if (remaining === 0) clearInterval(intervalId);
    }
    tick();
    const intervalId = setInterval(tick, 1000);
    activeCards.set(task_id, { intervalId });
  }

  async function cancelTask(task_id) {
    if (!confirm(\`Batalkan queue task \${task_id}?\\n\\nTask akan di-mark FAILED. Hanya berlaku untuk task PENDING (belum di-pickup bot).\`)) return;
    try {
      const res = await fetch('/api/queue/' + encodeURIComponent(task_id), { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        showToast('success', \`Queue \${task_id} dibatalkan\`);
        loadQueue(); loadStats(); loadHistory();
      } else {
        showToast('danger', 'Gagal cancel: ' + (data.error || 'unknown'));
      }
    } catch (e) {
      showToast('danger', 'Network error saat cancel');
    }
  }

  async function decide(task_id, status) {
    if (!confirm(\`\${status === 'PROCEED' ? 'Terima' : 'Tolak'} transaksi \${task_id}?\`)) return;
    try {
      const res = await fetch('/update-decision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task_id, status })
      });
      const data = await res.json();
      if (data.success) {
        showToast(status === 'PROCEED' ? 'success' : 'danger', \`\${task_id} \${status === 'PROCEED' ? 'DITERIMA' : 'DITOLAK'}\`);
      } else {
        showToast('danger', 'Gagal: ' + (data.error || 'unknown'));
      }
    } catch (e) {
      showToast('danger', 'Network error');
    }
  }

  // ------- Load history -------
  async function loadHistory() {
    try {
      const app = currentTab === 'all' ? 'all' : currentTab;
      const status = el('filter-status').value;
      const days = el('filter-days').value;
      const search = el('search-input').value.trim();
      const params = new URLSearchParams({ app, status, days, limit: '100' });
      if (search) params.set('search', search);
      const res = await fetch('/api/history?' + params.toString());
      const rows = await res.json();
      const tbody = el('history-tbody');
      if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding: 24px; color: var(--fg-subtle);">Tidak ada data untuk filter ini</td></tr>';
        return;
      }
      tbody.innerHTML = rows.map(r => \`
        <tr>
          <td class="col-time">\${formatDateTime(r.updated_at)}</td>
          <td class="col-tx">\${r.id}</td>
          <td>\${bankPill(r.app_source)}</td>
          <td>\${r.bot_alias || '—'}</td>
          <td>\${r.target_name_extracted || r.dest || '—'} <span class="mono num-tab" style="color: var(--fg-subtle); font-size: 11px;">· \${r.dest || '—'}</span></td>
          <td class="col-amount">\${formatRupiah(r.amount)}</td>
          <td>
            <div class="status-cell">
              <span class="status-chip \${r.status}">\${r.status}</span>
              \${displayMessage(r.status, r.message)}
            </div>
          </td>
          <td class="col-ref">\${r.ref_number || '—'}</td>
        </tr>
      \`).join('');
    } catch (e) { console.error('loadHistory', e); }
  }

  let historyDebounce;
  function onFilterChange() {
    clearTimeout(historyDebounce);
    historyDebounce = setTimeout(loadHistory, 200);
  }

  // ------- Load bots -------
  async function loadBots() {
    try {
      const res = await fetch('/api/bots');
      const bots = await res.json();
      const list = el('bot-list');
      if (!bots.length) {
        list.innerHTML = '<div class="empty" style="padding: 12px 6px; font-size: 12px;">Belum ada bot online</div>';
      } else {
        list.innerHTML = bots.map(b => \`
          <div class="bot-item" data-alias="\${b.alias}" data-bank="\${b.app_source}">
            <div class="bot-dot \${b.online ? 'online' : 'offline'}"></div>
            <div class="bot-meta">
              <div class="bot-name">\${b.alias}</div>
              <div class="bot-info">\${b.device_id || '—'}</div>
            </div>
            <span class="bot-bank \${b.app_source}">\${bankShort(b.app_source)}</span>
          </div>
        \`).join('');
      }
      el('bot-online-count').textContent = \`\${bots.length} online\`;
    } catch (e) { console.error('loadBots', e); }
  }

  // ------- Actions -------
  function reloadSections() { loadQueue(); loadValidations(); loadHistory(); }
  async function refreshAll() { await Promise.all([loadStats(), loadBots(), loadQueue(), loadValidations(), loadHistory()]); showToast('info', 'Refreshed'); }
  function handleLogout() {
    if (!confirm('Sign out?')) return;
    window.location.href = '/logout';
  }

  // ------- Socket -------
  function setupSocket() {
    socket = io({ transports: ['websocket', 'polling'] });
    const pill = el('socket-status');
    const lbl = el('socket-status-label');
    socket.on('connect', () => {
      pill.classList.add('online');
      lbl.textContent = 'Realtime · connected';
    });
    socket.on('disconnect', () => {
      pill.classList.remove('online');
      lbl.textContent = 'Reconnecting…';
    });
    socket.on('new_validation', (data) => {
      loadValidations();
      showToast('info', \`📥 Validasi \${bankLabel(data.app_source)} baru masuk\`);
    });
    socket.on('decision_updated', () => loadValidations());
    socket.on('task_completed', () => { loadStats(); loadQueue(); loadHistory(); });
    socket.on('new_task', () => { loadQueue(); loadStats(); });
    socket.on('task_ack', () => loadQueue());
    socket.on('bot:status', () => loadBots());
    // v2.2.0: Tailscale auto-accept + pending register events
    socket.on('tailscale:auto_accept_state', (data) => renderAutoAcceptToggle(data));
    socket.on('tailscale:register_pending', (data) => { addPendingRegister(data); showToast('info', \`🛡️ Tailscale register request masuk\`); });
    socket.on('tailscale:register_completed', (data) => removePendingRegister(data.auth_id));
    socket.on('tailscale:auto_register', (data) => {
      if (data.success) showToast('success', \`🛡️ Auto-register: \${data.auth_id.slice(0, 25)}…\`);
      else showToast('danger', \`🛡️ Auto-register gagal: \${data.message}\`);
    });
  }

  // ------- v2.2.0: Tailscale Auto-Accept + Pending Register -------
  let autoAcceptCountdownTimer = null;
  const pendingRegisterAuthIds = new Set();

  async function loadAutoAcceptStatus() {
    try {
      const res = await fetch('/api/tailscale/auto-accept/status');
      const data = await res.json();
      renderAutoAcceptToggle(data);
    } catch (e) { console.error('loadAutoAcceptStatus', e); }
  }

  function renderAutoAcceptToggle(data) {
    const btn = el('ts-toggle');
    const txt = el('ts-toggle-text');
    if (autoAcceptCountdownTimer) { clearInterval(autoAcceptCountdownTimer); autoAcceptCountdownTimer = null; }
    if (data.enabled && data.expires_at) {
      btn.classList.add('on');
      const updateCountdown = () => {
        const remaining = Math.max(0, data.expires_at - Date.now());
        if (remaining === 0) {
          clearInterval(autoAcceptCountdownTimer);
          autoAcceptCountdownTimer = null;
          btn.classList.remove('on');
          txt.textContent = 'Auto-Accept: OFF';
          return;
        }
        const mins = Math.floor(remaining / 60000);
        const secs = Math.floor((remaining % 60000) / 1000);
        txt.textContent = \`Auto-Accept: ON (\${mins}m \${String(secs).padStart(2,'0')}s)\`;
      };
      updateCountdown();
      autoAcceptCountdownTimer = setInterval(updateCountdown, 1000);
    } else {
      btn.classList.remove('on');
      txt.textContent = 'Auto-Accept: OFF';
    }
  }

  async function toggleAutoAccept() {
    const btn = el('ts-toggle');
    const currentlyOn = btn.classList.contains('on');
    const url = currentlyOn ? '/api/tailscale/auto-accept/disable' : '/api/tailscale/auto-accept/enable';
    const confirmMsg = currentlyOn
      ? 'Matikan Auto-Accept Tailscale sekarang?'
      : 'Nyalakan Auto-Accept Tailscale untuk 1 jam?\\n\\nSelama mode ON, siapa saja yang tap Sign in via URL server → auto-join VPN mesh tanpa admin approval.';
    if (!confirm(confirmMsg)) return;
    try {
      const res = await fetch(url, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        showToast('success', currentlyOn ? '🛡️ Auto-Accept OFF' : '🛡️ Auto-Accept ON (1 jam)');
      } else {
        showToast('danger', 'Gagal: ' + (data.error || 'unknown'));
      }
    } catch (e) {
      showToast('danger', 'Network error');
    }
  }

  function addPendingRegister(data) {
    if (pendingRegisterAuthIds.has(data.auth_id)) return;
    pendingRegisterAuthIds.add(data.auth_id);
    const grid = el('ts-pending-grid');
    const card = document.createElement('div');
    card.className = 'ts-card';
    card.id = 'ts-card-' + data.auth_id;
    card.innerHTML = \`
      <div class="ts-card-head">
        <span class="ts-card-title">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s-8-4.5-8-11.8A8 8 0 0 1 12 2a8 8 0 0 1 8 8.2c0 7.3-8 11.8-8 11.8z"/><circle cx="12" cy="10" r="3"/></svg>
          New Register Request
        </span>
        <span class="ts-card-time">\${formatTime(data.timestamp)}</span>
      </div>
      <div class="ts-card-authid">\${escapeHtml(data.auth_id)}</div>
      <div class="ts-card-actions">
        <button class="btn ghost small" onclick="dismissPending('\${data.auth_id}')">Dismiss</button>
        <button class="btn-ts-accept" onclick="acceptPending('\${data.auth_id}', this)">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          Accept + Enable Auto (1h)
        </button>
      </div>
    \`;
    grid.appendChild(card);
    el('ts-pending-section').classList.add('has-items');
    el('ts-pending-count').textContent = pendingRegisterAuthIds.size + ' perlu approval';
  }

  function removePendingRegister(authId) {
    pendingRegisterAuthIds.delete(authId);
    const card = document.getElementById('ts-card-' + authId);
    if (card) card.remove();
    if (pendingRegisterAuthIds.size === 0) el('ts-pending-section').classList.remove('has-items');
    else el('ts-pending-count').textContent = pendingRegisterAuthIds.size + ' perlu approval';
  }

  async function dismissPending(authId) {
    removePendingRegister(authId);
  }

  async function acceptPending(authId, btn) {
    btn.disabled = true; btn.textContent = 'Registering...';
    try {
      // 1. Enable auto-accept first (so future requests dalam session ini juga auto)
      await fetch('/api/tailscale/auto-accept/enable', { method: 'POST' });
      // 2. Register this specific auth-id
      const res = await fetch('/tailscale/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auth_id: authId })
      });
      const data = await res.json();
      if (data.success) {
        showToast('success', \`✅ Registered + Auto-Accept ON 1h\`);
        removePendingRegister(authId);
      } else {
        showToast('danger', 'Register gagal: ' + (data.error || 'unknown'));
        btn.disabled = false;
        btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Accept + Enable Auto (1h)';
      }
    } catch (e) {
      showToast('danger', 'Network error');
      btn.disabled = false;
    }
  }

  // ------- Boot -------
  refreshAll();
  loadAutoAcceptStatus();
  setupSocket();

  // Session time display
  const startAt = new Date();
  el('session-time').textContent = 'signed in · ' + startAt.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
</script>
</body>
</html>`;
