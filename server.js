require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mysql = require('mysql2/promise');
const cors = require('cors');
const crypto = require('crypto'); // Built-in node module

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3002;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const dbConfig = {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'auto_transfer_db',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
};

const pool = mysql.createPool(dbConfig);

// --- HELPER: ID GENERATOR ---
// Menghasilkan ID unik: TRX-XXXX-XXXX (Contoh: TRX-A1B2-C3D4)
function generateTrxId() {
    const random = crypto.randomBytes(4).toString('hex').toUpperCase(); // 8 karakter hex
    return `TRX-${random}`;
}

const cookieParser = require('cookie-parser'); // [PATCH] Tambahkan ini
app.use(cookieParser()); // [PATCH] Gunakan middleware cookie

// --- [PATCH] MIDDLEWARE AUTH BARU ---
const requireAuth = (req, res, next) => {
    // Cek apakah ada cookie 'isLoggedIn' dengan nilai true
    if (req.cookies.isLoggedIn === 'true') {
        return next();
    }
    // Jika tidak ada, lempar ke halaman login
    res.redirect('/login');
};

// 2. Cek API Key (Untuk Inject Tugas)
const requireApiKey = (req, res, next) => {
    const key = req.headers['x-api-key'];
    if (!key || key !== process.env.API_KEY) {
        console.log(`🛑 someone trying to create task...`)
        return res.status(401).json({ success: false, msg: "Invalid or Missing X-API-KEY" });
    }
    next();
};

// ==========================================
// A. ENDPOINT LOGIC
// ==========================================

// 1. ADMIN: Buat Request Transfer
app.post('/transfer', requireApiKey, async (req, res) => {
    try {
        const { alias, bank, dest, amount, pin } = req.body;
        if (!alias || !dest || !amount || !pin) {
            return res.status(400).json({ success: false, msg: "Data wajib diisi" });
        }

        // GENERATE ID DI SINI
        const newTaskId = generateTrxId();

        const sql = `INSERT INTO transfer_request (id, bot_alias, bank_type, dest, amount, pin, status) VALUES (?, ?, ?, ?, ?, ?, 'PENDING')`;
        await pool.execute(sql, [newTaskId, alias, bank || 'BRI', dest, amount, pin]);

        res.json({ success: true, msg: "Request masuk antrian", task_id: newTaskId });
    } catch (err) {
        res.status(500).json({ success: false, msg: err.message });
    }
});

// 2. BOT: Ambil Request
app.post('/get-task', async (req, res) => {
    const { alias } = req.body;
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const [rows] = await connection.execute(
            `SELECT * FROM transfer_request
             WHERE (bot_alias = ? OR bot_alias IS NULL) AND status = 'PENDING'
             ORDER BY created_at ASC LIMIT 1 FOR UPDATE`,
            [alias]
        );

        if (rows.length === 0) {
            await connection.rollback();
            return res.json({ task_available: false });
        }
        const task = rows[0];

        // Update status jadi PROCESSING
        await connection.execute(
            `UPDATE transfer_request SET status = 'PROCESSING', updated_at = NOW() WHERE id = ?`,
            [task.id]
        );
        await connection.commit();

        console.log(`[DISPATCH] Task ${task.id} -> Bot ${alias}`);
        res.json({
            task_available: true,
            task_id: task.id, // String ID
            bank_type: task.bank_type,
            destination: task.dest,
            amount: parseFloat(task.amount),
            pin: task.pin
        });
    } catch (err) {
        await connection.rollback();
        console.error(err);
        res.status(500).json({ task_available: false });
    } finally {
        connection.release();
    }
});

// 3. BOT: Lapor Status Akhir
app.post('/update-task', async (req, res) => {
    try {
        const { task_id, status, message } = req.body;
        if (!['SUCCESS', 'FAILED'].includes(status)) return res.status(400).json({ msg: "Invalid Status" });

        let refNumber = null;
        let finalMessage = null;
        try {
            const msgObj = JSON.parse(message);
            if (msgObj.ref_number) refNumber = msgObj.ref_number;
            if (status === 'SUCCESS') finalMessage = `Transfer to "${msgObj.details.target_name}" | ${msgObj.details.bank}-${msgObj.details.target_rek} | Rp. ${msgObj.details.amount} | Approved by Admin`;
            if (status === 'FAILED') finalMessage = msgObj.reason;
        } catch (e) { }

        await pool.execute(
            `UPDATE transfer_request SET status = ?, message = ?, ref_number = ?, updated_at = NOW() WHERE id = ?`,
            [status, finalMessage, refNumber, task_id]
        );

        // Notify Dashboard (WebSocket)
        io.emit('task_completed', { task_id, status });

        console.log(`[REPORT] Task ${task_id} -> ${status}`);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false });
    }
});

