// Telegram Bot — Utilities

/**
 * Escape text for Telegram HTML parse_mode.
 * Only <, >, & need escaping. Underscores + hyphens + dots are verbatim.
 */
function escapeHtml(s) {
    return String(s ?? '-').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

module.exports = { escapeHtml };
