// Telegram Bot — Backend IPC Client
// Sprint 2b (2026-11-22): axios wrapper for /api/tg/* with Bearer auth.
// Decisions Q5=C, Q6=C locked — REST via loopback 127.0.0.1 + Bearer token.

const axios = require('axios');

const BACKEND_URL = process.env.BACKEND_URL || 'http://127.0.0.1:3010';
const TG_BOT_API_KEY = process.env.TG_BOT_API_KEY;

if (!TG_BOT_API_KEY) {
    console.warn('[backend-client] TG_BOT_API_KEY not set — backend calls will fail auth');
}

const client = axios.create({
    baseURL: `${BACKEND_URL}/api/tg`,
    timeout: 10000,
    headers: {
        Authorization: `Bearer ${TG_BOT_API_KEY}`,
        'Content-Type': 'application/json'
    },
    // Accept all status codes — we unwrap ourselves
    validateStatus: () => true
});

/**
 * POST a JSON body. Returns {ok, status, data}.
 * ok is based on 2xx response, not HTTP success.
 */
async function postJson(path, body) {
    try {
        const resp = await client.post(path, body);
        return {
            ok: resp.status >= 200 && resp.status < 300,
            status: resp.status,
            data: resp.data
        };
    } catch (e) {
        // Network / timeout errors only
        return { ok: false, status: 0, data: { error: 'network', detail: e.message } };
    }
}

/**
 * GET helper (less-used in Sprint 2b). Returns {ok, status, data}.
 */
async function getJson(path) {
    try {
        const resp = await client.get(path);
        return {
            ok: resp.status >= 200 && resp.status < 300,
            status: resp.status,
            data: resp.data
        };
    } catch (e) {
        return { ok: false, status: 0, data: { error: 'network', detail: e.message } };
    }
}

async function getBackendHealth() {
    return getJson('/health');
}

module.exports = { postJson, getJson, getBackendHealth };