// 4. BOT: Kirim Data Konfirmasi (REALTIME VALIDATION)
app.post('/validate-confirmation', async (req, res) => {
    try {
        const d = req.body;
        console.log
        // Insert/Update tabel validation menggunakan ID String
        await pool.execute(
            `INSERT INTO transfer_validations 
            (task_id, device_id, account_name, target_name_extracted, target_rek_extracted, bank_name, total_amount, status) 
            VALUES (?, ?, ?, ?, ?, ?, ?, 'WAITING') 
            ON DUPLICATE KEY UPDATE 
            status='WAITING', target_name_extracted=?, target_rek_extracted=?, updated_at=NOW()`,
            [d.task_id, d.device_id, d.account_name, d.account_name_extracted, d.account_number_extracted, d.bank_name, d.total_amount, d.account_name_extracted, d.account_number_extracted]
        );

        // Ambil data asli untuk komparasi UI
        const [reqData] = await pool.execute('SELECT amount, dest FROM transfer_request WHERE id = ?', [d.task_id]);

        // Broadcast ke Dashboard
        io.emit('new_validation', {
            ...d,
            alias: d.account_name,
            target_name_extracted: d.account_name_extracted,
            target_rek_extracted:d.account_number_extracted,
            original_amount: reqData[0]?.amount || 0,
            original_dest: reqData[0]?.dest || '-',
            created_at: new Date()
        });

        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message });
    }
});

// 5. Polling & Decision
app.get('/get-validation-decision/:task_id', async (req, res) => {
    try {
        const [rows] = await pool.execute('SELECT status FROM transfer_validations WHERE task_id = ?', [req.params.task_id]);
        const status = rows.length > 0 ? rows[0].status : 'WAITING';
        res.json({ action: status === 'WAITING' ? 'WAIT' : status });
    } catch (e) { res.json({ action: 'WAIT' }); }
});

