require('dotenv').config();
const express = require('express');
const http = require('http'); // Perlu module http native
const { Server } = require('socket.io'); // Import Socket.IO
const mysql = require('mysql2/promise');
const cors = require('cors');

const app = express();
const server = http.createServer(app); // Bungkus express app dengan http server
const io = new Server(server); // Init Socket.IO

const PORT = process.env.PORT || 3002;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- KONFIGURASI DATABASE ---
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

// ==========================================
// A. ENDPOINT UTAMA (LOGIC BOT)
// ==========================================

// 1. ADMIN: Buat Request Transfer
app.post('/transfer', async (req, res) => {
    try {
        const { alias, bank, dest, amount, pin } = req.body;
        if (!alias || !dest || !amount || !pin) {
            return res.status(400).json({ success: false, msg: "Data wajib diisi" });
        }
        const sql = `INSERT INTO transfer_request (bot_alias, bank_type, dest, amount, pin, status) VALUES (?, ?, ?, ?, ?, 'PENDING')`;
        const [result] = await pool.execute(sql, [alias, bank || 'BRI', dest, amount, pin]);
        res.json({ success: true, msg: "Request masuk antrian", task_id: result.insertId });
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
        await connection.execute(
            `UPDATE transfer_request SET status = 'PROCESSING', updated_at = NOW() WHERE id = ?`,
            [task.id]
        );
        await connection.commit();
        console.log(`[DISPATCH] Task ${task.id} -> Bot ${alias}`);
        res.json({
            task_available: true,
            task_id: task.id,
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
        let finalMessage = message;
        try {
            const msgObj = JSON.parse(message);
            if (msgObj.ref_number) refNumber = msgObj.ref_number;
        } catch (e) { }

        await pool.execute(
            `UPDATE transfer_request SET status = ?, message = ?, ref_number = ?, updated_at = NOW() WHERE id = ?`,
            [status, finalMessage, refNumber, task_id]
        );

        // Notify Dashboard: Task Completed
        io.emit('task_completed', { task_id, status });

        console.log(`[REPORT] Task ${task_id} -> ${status}`);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false });
    }
});

// ==========================================
// B. ENDPOINT VALIDASI (REALTIME)
// ==========================================

// 4. BOT: Kirim Data Konfirmasi Layar
app.post('/validate-confirmation', async (req, res) => {
    try {
        const d = req.body;
        await pool.execute(
            `INSERT INTO transfer_validations 
            (task_id, device_id, account_name, target_name_extracted, target_rek_extracted, bank_name, total_amount, status) 
            VALUES (?, ?, ?, ?, ?, ?, ?, 'WAITING') 
            ON DUPLICATE KEY UPDATE 
            status='WAITING', target_name_extracted=?, target_rek_extracted=?, updated_at=NOW()`,
            [d.task_id, d.device_id, d.account_name, d.account_name_extracted, d.account_number_extracted, d.bank_name, d.total_amount, d.account_name_extracted, d.account_number_extracted]
        );

        // Ambil data request asli untuk ditampilkan side-by-side
        const [reqData] = await pool.execute('SELECT amount, dest FROM transfer_request WHERE id = ?', [d.task_id]);

        // WEBSOCKET: Kirim notifikasi ke dashboard ada data baru
        const payload = {
            ...d,
            original_amount: reqData[0]?.amount || 0,
            original_dest: reqData[0]?.dest || '-',
            created_at: new Date()
        };
        io.emit('new_validation', payload);

        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message });
    }
});

// 5. BOT: Polling Keputusan Admin
app.get('/get-validation-decision/:task_id', async (req, res) => {
    try {
        const [rows] = await pool.execute('SELECT status FROM transfer_validations WHERE task_id = ?', [req.params.task_id]);
        const status = rows.length > 0 ? rows[0].status : 'WAITING';
        res.json({ action: status === 'WAITING' ? 'WAIT' : status });
    } catch (e) {
        res.json({ action: 'WAIT' });
    }
});

