'use strict';
/**
 * callback-worker.js — DB-backed queue worker for transfer callback delivery.
 * Feature: Transfer Status Callback (v4.1.0)
 * Spec: docs/feature-callback-2026-11-01.md §6a-6j (robustness features)
 *
 * Lifecycle:
 *   start(pool)        → spawn tick interval + 60s summary interval
 *   signalPickup()     → fire tick immediately (opsional, from /update-task post-finalize)
 *   shutdown()         → graceful stop (SIGTERM/SIGINT)
 *   getStats(pool, h)  → admin stats
 *   listDead(pool,…)   → admin DEAD inspection
 *   replayTask(pool,…) → admin replay DEAD→PENDING
 *
 * Behavior per spec:
 *   Backoff: 0s, 30s, 2m, 10m, 1h (±25% jitter)
 *   Max attempts: 5. Max age: 24h.
 *   4xx → immediate DEAD (no retry, client error).
 *   5xx + timeout + net error → retry.
 *   SSRF re-validate at delivery (DNS poison guard).
 */

const { validateCallbackUrl, signPayload, generateDeliveryId } = require('./callback-security');

// ==========================================================
// CONFIG via ENV (defaults in spec section 9)
// ==========================================================
const INTERVAL_MS      = parseInt(process.env.CALLBACK_WORKER_INTERVAL_MS || '10000', 10);
const BATCH            = parseInt(process.env.CALLBACK_WORKER_BATCH || '20', 10);
const TIMEOUT_MS       = parseInt(process.env.CALLBACK_TIMEOUT_MS || '10000', 10);
const MAX_ATTEMPTS     = parseInt(process.env.CALLBACK_MAX_ATTEMPTS || '5', 10);
const MAX_AGE_HOURS    = parseInt(process.env.CALLBACK_MAX_AGE_HOURS || '24', 10);

// Backoff schedule in seconds — index = attempt just made.
// attempt 1 → next retry in 30s, attempt 2 → 2m, etc.
const BACKOFF_SECONDS  = [30, 120, 600, 3600];

// ==========================================================
// STATE
// ==========================================================
const state = {
    pool: null,
    tickTimer: null,
    summaryTimer: null,
    shuttingDown: false,
    inFlight: 0,
    deliveredLast60s: 0,
    deadLast60s: 0,
    retriedLast60s: 0,
    latencySumMs: 0,
    latencyCount: 0,
};

function log(line) {
    console.log(`[CALLBACK] ${line}`);
}

function withJitter(seconds) {
    if (seconds <= 0) return 0;
    const jitter = (Math.random() - 0.5) * 0.5 * seconds; // ±25%
    return Math.max(1, Math.round(seconds + jitter));
}

// ==========================================================
// MAIN TICK
// ==========================================================
async function tick() {
    if (state.shuttingDown || !state.pool) return;
    try {
        const [rows] = await state.pool.query(
            `SELECT id, ref_number, app_source, bot_alias, bank_type, dest, amount, status, message,
                    balance_after, balance_source, callback_url, callback_secret, callback_attempts,
                    created_at, updated_at
             FROM transfer_request
             WHERE callback_status='PENDING'
               AND callback_url IS NOT NULL
               AND (callback_next_attempt_at IS NULL OR callback_next_attempt_at <= NOW())
             ORDER BY callback_next_attempt_at IS NULL DESC, callback_next_attempt_at ASC, updated_at ASC
             LIMIT ?`,
            [BATCH]
        );
        if (rows.length === 0) return;
        // Deliver in parallel within batch (worker limits concurrency by BATCH size).
        await Promise.all(rows.map((row) => deliver(row)));
    } catch (err) {
        log(`tick_error msg="${err.message}"`);
    }
}

