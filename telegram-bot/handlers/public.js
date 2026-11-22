// Telegram Bot — Public Handlers
// Scope: PUBLIC (semua role termasuk unknown)

const { logAudit } = require('../audit');
const { notifyOwnerUnknown } = require('../shadow');
const { escapeHtml } = require('../util');

async function handleStart(ctx) {
    const r = ctx.state.role;
    const roleLabel = {
        owner: '👑 Owner',
        operator: '👤 Operator (approved)',
        unknown: '❓ Unknown — contact admin for access'
    }[r.role] || '❓';

    const text = [
        `🤖 <b>Auto-Transfer Bot</b>`,
        ``,
        `Welcome. You are: ${roleLabel}`,
        ``,
        `Commands:`,
        `• <code>/whoami</code> — show your role`,
        `• <code>/help</code> — list commands available for your role`
    ].join('\n');

    await ctx.reply(text, { parse_mode: 'HTML' });
    await logAudit({ chat_id: r.chat_id, role: r.role, cmd: '/start', result: 'success' });

    // Unknown user attempting /start → notify owner (so they can decide to approve)
    if (r.role === 'unknown') {
        await notifyOwnerUnknown(ctx, '/start');
    }
}

async function handleWhoami(ctx) {
    const r = ctx.state.role;
    const chat_id = r.chat_id || 'n/a';
    let text;

    if (r.role === 'owner') {
        text = `👑 <b>Owner</b>\nID: <code>${escapeHtml(chat_id)}</code>\nAll commands available.`;
    } else if (r.role === 'operator') {
        const op = r.operator;
        const scope = op.allowed_rdp_hostnames
            ? JSON.parse(op.allowed_rdp_hostnames).join(', ')
            : 'all approved RDPs';
        text = [
            `👤 <b>Operator (approved)</b>`,
            `ID: <code>${escapeHtml(chat_id)}</code>`,
            `Name: ${escapeHtml(op.display_name || '-')}`,
            `Scope: ${escapeHtml(scope)}`,
            `Approved at: ${escapeHtml(op.approved_at || '-')}`
        ].join('\n');
    } else {
        text = [
            `❓ <b>Unknown</b>`,
            `ID: <code>${escapeHtml(chat_id)}</code>`,
            ``,
            `You are not registered. Contact owner to add you as operator.`
        ].join('\n');
    }

    await ctx.reply(text, { parse_mode: 'HTML' });
    await logAudit({ chat_id: r.chat_id || 'unknown', role: r.role, cmd: '/whoami', result: 'success' });
}

