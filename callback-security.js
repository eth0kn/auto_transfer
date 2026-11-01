'use strict';
/**
 * callback-security.js — SSRF URL validator + HMAC-SHA256 signer
 * Feature: Transfer Status Callback (v4.1.0)
 * Spec: docs/feature-callback-2026-11-01.md §6f (SSRF guards) + §3d (headers)
 *
 * Export:
 *   validateCallbackUrl(url)  → { valid: bool, reason?: string, resolvedIp?: string }
 *   signPayload(secret, body) → "sha256=<hex>" | null
 *   generateDeliveryId()      → "dlv-<uuid>"
 */

const crypto = require('crypto');
const { URL } = require('url');
const dns = require('dns').promises;

// Private / loopback / metadata / link-local IPv4 ranges
const PRIVATE_IPV4_PATTERNS = [
    /^127\./,                               // loopback
    /^10\./,                                // RFC1918
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./,      // RFC1918
    /^192\.168\./,                          // RFC1918
    /^169\.254\./,                          // link-local + AWS/GCP metadata
    /^0\./,                                 // 0.0.0.0/8
    /^100\.(6[4-9]|[7-9][0-9]|1[0-1][0-9]|12[0-7])\./, // CGNAT 100.64.0.0/10 (Tailscale, etc)
];

// Private / loopback IPv6 ranges
const PRIVATE_IPV6_PATTERNS = [
    /^::1$/i,                               // loopback
    /^::$/i,                                // unspecified
    /^f[cd][0-9a-f]{2}:/i,                  // unique local fc00::/7
    /^fe[89ab][0-9a-f]:/i,                  // link-local fe80::/10
];

const BLOCKED_HOSTNAMES = new Set([
    'localhost',
    'ip6-localhost',
    'ip6-loopback',
    'metadata.google.internal',
    'metadata.aws.internal',
    'instance-data',
]);

/**
 * Validate callback_url: parse → scheme check → hostname blocklist → DNS → IP blocklist.
 * Called at task creation (POST /{app}/transfer) AND at delivery time (worker, DNS poison guard).
 */
async function validateCallbackUrl(urlString) {
    if (!urlString || typeof urlString !== 'string') {
        return { valid: false, reason: 'callback_url is empty or not a string' };
    }
    let parsed;
    try {
        parsed = new URL(urlString);
    } catch (err) {
        return { valid: false, reason: `invalid URL: ${err.message}` };
    }
    if (parsed.protocol !== 'https:') {
        return { valid: false, reason: `scheme must be https (got "${parsed.protocol}")` };
    }
    const hostname = parsed.hostname.toLowerCase();
    if (BLOCKED_HOSTNAMES.has(hostname)) {
        return { valid: false, reason: `hostname blocked: "${hostname}"` };
    }
    // If hostname IS already an IP literal, check directly
    if (looksLikeIpv4(hostname) && isPrivateIpv4(hostname)) {
        return { valid: false, reason: `IPv4 literal blocked: ${hostname}` };
    }
    if (hostname.includes(':') && isPrivateIpv6(hostname)) {
        return { valid: false, reason: `IPv6 literal blocked: ${hostname}` };
    }
    // DNS resolve (may fail → reject)
    let resolved;
    try {
        resolved = await dns.lookup(hostname, { all: true });
    } catch (err) {
        return { valid: false, reason: `DNS lookup failed: ${err.message}` };
    }
    for (const addr of resolved) {
        if (addr.family === 4 && isPrivateIpv4(addr.address)) {
            return { valid: false, reason: `resolves to private/metadata IPv4: ${addr.address}` };
        }
        if (addr.family === 6 && isPrivateIpv6(addr.address)) {
            return { valid: false, reason: `resolves to private/metadata IPv6: ${addr.address}` };
        }
    }
    return { valid: true, resolvedIp: resolved[0] && resolved[0].address };
}

function looksLikeIpv4(s) {
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(s);
}

function isPrivateIpv4(ip) {
    return PRIVATE_IPV4_PATTERNS.some((re) => re.test(ip));
}

function isPrivateIpv6(ip) {
    return PRIVATE_IPV6_PATTERNS.some((re) => re.test(ip));
}

/**
 * Sign raw body with HMAC-SHA256 using callback_secret.
 * Returns "sha256=<hex>" or null if secret absent.
 */
function signPayload(secret, rawBody) {
    if (!secret || typeof secret !== 'string') return null;
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(rawBody);
    return 'sha256=' + hmac.digest('hex');
}

/**
 * Minimum secret length guard (optional, called at create endpoint).
 */
function validateSecret(secret) {
    if (secret == null) return { valid: true };  // optional field
    if (typeof secret !== 'string') return { valid: false, reason: 'callback_secret must be string' };
    if (secret.length < 16) return { valid: false, reason: 'callback_secret min 16 chars' };
    if (secret.length > 128) return { valid: false, reason: 'callback_secret max 128 chars' };
    return { valid: true };
}

/**
 * Generate unique delivery ID (per attempt). Receiver dedupe by task_id, not this.
 */
function generateDeliveryId() {
    return 'dlv-' + crypto.randomUUID();
}

module.exports = {
    validateCallbackUrl,
    validateSecret,
    signPayload,
    generateDeliveryId,
};