// ==========================================================
// DELIVER ONE TASK
// ==========================================================
async function deliver(row) {
    state.inFlight++;
    const taskKey = row.id;  // transfer_request.id (TRX-xxx)
    const attempt = (row.callback_attempts || 0) + 1;
    const deliveryId = generateDeliveryId();
    const issuedAt = new Date().toISOString();

    try {
        // 1. Re-validate URL (DNS poison guard — attack scenario: URL stored, DNS later resolves private IP)
        const sVal = await validateCallbackUrl(row.callback_url);
        if (!sVal.valid) {
            log(`task=${taskKey} event=ssrf_reject attempt=${attempt} reason="${sVal.reason}"`);
            await markDead(taskKey, `ssrf_reject: ${sVal.reason}`);
            state.deadLast60s++;
            return;
        }

        // 2. Lookup decision_source from transfer_validations (optional join)
        let decisionSource = null;
        try {
            const [vRows] = await state.pool.query(
                `SELECT decision_source FROM transfer_validations WHERE task_id = ? LIMIT 1`,
                [taskKey]
            );
            if (vRows.length) decisionSource = vRows[0].decision_source;
        } catch (_) { /* non-fatal */ }

        // 3. Compose payload per spec §3c
        const payload = {
            task_id: taskKey,
            app_source: row.app_source,
            alias: row.bot_alias,
            bank: row.bank_type,
            dest: row.dest,
            amount: row.amount != null ? Number(row.amount) : null,
            status: row.status,
            ref_number: row.ref_number || null,
            balance_after: row.balance_after != null ? Number(row.balance_after) : null,
            balance_source: row.balance_source || null,
            message: parseMessageText(row.message),
            decision_source: decisionSource,
            created_at: toIsoOrNull(row.created_at),
            completed_at: toIsoOrNull(row.updated_at),
            issued_at: issuedAt,
            attempt: attempt,
            delivery_id: deliveryId,
        };
        const body = JSON.stringify(payload);

        // 4. Headers + optional HMAC signature
        const headers = {
            'Content-Type': 'application/json',
            'User-Agent': 'AutoTransfer-Callback/1.0',
            'X-Autotransfer-Task-Id': taskKey,
            'X-Autotransfer-App-Source': row.app_source,
            'X-Autotransfer-Delivery-Id': deliveryId,
            'X-Autotransfer-Attempt': String(attempt),
            'X-Autotransfer-Issued-At': issuedAt,
        };
        const signature = signPayload(row.callback_secret, body);
        if (signature) headers['X-Autotransfer-Signature'] = signature;

        // 5. Fire HTTP POST with timeout (AbortController)
        log(`task=${taskKey} event=sending attempt=${attempt} url=${sanitizeUrlForLog(row.callback_url)}`);
        const t0 = Date.now();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
        let outcome;
        try {
            const res = await fetch(row.callback_url, {
                method: 'POST',
                headers,
                body,
                signal: controller.signal,
            });
            clearTimeout(timer);
            const dur = Date.now() - t0;
            state.latencySumMs += dur;
            state.latencyCount++;
            if (res.status >= 200 && res.status < 300) {
                outcome = { kind: 'delivered', status: res.status, dur };
            } else if (res.status >= 400 && res.status < 500) {
                outcome = { kind: 'dead_4xx', status: res.status, dur };
            } else {
                outcome = { kind: 'retry', status: res.status, dur, reason: `5xx:${res.status}` };
            }
        } catch (err) {
            clearTimeout(timer);
            const dur = Date.now() - t0;
            const reason = err.name === 'AbortError' ? `timeout:${TIMEOUT_MS}ms` : `net:${err.message || err.code || 'unknown'}`;
            outcome = { kind: 'retry', dur, reason };
        }

        // 6. Persist outcome
        if (outcome.kind === 'delivered') {
            log(`task=${taskKey} event=delivered attempt=${attempt} status=${outcome.status} duration_ms=${outcome.dur}`);
            await markDelivered(taskKey, attempt);
            state.deliveredLast60s++;
        } else if (outcome.kind === 'dead_4xx') {
            log(`task=${taskKey} event=dead attempt=${attempt} status=${outcome.status} reason=4xx_client_reject`);
            await markDead(taskKey, `4xx:${outcome.status}`, attempt);
            state.deadLast60s++;
        } else {
            await scheduleRetryOrDead(row, attempt, outcome.reason);
        }
    } catch (err) {
        log(`task=${taskKey} event=deliver_error attempt=${attempt} msg="${err.message}"`);
        // Treat unexpected error as retryable transient
        try { await scheduleRetryOrDead(row, attempt, `exception:${err.message}`); } catch (_) {}
    } finally {
        state.inFlight--;
    }
}