app.post('/update-decision', async (req, res) => {
    try {
        const { task_id, status } = req.body;
        const msg = req.body.message || "Rejected by Admin";
        await pool.execute('UPDATE transfer_validations SET status = ? WHERE task_id = ?', [status, task_id]);
        if (status === 'ABORT') {
            await pool.execute(`UPDATE transfer_request SET status = 'FAILED', message = ? WHERE id = ?`, [msg, task_id]);
        }
        io.emit('decision_updated', { task_id, status });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 6. API History & Data
app.get('/api/history', requireAuth, async (req, res) => {
    try {
        // Query History (7 Hari Terakhir)
        const [rows] = await pool.execute(`
            SELECT r.id, r.bot_alias, r.dest, r.amount, r.status, r.ref_number, r.message, r.updated_at,
                   v.target_name_extracted, v.bank_name
            FROM transfer_request r
            LEFT JOIN transfer_validations v ON r.id = v.task_id
            WHERE r.status IN ('SUCCESS', 'FAILED')
            AND r.updated_at >= (NOW() - INTERVAL 7 DAY)
            ORDER BY r.updated_at DESC
        `);
        res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/pending-validations', requireAuth, async (req, res) => {
    try {
        const [rows] = await pool.execute(`
            SELECT v.*, r.amount as original_amount, r.dest as original_dest
            FROM transfer_validations v 
            JOIN transfer_request r ON v.task_id = r.id 
            WHERE v.status = 'WAITING' 
            ORDER BY v.created_at DESC
        `);
        res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Serve HTML
app.get(['/', '/dashboard', '/history'], requireAuth, (req, res) => res.send(getHtmlUI()));

// Endpoint Login Page
app.get('/login', (req, res) => {
    res.send(getLoginUI()); // Kita akan buat fungsi UI login di bawah
});

// Endpoint Proses Login (POST)
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const validUser = process.env.DASHBOARD_USER || 'admin';
    const validPass = process.env.DASHBOARD_PASS || 'admin123';

    if (username === validUser && password === validPass) {
        // Set cookie selama 24 jam
        res.cookie('isLoggedIn', 'true', { maxAge: 4 * 60 * 60 * 1000, httpOnly: true });
        return res.json({ success: true });
    }
    res.status(401).json({ success: false, msg: 'Username atau Password salah' });
});

// Endpoint Logout (Hapus Cookie)
app.get('/logout', (req, res) => {
    res.clearCookie('isLoggedIn');
    res.redirect('/login');
});

// Cleanup
setInterval(async () => {
    try {
        const sql = `UPDATE transfer_request SET status = 'FAILED', message = 'Auto-reset by system -> longer than 3 minutes' 
                     WHERE status = 'PROCESSING' AND updated_at < (NOW() - INTERVAL 3 MINUTE)`;
        await pool.execute(sql);
    } catch (err) { }
}, 60000);

server.listen(PORT, () => {
    console.log(`🚀 Server (TRX-ID) running on Port ${PORT}`);
});

function getLoginUI() {
    return `
<!DOCTYPE html>
<html lang="id" class="dark">
<head>
    <meta charset="UTF-8">
    <title>Login - BotCommander</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&display=swap" rel="stylesheet">
    <style>body { font-family: 'Inter', sans-serif; background-color: #0f172a; }</style>
</head>
<body class="flex items-center justify-center min-h-screen">
    <div class="bg-slate-800 p-8 rounded-2xl shadow-2xl border border-white/5 w-full max-w-md">
        <div class="text-center mb-8">
            <h1 class="text-2xl font-bold text-white">Bot<span class="text-blue-400">Commander</span></h1>
            <p class="text-slate-400 mt-2">Silakan login untuk mengakses Dashboard</p>
        </div>
        <div class="space-y-4">
            <div>
                <label class="block text-sm font-medium text-slate-300 mb-1">Username</label>
                <input type="text" id="user" class="w-full bg-slate-900 border border-white/10 rounded-lg px-4 py-2 text-white focus:outline-none focus:ring-2 focus:ring-blue-500">
            </div>
            <div>
                <label class="block text-sm font-medium text-slate-300 mb-1">Password</label>
                <input type="password" id="pass" class="w-full bg-slate-900 border border-white/10 rounded-lg px-4 py-2 text-white focus:outline-none focus:ring-2 focus:ring-blue-500">
            </div>
            <button onclick="doLogin()" id="btnLogin" class="w-full bg-blue-600 hover:bg-blue-500 text-white font-bold py-2 rounded-lg transition">Login</button>
            <p id="errMsg" class="text-red-400 text-sm text-center hidden"></p>
        </div>
    </div>
    <script>
        async function doLogin() {
            const username = document.getElementById('user').value;
            const password = document.getElementById('pass').value;
            const btn = document.getElementById('btnLogin');
            const msg = document.getElementById('errMsg');

            btn.innerText = 'Checking...';
            const res = await fetch('/api/login', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ username, password })
            });
            const data = await res.json();
            if(data.success) {
                window.location.href = '/dashboard';
            } else {
                btn.innerText = 'Login';
                msg.innerText = data.msg;
                msg.classList.remove('hidden');
            }
        }
    </script>
</body>
</html>`;
}

function handleLogout() {
    if (confirm('Apakah Anda yakin ingin logout?')) {
        window.location.href = '/logout';
    }
}

// --- D. FRONTEND TEMPLATE ---
function getHtmlUI() {
    return `
<!DOCTYPE html>
<html lang="id" class="dark">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>BotCommander 2.0</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="/socket.io/socket.io.js"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/moment.js/2.29.4/moment.min.js"></script>
    <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&family=Inter:wght@300;400;600;700&display=swap" rel="stylesheet">
    <style>
        body { font-family: 'Inter', sans-serif; background-color: #0f172a; color: #e2e8f0; }
        .font-mono { font-family: 'JetBrains Mono', monospace; }
        .glass-panel { background: rgba(30, 41, 59, 0.7); backdrop-filter: blur(10px); border: 1px solid rgba(255, 255, 255, 0.05); }
        /* Animasi masuk */
        @keyframes slideIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        .animate-slide-in { animation: slideIn 0.3s ease-out forwards; }
    </style>
    <script>
        tailwind.config = { darkMode: 'class', theme: { extend: { colors: { primary: '#3b82f6' } } } }
    </script>
</head>
<body class="min-h-screen flex flex-col bg-[url('https://tailwindcss.com/_next/static/media/hero-dark.9a752424.jpg')] bg-cover bg-fixed">

    <nav class="border-b border-white/10 bg-slate-900/80 sticky top-0 z-50 backdrop-blur-md">
        <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div class="flex items-center justify-between h-16">
                <div class="flex items-center gap-3">
                    <div class="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center shadow-lg shadow-blue-500/30">
                        <svg class="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path></svg>
                    </div>
                    <span class="text-xl font-bold tracking-tight text-white">Bot<span class="text-blue-400">Commander</span></span>
                </div>
                <div class="flex bg-slate-800/50 p-1 rounded-lg border border-white/5">
                    <button onclick="switchTab('dashboard')" id="nav-dashboard" class="px-4 py-1.5 rounded-md text-sm font-medium transition-all">Live</button>
                    <button onclick="switchTab('history')" id="nav-history" class="px-4 py-1.5 rounded-md text-sm font-medium transition-all text-slate-400 hover:text-white">History</button>
                    <button onclick="handleLogout()" class="p-2 text-slate-400 hover:text-red-400 transition" title="Logout">
                        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                        </svg>
                    </button>
                </div>
                <div class="flex items-center gap-2">
                    <span id="socket-status" class="w-2 h-2 rounded-full bg-red-500 animate-pulse"></span>
                </div>
            </div>
        </div>
    </nav>

    <main class="flex-grow p-6 max-w-7xl mx-auto w-full">
        
        <div id="view-dashboard" class="space-y-6">
            <div class="flex justify-between items-end mb-6">
                <div>
                    <h2 class="text-3xl font-bold text-white tracking-tight">Validation Queue</h2>
                    <p class="text-slate-400 mt-1">Realtime monitoring & approval system.</p>
                </div>
            </div>

            <div class="glass-panel rounded-2xl overflow-hidden shadow-2xl">
                <table class="w-full text-left">
                    <thead class="bg-slate-900/50 text-slate-400 uppercase text-xs font-bold tracking-wider">
                        <tr>
                            <th class="p-5">Transaction ID</th>
                            <th class="p-5">BOT Name</th>
                            <th class="p-5">Validation Details</th>
                            <th class="p-5 text-right">Amount</th>
                            <th class="p-5 text-center">Decision</th>
                        </tr>
                    </thead>
                    <tbody id="validation-list" class="divide-y divide-white/5 text-sm">
                        </tbody>
                </table>
                <div id="empty-state" class="p-16 text-center hidden">
                    <div class="inline-flex items-center justify-center w-20 h-20 rounded-full bg-slate-800/50 mb-4 ring-1 ring-white/10">
                        <svg class="w-10 h-10 text-slate-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                    </div>
                    <h3 class="text-xl font-medium text-white">All Caught Up!</h3>
                    <p class="text-slate-500 mt-2">No pending validations at the moment.</p>
                </div>
            </div>
        </div>

        <div id="view-history" class="hidden space-y-6">
            <div class="flex justify-between items-center mb-6">
                <div>
                    <h2 class="text-3xl font-bold text-white tracking-tight">Transaction History</h2>
                    <p class="text-slate-400 mt-1">Showing data from the last 7 days.</p>
                </div>
                <button onclick="loadHistory()" class="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-white/10 transition">
                    <svg class="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>
                </button>
            </div>
            <div class="glass-panel rounded-2xl overflow-hidden shadow-xl">
                <table class="w-full text-left">
                    <thead class="bg-slate-900/50 text-slate-400 uppercase text-xs font-bold tracking-wider">
                        <tr>
                            <th class="p-5">Time</th>
                            <th class="p-5">ID & Alias</th>
                            <th class="p-5">Target</th>
                            <th class="p-5 text-right">Total</th>
                            <th class="p-5 text-center">Status</th>
                            <th class="p-5 text-center">Message</th>
                        </tr>
                    </thead>
                    <tbody id="history-list" class="divide-y divide-white/5 text-sm text-slate-300"></tbody>
                </table>
            </div>
        </div>
    </main>

    <div id="toast" class="fixed bottom-6 right-6 transform translate-y-24 opacity-0 transition-all duration-500 z-50">
        <div class="glass-panel p-4 rounded-xl shadow-2xl border-l-4 border-blue-500 flex items-center gap-4 min-w-[300px]">
            <div class="bg-blue-500/20 p-2 rounded-lg text-blue-400">
                <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"></path></svg>
            </div>
            <div>
                <h4 class="font-bold text-white">New Request!</h4>
                <p class="text-xs text-slate-400 font-mono mt-1" id="toast-msg">TRX-...</p>
            </div>
        </div>
    </div>

    <script>
        const socket = io();
        
        socket.on('connect', () => {
            document.getElementById('socket-status').classList.replace('bg-red-500', 'bg-green-500');
        });
        
        socket.on('disconnect', () => {
            document.getElementById('socket-status').classList.replace('bg-green-500', 'bg-red-500');
        });

        socket.on('new_validation', (data) => {
            addValidationRow(data);
            showToast(data.task_id);
        });

        socket.on('decision_updated', (data) => {
            const row = document.getElementById('row-' + data.task_id);
            if(row) {
                row.classList.add('opacity-0', '-translate-x-10');
                setTimeout(() => { row.remove(); checkEmpty(); }, 300);
            }
        });

        function handleLogout() {
            if(confirm('Apakah Anda yakin ingin logout?')) {
                // Redirect ke endpoint logout
                window.location.href = '/logout';
            }
        }

        function formatRupiah(num) {
            return new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(num);
        }

        function checkEmpty() {
            const isEmpty = document.getElementById('validation-list').children.length === 0;
            document.getElementById('empty-state').classList.toggle('hidden', !isEmpty);
        }

        async function init() {
            const res = await fetch('/api/pending-validations');
            const data = await res.json();
            document.getElementById('validation-list').innerHTML = '';
            if(data.length) data.forEach(addValidationRow);
            checkEmpty();
        }

        function addValidationRow(d) {
            checkEmpty();
            if(document.getElementById('row-' + d.task_id)) return;

            const tr = document.createElement('tr');
            tr.id = 'row-' + d.task_id;
            tr.className = 'animate-slide-in hover:bg-white/5 transition duration-200';
            
            // Hitung waktu
            const startTime = d.created_at ? new Date(d.created_at).getTime() : Date.now();
            const expiryTime = startTime + 60000;

            const isMatch = Math.abs(d.total_amount - d.original_amount) <= 6500;
            const amountClass = isMatch ? 'text-green-400' : 'text-amber-400';

            // GUNAKAN BACKSLASH (\) DI DEPAN SETIAP
            tr.innerHTML = \`
                <td class="p-5 align-top">
                    <div class="font-mono text-sm font-bold text-blue-400">\${d.task_id}</div>
                    <div class="text-xs text-slate-500 mt-1">\${moment(startTime).format('HH:mm:ss')}</div>
                    <div class="w-full bg-slate-700 h-1 mt-3 rounded-full overflow-hidden">
                        <div id="timer-bar-\${d.task_id}" class="bg-blue-500 h-full transition-all duration-1000" style="width: 100%"></div>
                    </div>
                </td>
                <td>
                    <div class="flex flex-col gap-1">
                        <span class="text-white font-semibold">\${d.alias}</span>
                    </div>
                </td>
                <td class="p-5 align-top">
                    <div class="flex flex-col gap-1">
                        <span class="text-white font-semibold">\${d.target_name_extracted}</span>
                        <div class="flex items-center gap-2 text-xs">
                            <span class="bg-blue-500/10 text-blue-400 px-2 py-0.5 rounded border border-blue-500/20">\${d.bank_name}</span>
                            <span class="font-mono text-slate-400">\${d.target_rek_extracted}</span>
                        </div>
                    </div>
                </td>
                <td class="p-5 align-top text-right">
                    <div class="text-lg font-bold \${amountClass}">\${formatRupiah(d.total_amount)}</div>
                    <div class="text-[10px] text-slate-500 mt-1">Sisa: <span id="timer-text-\${d.task_id}" class="font-mono">60s</span></div>
                </td>
                <td class="p-5 align-top text-center">
                    <div class="flex gap-2 justify-center">
                        <button onclick="decide('\${d.task_id}', 'PROCEED')" class="bg-green-600 hover:bg-green-500 text-white px-3 py-1.5 rounded-lg text-xs font-bold transition transform hover:scale-105">ACCEPT</button>
                        <button onclick="decide('\${d.task_id}', 'ABORT')" class="bg-slate-700 hover:bg-red-600 text-white px-3 py-1.5 rounded-lg text-xs font-bold transition transform hover:scale-105">REJECT</button>
                    </div>
                </td>
            \`;
            document.getElementById('validation-list').prepend(tr);
            
            // LOGIKA TIMER (PEMBERSIHAN SPASI ID)
            const timerInterval = setInterval(() => {
                const now = Date.now();
                const remaining = Math.round((expiryTime - now) / 1000);
                
                // Perhatikan: string di bawah ini tidak menggunakan \ karena berada di dalam script browser, bukan template literal Node.js
                const bar = document.getElementById('timer-bar-' + d.task_id);
                const text = document.getElementById('timer-text-' + d.task_id);

                if (!bar || !text || remaining <= 0) {
                    if(text) text.innerText = "EXPIRED";
                    if(bar) bar.style.width = "0%";
                    clearInterval(timerInterval);
                } else {
                    text.innerText = remaining + "s";
                    bar.style.width = (remaining / 60 * 100) + "%";
                    if(remaining < 15) {
                        bar.classList.remove('bg-blue-500');
                        bar.classList.add('bg-red-500');
                    }
                }
            }, 1000);
            checkEmpty();
        }

        async function loadHistory() {
            const res = await fetch('/api/history');
            const data = await res.json();
            const tbody = document.getElementById('history-list');
            tbody.innerHTML = '';
            
            data.forEach(r => {
                const statusBadge = r.status === 'SUCCESS' 
                    ? '<span class="px-2 py-1 bg-green-500/10 text-green-400 border border-green-500/20 rounded text-xs font-bold">SUCCESS</span>' 
                    : '<span class="px-2 py-1 bg-red-500/10 text-red-400 border border-red-500/20 rounded text-xs font-bold">FAILED</span>';

                const tr = document.createElement('tr');
                tr.className = 'hover:bg-white/5 transition';
                tr.innerHTML = \`
                    <td class="p-5 text-slate-400 text-xs whitespace-nowrap">\${moment(r.updated_at).format('DD MMM HH:mm')}</td>
                    <td class="p-5">
                        <div class="font-mono text-xs text-blue-300">\${r.id}</div>
                        <div class="text-[10px] text-slate-500 mt-0.5">\${r.bot_alias}</div>
                    </td>
                    <td class="p-5">
                        <div class="text-sm text-white">\${r.target_name_extracted || r.dest}</div>
                        <div class="font-mono text-[10px] text-slate-500">\${r.bank_name || '-'} | Ref: \${r.ref_number || '-'}</div>
                    </td>
                    <td class="p-5 text-right font-mono text-sm">\${formatRupiah(r.amount)}</td>
                    <td class="p-5 text-center">\${statusBadge}</td>
                    <td class="p-5 text-center">\${r.message}</td>
                \`;
                tbody.appendChild(tr);
            });
        }

        function decide(id, action) {
            if(!confirm('Confirm action?')) return;
            fetch('/update-decision', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ task_id: id, status: action })
            });
        }

        function switchTab(tab) {
            const dash = document.getElementById('view-dashboard');
            const hist = document.getElementById('view-history');
            const btnDash = document.getElementById('nav-dashboard');
            const btnHist = document.getElementById('nav-history');

            if(tab === 'dashboard') {
                dash.classList.remove('hidden'); hist.classList.add('hidden');
                btnDash.className = "px-4 py-1.5 rounded-md text-sm font-medium transition-all bg-blue-600 text-white shadow-lg shadow-blue-500/30";
                btnHist.className = "px-4 py-1.5 rounded-md text-sm font-medium transition-all text-slate-400 hover:text-white";
                init();
            } else {
                dash.classList.add('hidden'); hist.classList.remove('hidden');
                btnHist.className = "px-4 py-1.5 rounded-md text-sm font-medium transition-all bg-blue-600 text-white shadow-lg shadow-blue-500/30";
                btnDash.className = "px-4 py-1.5 rounded-md text-sm font-medium transition-all text-slate-400 hover:text-white";
                loadHistory();
            }
        }

        function showToast(id) {
            const t = document.getElementById('toast');
            document.getElementById('toast-msg').innerText = id;
            t.classList.remove('translate-y-24', 'opacity-0');
            setTimeout(() => t.classList.add('translate-y-24', 'opacity-0'), 4000);
        }

        // Boot
        switchTab('dashboard');
    </script>
</body>
</html>
    `;
}