async function handleHelp(ctx) {
    const r = ctx.state.role;
    let text;

    if (r.role === 'owner') {
        text = [
            `👑 <b>Owner Commands</b>`,
            ``,
            `<i>Argumen dalam <code>&lt;...&gt;</code> wajib. Argumen dalam <code>[...]</code> opsional — tidak perlu ditulis, bot akan auto-resolve.</i>`,
            ``,
            `📌 <b>General</b>`,
            `• <code>/start</code> — Greeting + role check`,
            `• <code>/whoami</code> — Tampilkan chat_id + role kamu`,
            `• <code>/help</code> — Tampilkan panduan ini`,
            ``,
            `🖥 <b>RDP Management</b>`,
            `• <code>/list_rdp</code> — List semua RDP terdaftar (status + last seen)`,
            `• <code>/approve_rdp &lt;hostname&gt;</code> — Approve RDP registration pending`,
            `• <code>/revoke_rdp &lt;hostname&gt;</code> — Revoke RDP (tidak terima job lagi)`,
            ``,
            `👥 <b>Operator Management</b>`,
            `• <code>/list_operators</code> — List semua operator`,
            `• <code>/create_operator &lt;chat_id&gt; &lt;display_name&gt;</code> — Buat operator baru (auto-approved)`,
            `• <code>/revoke_operator &lt;chat_id&gt;</code> — Cabut akses operator`,
            `• <code>/delete_operator &lt;chat_id&gt;</code> — Hapus permanen record operator`,
            ``,
            `👁 <b>Observability</b>`,
            `• <code>/shadow on|off|filter &lt;level&gt;</code> — Toggle shadow forward (owner lihat semua action operator)`,
            `• <code>/audit [chat_id] [limit]</code> — Lihat audit log (default: semua, limit 20)`,
            ``,
            `🏦 <b>Account Management</b>`,
            `<i>💡 Tips: Kalau <code>[rdp]</code> tidak ditulis, bot auto-cari alias di semua RDP scope kamu. Kalau alias ada di &gt;1 RDP, muncul picker inline untuk pilih.</i>`,
            ``,
            `• <code>/add</code> — Buat akun baru (wizard: pilih RDP → alias → password → callback URL → saldo minimal → device IP → pair code)`,
            `• <code>/edit &lt;alias&gt; [rdp]</code> — Edit field akun (alias/password/callback_url/device_id/keep_balance)`,
            `   <i>Contoh: <code>/edit brimoKN</code> atau <code>/edit brimoKN KN-ProArt</code></i>`,
            `• <code>/delete &lt;alias&gt; [rdp]</code> — Hapus akun (YES/NO confirm)`,
            `• <code>/list_accounts</code> — List semua akun di scope kamu, grouped per RDP dengan bot state + device + flags`,
            `• <code>/cancel</code> — Batalkan wizard yang sedang aktif`,
            ``,
            `▶ <b>Runtime Control</b> <i>(remote start/stop bot engine)</i>`,
            `• <code>/start_bot &lt;alias&gt; [rdp]</code> — Start bot engine`,
            `   <i>Contoh: <code>/start_bot brimoKN</code></i>`,
            `• <code>/stop_bot &lt;alias&gt; [rdp]</code> — Stop bot engine`,
            ``,
            `ℹ️ <i>Alias unik antar RDP adalah konvensi penamaan operator — bukan code-enforced. Kalau alias ada di &gt;1 RDP, bot kasih picker untuk pilih.</i>`
        ].join('\n');
    } else if (r.role === 'operator') {
        text = [
            `👤 <b>Operator Commands</b>`,
            ``,
            `<i>Argumen dalam <code>&lt;...&gt;</code> wajib. Argumen dalam <code>[...]</code> opsional — tidak perlu ditulis, bot akan auto-resolve.</i>`,
            ``,
            `📌 <b>General</b>`,
            `• <code>/whoami</code> — Tampilkan chat_id + role kamu`,
            `• <code>/list</code> — List RDP yang kamu bisa akses`,
            `• <code>/status</code> — Ringkasan health RDP + bot`,
            ``,
            `🏦 <b>Account Management</b>`,
            `<i>💡 Tips: Kalau <code>[rdp]</code> tidak ditulis, bot auto-cari alias di semua RDP scope kamu. Kalau alias ada di &gt;1 RDP, muncul picker inline untuk pilih.</i>`,
            ``,
            `• <code>/add</code> — Buat akun baru (wizard 6-step)`,
            `• <code>/edit &lt;alias&gt; [rdp]</code> — Edit field akun`,
            `   <i>Contoh: <code>/edit brimoKN</code> atau <code>/edit brimoKN KN-ProArt</code></i>`,
            `• <code>/delete &lt;alias&gt; [rdp]</code> — Hapus akun (YES/NO confirm)`,
            `• <code>/list_accounts</code> — List semua akun di scope kamu, grouped per RDP dengan bot state + device + flags`,
            `• <code>/cancel</code> — Batalkan wizard yang sedang aktif`,
            ``,
            `▶ <b>Runtime Control</b>`,
            `• <code>/start_bot &lt;alias&gt; [rdp]</code> — Start bot engine`,
            `   <i>Contoh: <code>/start_bot brimoKN</code></i>`,
            `• <code>/stop_bot &lt;alias&gt; [rdp]</code> — Stop bot engine`,
            ``,
            `<i>Hubungi owner kalau butuh akses lebih.</i>`
        ].join('\n');
    } else {
        text = [
            `❓ <b>Unknown User</b>`,
            ``,
            `You are not registered as owner or operator.`,
            `Available: <code>/start</code>, <code>/whoami</code>, <code>/help</code>`,
            ``,
            `Contact owner with your chat_id to request access.`
        ].join('\n');
    }

    await ctx.reply(text, { parse_mode: 'HTML' });
    await logAudit({ chat_id: r.chat_id || 'unknown', role: r.role, cmd: '/help', result: 'success' });
}

module.exports = { handleStart, handleWhoami, handleHelp };