// ==========================================================
// DB HELPERS
// ==========================================================
async function markDelivered(taskId, attempt) {
    await state.pool.query(
        `UPDATE transfer_request
         SET callback_status='DELIVERED',
             callback_attempts=?,
             callback_last_attempt_at=NOW(),
             callback_delivered_at=NOW(),
             callback_last_error=NULL,
             callback_next_attempt_at=NULL
         WHERE id=? AND callback_status='PENDING'`,
        [attempt, taskId]
    );
}

async function markDead(taskId, reason, attempt) {
    await state.pool.query(
        `UPDATE transfer_request
         SET callback_status='DEAD',
             callback_attempts=COALESCE(?, callback_attempts),
             callback_last_attempt_at=NOW(),
             callback_last_error=?,
             callback_next_attempt_at=NULL
         WHERE id=? AND callback_status='PENDING'`,
        [attempt != null ? attempt : null, reason, taskId]
    );
}

async function scheduleRetryOrDead(row, attempt, reason) {
    const taskId = row.id;
    const ageMs = Date.now() - new Date(row.created_at).getTime();
    const ageHours = ageMs / 3600000;
    if (attempt >= MAX_ATTEMPTS || ageHours >= MAX_AGE_HOURS) {
        log(`task=${taskId} event=dead attempt=${attempt} reason=exhausted_or_aged last_err="${reason}" ageH=${ageHours.toFixed(1)}`);
        await markDead(taskId, `exhausted: ${reason}`, attempt);
        state.deadLast60s++;
        return;
    }
    const backoffIndex = Math.min(attempt - 1, BACKOFF_SECONDS.length - 1);
    const nextSec = withJitter(BACKOFF_SECONDS[backoffIndex]);
    log(`task=${taskId} event=retry attempt=${attempt} reason="${reason}" next_in_s=${nextSec}`);
    await state.pool.query(
        `UPDATE transfer_request
         SET callback_attempts=?,
             callback_last_attempt_at=NOW(),
             callback_last_error=?,
             callback_next_attempt_at=DATE_ADD(NOW(), INTERVAL ? SECOND)
         WHERE id=? AND callback_status='PENDING'`,
        [attempt, reason, nextSec, taskId]
    );
    state.retriedLast60s++;
}

// ==========================================================
// MESSAGE / TIMESTAMP HELPERS
// ==========================================================
function parseMessageText(message) {
    if (!message) return null;
    try {
        const parsed = typeof message === 'string' ? JSON.parse(message) : message;
        return parsed.text || parsed.reason || null;
    } catch (_) {
        return String(message);
    }
}

function toIsoOrNull(d) {
    if (!d) return null;
    try { return new Date(d).toISOString(); } catch (_) { return null; }
}

function sanitizeUrlForLog(url) {
    // Avoid leaking query params that may hold auth tokens.
    try {
        const u = new URL(url);
        return `${u.protocol}//${u.host}${u.pathname}${u.search ? '?[redacted]' : ''}`;
    } catch (_) { return '<invalid>'; }
}

// ==========================================================
// SUMMARY LOG (60s)
// ==========================================================
function summaryTick() {
    const d = state.deliveredLast60s, r = state.retriedLast60s, x = state.deadLast60s;
    if (d + r + x > 0) {
        const avgLat = state.latencyCount > 0 ? Math.round(state.latencySumMs / state.latencyCount) : 0;
        log(`[SUMMARY] window=60s delivered=${d} retried=${r} dead=${x} in_flight=${state.inFlight} avg_latency_ms=${avgLat}`);
    }
    state.deliveredLast60s = 0;
    state.retriedLast60s = 0;
    state.deadLast60s = 0;
    state.latencySumMs = 0;
    state.latencyCount = 0;
}

// ==========================================================
// LIFECYCLE
// ==========================================================
function start(pool) {
    if (state.pool) {
        log('start called twice — ignoring');
        return;
    }
    state.pool = pool;
    state.tickTimer = setInterval(tick, INTERVAL_MS);
    state.summaryTimer = setInterval(summaryTick, 60000);
    log(`started interval=${INTERVAL_MS}ms batch=${BATCH} timeout=${TIMEOUT_MS}ms max_attempts=${MAX_ATTEMPTS} max_age_h=${MAX_AGE_HOURS}`);
}

function shutdown() {
    if (state.shuttingDown) return;
    state.shuttingDown = true;
    if (state.tickTimer) clearInterval(state.tickTimer);
    if (state.summaryTimer) clearInterval(state.summaryTimer);
    log(`shutdown signal — stopping ticks, in_flight=${state.inFlight} (will finish on their own)`);
}