// 6. ADMIN: Update Keputusan
app.post('/update-decision', async (req, res) => {
    try {
        const { task_id, status } = req.body;
        await pool.execute('UPDATE transfer_validations SET status = ? WHERE task_id = ?', [status, task_id]);

        if (status === 'ABORT') {
            await pool.execute('UPDATE transfer_request SET status = "FAILED", message = "Rejected by Admin" WHERE id = ?', [task_id]);
        }

        // WEBSOCKET: Beritahu dashboard bahwa status berubah (hilangkan dari list)
        io.emit('decision_updated', { task_id, status });

        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ==========================================
// C. FRONTEND API & DASHBOARD
// ==========================================

// API: Ambil History Transaksi
app.get('/api/history', async (req, res) => {
    try {
        // Ambil 50 transaksi terakhir yang sudah selesai
        const [rows] = await pool.execute(`
            SELECT r.id, r.bot_alias, r.dest, r.amount, r.status, r.ref_number, r.updated_at,
                   v.target_name_extracted, v.bank_name
            FROM transfer_request r
            LEFT JOIN transfer_validations v ON r.id = v.task_id
            WHERE r.status IN ('SUCCESS', 'FAILED') AND r.updated_at >= (NOW() - INTERVAL 7 DAY)
            ORDER BY r.updated_at DESC LIMIT 50
        `);
        res.json(rows);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// API: Ambil Data Dashboard Awal (Saat refresh page)
app.get('/api/pending-validations', async (req, res) => {
    try {
        const [rows] = await pool.execute(`
            SELECT v.*, r.amount as original_amount, r.dest as original_dest
            FROM transfer_validations v 
            JOIN transfer_request r ON v.task_id = r.id 
            WHERE v.status = 'WAITING' 
            ORDER BY v.created_at DESC
        `);
        res.json(rows);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// SERVE HTML DASHBOARD
app.get(['/', '/dashboard', '/history'], (req, res) => {
    res.send(getHtmlUI());
});

// --- SYSTEM: Auto-Reset Stuck Jobs ---
setInterval(async () => {
    try {
        const sql = `UPDATE transfer_request SET status = 'PENDING', message = 'Auto-reset: Timeout' 
                     WHERE status = 'PROCESSING' AND updated_at < (NOW() - INTERVAL 10 MINUTE)`;
        await pool.execute(sql);
    } catch (err) { console.error("Cleanup Error:", err); }
}, 60000);

// Gunakan server.listen (bukan app.listen) untuk Socket.IO
server.listen(PORT, () => {
    console.log(`🚀 Server + WebSocket running on Port ${PORT}`);
});

// ==========================================
// D. FRONTEND TEMPLATE (HTML/CSS/JS)
// ==========================================
function getHtmlUI() {
    return `
<!DOCTYPE html>
<html lang="id" class="dark">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Transfer Command Center</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="/socket.io/socket.io.js"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/moment.js/2.29.4/moment.min.js"></script>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;700&display=swap" rel="stylesheet">
    <style>
        body { font-family: 'Inter', sans-serif; background-color: #0f172a; color: #e2e8f0; }
        .glass-panel { background: rgba(30, 41, 59, 0.7); backdrop-filter: blur(10px); border: 1px solid rgba(255, 255, 255, 0.1); }
        .btn-action { transition: all 0.2s; }
        .btn-action:active { transform: scale(0.95); }
        /* Custom Scrollbar */
        ::-webkit-scrollbar { width: 8px; }
        ::-webkit-scrollbar-track { background: #0f172a; }
        ::-webkit-scrollbar-thumb { background: #334155; border-radius: 4px; }
        ::-webkit-scrollbar-thumb:hover { background: #475569; }
    </style>
    <script>
        tailwind.config = {
            darkMode: 'class',
            theme: { extend: { colors: { primary: '#3b82f6', success: '#10b981', danger: '#ef4444', warning: '#f59e0b' } } }
        }
    </script>
</head>
<body class="min-h-screen flex flex-col">

    <nav class="border-b border-slate-800 bg-slate-900/80 sticky top-0 z-50 backdrop-blur-md">
        <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div class="flex items-center justify-between h-16">
                <div class="flex items-center gap-2">
                    <div class="w-8 h-8 bg-gradient-to-br from-blue-500 to-indigo-600 rounded-lg flex items-center justify-center font-bold text-white">B</div>
                    <span class="text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-400 to-indigo-400">BotCommander</span>
                </div>
                <div class="flex space-x-4">
                    <button onclick="switchTab('dashboard')" id="nav-dashboard" class="px-3 py-2 rounded-md text-sm font-medium text-white bg-slate-800 hover:bg-slate-700 transition">Live Validations</button>
                    <button onclick="switchTab('history')" id="nav-history" class="px-3 py-2 rounded-md text-sm font-medium text-slate-400 hover:text-white hover:bg-slate-800 transition">History</button>
                </div>
                <div class="flex items-center gap-2">
                    <div id="connection-status" class="w-2 h-2 rounded-full bg-red-500 animate-pulse"></div>
                    <span class="text-xs text-slate-500 font-mono">SOCKET</span>
                </div>
            </div>
        </div>
    </nav>

    <main class="flex-grow p-6 max-w-7xl mx-auto w-full">
        
        <div id="view-dashboard" class="space-y-6 animate-fade-in">
            <div class="flex justify-between items-end">
                <div>
                    <h2 class="text-2xl font-semibold text-white">Menunggu Persetujuan</h2>
                    <p class="text-slate-400 text-sm mt-1">Transaksi yang membutuhkan validasi manual dari Bot.</p>
                </div>
                <div class="bg-blue-900/30 border border-blue-800 rounded px-3 py-1">
                    <span class="text-xs text-blue-400 font-mono">REALTIME MODE</span>
                </div>
            </div>

            <div class="glass-panel rounded-xl overflow-hidden shadow-2xl">
                <table class="w-full text-left">
                    <thead class="bg-slate-800/50 text-slate-400 uppercase text-xs font-semibold tracking-wider">
                        <tr>
                            <th class="p-4">Task ID / Device</th>
                            <th class="p-4">Validasi Data (Layar vs Request)</th>
                            <th class="p-4 text-right">Nominal</th>
                            <th class="p-4 text-center">Aksi</th>
                        </tr>
                    </thead>
                    <tbody id="validation-list" class="divide-y divide-slate-800 text-sm">
                        </tbody>
                </table>
                <div id="empty-state" class="p-12 text-center hidden">
                    <div class="inline-flex items-center justify-center w-16 h-16 rounded-full bg-slate-800 mb-4">
                        <svg class="w-8 h-8 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg>
                    </div>
                    <h3 class="text-lg font-medium text-white">Semua Bersih</h3>
                    <p class="text-slate-500">Tidak ada antrian validasi saat ini.</p>
                </div>
            </div>
        </div>

        <div id="view-history" class="space-y-6 hidden animate-fade-in">
            <div class="flex justify-between items-center">
                <div>
                    <h2 class="text-2xl font-semibold text-white">Riwayat Transaksi</h2>
                    <p class="text-slate-400 text-sm mt-1">50 Transaksi terakhir yang telah selesai.</p>
                </div>
                <button onclick="loadHistory()" class="text-sm text-blue-400 hover:text-blue-300 flex items-center gap-1">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>
                    Refresh
                </button>
            </div>

            <div class="glass-panel rounded-xl overflow-hidden shadow-lg">
                <div class="overflow-x-auto">
                    <table class="w-full text-left">
                        <thead class="bg-slate-800/50 text-slate-400 uppercase text-xs font-semibold tracking-wider">
                            <tr>
                                <th class="p-4">Waktu</th>
                                <th class="p-4">ID & Bot</th>
                                <th class="p-4">Tujuan</th>
                                <th class="p-4">Ref No</th>
                                <th class="p-4 text-right">Nominal</th>
                                <th class="p-4 text-center">Status</th>
                            </tr>
                        </thead>
                        <tbody id="history-list" class="divide-y divide-slate-800 text-sm">
                            </tbody>
                    </table>
                </div>
            </div>
        </div>

    </main>

    <div id="toast" class="fixed bottom-5 right-5 transform translate-y-20 opacity-0 transition-all duration-300 z-50">
        <div class="bg-slate-800 border border-slate-700 shadow-xl rounded-lg p-4 flex items-center gap-3">
            <div class="text-green-400">
                <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"></path></svg>
            </div>
            <div>
                <h4 class="font-bold text-white text-sm">Validasi Baru!</h4>
                <p class="text-slate-400 text-xs" id="toast-msg">Task ID #123 masuk antrian.</p>
            </div>
        </div>
    </div>

    <script>
        const socket = io();
        
        // --- SOCKET EVENTS ---
        socket.on('connect', () => {
            document.getElementById('connection-status').classList.remove('bg-red-500');
            document.getElementById('connection-status').classList.add('bg-green-500');
        });

        socket.on('disconnect', () => {
            document.getElementById('connection-status').classList.remove('bg-green-500');
            document.getElementById('connection-status').classList.add('bg-red-500');
        });

        socket.on('new_validation', (data) => {
            addValidationRow(data);
            showToast(\`Task #\${data.task_id} Butuh validasi\`);
            playNotificationSound();
        });

        socket.on('decision_updated', (data) => {
            removeValidationRow(data.task_id);
        });

        socket.on('task_completed', (data) => {
            // Optional: Refresh history if open
            if(!document.getElementById('view-history').classList.contains('hidden')) {
                loadHistory();
            }
        });

        // --- CORE FUNCTIONS ---

        function formatRupiah(amount) {
            return new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(amount);
        }

        async function initDashboard() {
            const res = await fetch('/api/pending-validations');
            const data = await res.json();
            document.getElementById('validation-list').innerHTML = '';
            if(data.length === 0) toggleEmptyState(true);
            else {
                toggleEmptyState(false);
                data.forEach(addValidationRow);
            }
        }

        async function loadHistory() {
            const res = await fetch('/api/history');
            const data = await res.json();
            const tbody = document.getElementById('history-list');
            tbody.innerHTML = '';
            
            data.forEach(row => {
                const statusColor = row.status === 'SUCCESS' ? 'text-green-400 bg-green-900/20 border-green-800' : 'text-red-400 bg-red-900/20 border-red-800';
                
                const tr = document.createElement('tr');
                tr.className = 'hover:bg-slate-800/50 transition';
                tr.innerHTML = \`
                    <td class="p-4 text-slate-400 whitespace-nowrap">\${moment(row.updated_at).format('DD MMM HH:mm')}</td>
                    <td class="p-4">
                        <div class="font-bold text-white">\${row.id}</div>
                        <div class="text-xs text-blue-400">\${row.bot_alias || 'General'}</div>
                    </td>
                    <td class="p-4">
                        <div class="text-slate-200">\${row.target_name_extracted || '-'}</div>
                        <div class="text-xs text-slate-500">\${row.dest}</div>
                    </td>
                    <td class="p-4 font-mono text-slate-300 text-xs">\${row.ref_number || '-'}</td>
                    <td class="p-4 text-right font-bold text-slate-200">\${formatRupiah(row.amount)}</td>
                    <td class="p-4 text-center">
                        <span class="px-2 py-1 rounded text-xs font-bold border \${statusColor}">\${row.status}</span>
                    </td>
                \`;
                tbody.appendChild(tr);
            });
        }

        function addValidationRow(data) {
            toggleEmptyState(false);
            const tbody = document.getElementById('validation-list');
            
            // Check duplicat
            if(document.getElementById(\`task-\${data.task_id}\`)) return;

            const tr = document.createElement('tr');
            tr.id = \`task-\${data.task_id}\`;
            tr.className = 'animate-pulse-once bg-slate-800/30 border-b border-slate-700 hover:bg-slate-700/30 transition';
            
            // Highlight jika nominal beda
            const amountWarning = data.total_amount != data.original_amount 
                ? '<span class="text-xs text-red-400 block mt-1">⚠ Beda dengan Request</span>' 
                : '';

            tr.innerHTML = \`
                <td class="p-4">
                    <div class="font-bold text-lg text-blue-400">#\${data.task_id}</div>
                    <div class="text-xs text-slate-500">\${data.device_id}</div>
                    <div class="text-xs text-slate-400 italic">\${data.account_name}</div>
                </td>
                <td class="p-4">
                    <div class="bg-slate-900/50 p-3 rounded border border-slate-700">
                        <div class="flex justify-between mb-1">
                            <span class="text-xs text-slate-500 uppercase">Layar HP:</span>
                            <span class="text-xs text-slate-500 uppercase">Request API:</span>
                        </div>
                        <div class="flex justify-between items-center gap-4">
                            <div>
                                <div class="font-bold text-white">\${data.target_name_extracted}</div>
                                <div class="text-xs text-blue-300">\${data.bank_name} - \${data.target_rek_extracted}</div>
                            </div>
                            <div class="text-right">
                                <div class="font-mono text-slate-300">\${data.original_dest}</div>
                            </div>
                        </div>
                    </div>
                </td>
                <td class="p-4 text-right">
                    <div class="font-bold text-xl text-green-400">\${formatRupiah(data.total_amount)}</div>
                    <div class="text-xs text-slate-500">Req: \${formatRupiah(data.original_amount)}</div>
                    \${amountWarning}
                </td>
                <td class="p-4 text-center">
                    <div class="flex gap-2 justify-center">
                        <button onclick="sendDecision('\${data.task_id}', 'PROCEED')" class="btn-action bg-green-600 hover:bg-green-500 text-white px-4 py-2 rounded shadow-lg shadow-green-900/20 font-bold flex items-center gap-1">
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg>
                            APPROVE
                        </button>
                        <button onclick="sendDecision('\${data.task_id}', 'ABORT')" class="btn-action bg-slate-700 hover:bg-red-600 text-white px-4 py-2 rounded shadow font-bold flex items-center gap-1 group">
                            <svg class="w-4 h-4 group-hover:rotate-90 transition" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                            REJECT
                        </button>
                    </div>
                </td>
            \`;
            
            tbody.prepend(tr);
        }

        function removeValidationRow(taskId) {
            const row = document.getElementById(\`task-\${taskId}\`);
            if (row) {
                row.style.opacity = '0';
                setTimeout(() => {
                    row.remove();
                    if(document.getElementById('validation-list').children.length === 0) toggleEmptyState(true);
                }, 300);
            }
        }

        function sendDecision(id, action) {
            if(!confirm(\`Konfirmasi \${action} untuk Task #\${id}?\`)) return;
            
            // UI Feedback Immediate
            const row = document.getElementById(\`task-\${id}\`);
            if(row) row.classList.add('opacity-50', 'pointer-events-none');

            fetch('/update-decision', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ task_id: id, status: action })
            }).catch(e => {
                alert('Gagal mengirim keputusan');
                if(row) row.classList.remove('opacity-50', 'pointer-events-none');
            });
        }

        // --- UI UTILS ---
        function switchTab(tab) {
            const dashView = document.getElementById('view-dashboard');
            const histView = document.getElementById('view-history');
            const navDash = document.getElementById('nav-dashboard');
            const navHist = document.getElementById('nav-history');

            if (tab === 'dashboard') {
                dashView.classList.remove('hidden');
                histView.classList.add('hidden');
                navDash.classList.add('bg-slate-800', 'text-white');
                navDash.classList.remove('text-slate-400');
                navHist.classList.remove('bg-slate-800', 'text-white');
                navHist.classList.add('text-slate-400');
                initDashboard();
            } else {
                dashView.classList.add('hidden');
                histView.classList.remove('hidden');
                navHist.classList.add('bg-slate-800', 'text-white');
                navHist.classList.remove('text-slate-400');
                navDash.classList.remove('bg-slate-800', 'text-white');
                navDash.classList.add('text-slate-400');
                loadHistory();
            }
        }

        function toggleEmptyState(show) {
            const el = document.getElementById('empty-state');
            if(show) el.classList.remove('hidden');
            else el.classList.add('hidden');
        }

        function showToast(msg) {
            const toast = document.getElementById('toast');
            document.getElementById('toast-msg').innerText = msg;
            toast.classList.remove('translate-y-20', 'opacity-0');
            setTimeout(() => {
                toast.classList.add('translate-y-20', 'opacity-0');
            }, 3000);
        }

        function playNotificationSound() {
            // Simple beep logic if needed, or leave blank to avoid browser blocking
        }

        // Init
        initDashboard();

    </script>
</body>
</html>
    `;
}