function signalPickup() {
    // Opsional: fire tick ASAP (not scheduled). Safe to call from /update-task handler.
    if (!state.shuttingDown && state.pool) {
        setImmediate(tick);
    }
}

// ==========================================================
// ADMIN API HELPERS (called by index.js admin endpoints)
// ==========================================================
async function getStats(pool, windowHours) {
    const h = Number.isFinite(windowHours) ? windowHours : 24;
    const [counts] = await pool.query(
        `SELECT callback_status, COUNT(*) AS cnt
         FROM transfer_request
         WHERE updated_at > DATE_SUB(NOW(), INTERVAL ? HOUR)
         GROUP BY callback_status`,
        [h]
    );
    const [retry] = await pool.query(
        `SELECT callback_attempts, COUNT(*) AS cnt
         FROM transfer_request
         WHERE updated_at > DATE_SUB(NOW(), INTERVAL ? HOUR) AND callback_status='DELIVERED'
         GROUP BY callback_attempts`,
        [h]
    );
    const [latency] = await pool.query(
        `SELECT AVG(TIMESTAMPDIFF(SECOND, updated_at, callback_delivered_at)) AS avg_s,
                MAX(TIMESTAMPDIFF(SECOND, updated_at, callback_delivered_at)) AS max_s,
                COUNT(*) AS n
         FROM transfer_request
         WHERE callback_delivered_at IS NOT NULL
           AND updated_at > DATE_SUB(NOW(), INTERVAL ? HOUR)`,
        [h]
    );
    return {
        window_hours: h,
        counts: counts.reduce((acc, r) => { acc[r.callback_status] = Number(r.cnt); return acc; }, {}),
        retry_distribution: retry.reduce((acc, r) => { acc[`attempt_${r.callback_attempts}`] = Number(r.cnt); return acc; }, {}),
        delivery_latency: {
            samples: latency[0] ? Number(latency[0].n) : 0,
            avg_s: latency[0] && latency[0].avg_s != null ? Number(latency[0].avg_s) : null,
            max_s: latency[0] && latency[0].max_s != null ? Number(latency[0].max_s) : null,
        },
    };
}

async function listDead(pool, limit, offset) {
    const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const off = Math.max(parseInt(offset, 10) || 0, 0);
    const [rows] = await pool.query(
        `SELECT id AS task_id, ref_number, app_source, bot_alias, bank_type, dest, amount,
                callback_url, callback_attempts, callback_last_error,
                callback_last_attempt_at, updated_at AS task_completed_at
         FROM transfer_request
         WHERE callback_status='DEAD'
         ORDER BY callback_last_attempt_at DESC
         LIMIT ? OFFSET ?`,
        [lim, off]
    );
    const [[{ total }]] = await pool.query(
        `SELECT COUNT(*) AS total FROM transfer_request WHERE callback_status='DEAD'`
    );
    return { total: Number(total), items: rows };
}

async function replayTask(pool, taskId) {
    if (!taskId) return { success: false, reason: 'task_id required' };
    const [row] = await pool.query(
        `SELECT callback_status FROM transfer_request WHERE id=?`,
        [taskId]
    );
    if (!row.length) return { success: false, reason: 'task not found' };
    const cur = row[0].callback_status;
    if (cur === 'DELIVERED') return { success: false, reason: 'already_delivered' };
    if (cur === 'NONE')      return { success: false, reason: 'no callback_url configured' };
    if (cur === 'PENDING')   return { success: false, reason: 'already_pending' };
    // DEAD → reset
    const [res] = await pool.query(
        `UPDATE transfer_request
         SET callback_status='PENDING',
             callback_attempts=0,
             callback_last_error=NULL,
             callback_next_attempt_at=NOW()
         WHERE id=? AND callback_status='DEAD'`,
        [taskId]
    );
    if (res.affectedRows === 0) return { success: false, reason: 'race: state changed' };
    log(`task=${taskId} event=admin_replay reset_to_pending`);
    return { success: true };
}

// ==========================================================
// EXPORTS
// ==========================================================
module.exports = {
    start,
    shutdown,
    signalPickup,
    getStats,
    listDead,
    replayTask,
};
