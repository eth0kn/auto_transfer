require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 3002; // Port disesuaikan dengan bot

app.use(cors());
app.use(express.json());
// app.use(express.urlencoded({ extended: true })); // Support form data

// --- KONFIGURASI DATABASE ---
const dbConfig = {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '', // Isi password DB Anda
    database: process.env.DB_NAME || 'auto_transfer_db',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
};

const pool = mysql.createPool(dbConfig);

// ==========================================
// A. ENDPOINT UTAMA (EXISTING LOGIC)
// ==========================================

// 1. ADMIN: Buat Request Transfer (POST)
app.post('/transfer', async (req, res) => {
    try {
        const { alias, bank, dest, amount, pin } = req.body;
        if (!alias || !dest || !amount || !pin) {
            return res.status(400).json({ success: false, msg: "Data wajib diisi" });
        }

        const sql = `INSERT INTO transfer_request (bot_alias, bank_type, dest, amount, pin, status) VALUES (?, ?, ?, ?, ?, 'PENDING')`;
        const [result] = await pool.execute(sql, [alias, bank || 'BRI', dest, amount, pin]);

        res.json({
            success: true,
            msg: "Request masuk antrian",
            task_id: result.insertId
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, msg: err.message });
    }
});

// 2. BOT: Ambil Request (POST)
app.post('/get-task', async (req, res) => {
    const { alias } = req.body;
    // Jika alias kosong, kita anggap bot general, atau reject (tergantung kebutuhan).
    // Di sini saya ubah agar fleksibel: jika bot tidak kirim alias, dia bisa ambil task tanpa alias.

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        // Cari request PENDING. Prioritas: Alias cocok ATAU Alias NULL (General Task)
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

        // Lock status jadi PROCESSING
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

// 3. BOT: Lapor Status Akhir (POST)
app.post('/update-task', async (req, res) => {
    try {
        const { task_id, status, message } = req.body;

        if (!['SUCCESS', 'FAILED'].includes(status)) {
            return res.status(400).json({ msg: "Invalid Status" });
        }

        await pool.execute(
            `UPDATE transfer_request SET status = ?, message = ?, updated_at = NOW() WHERE id = ?`,
            [status, message || '', task_id]
        );

        console.log(`[REPORT] Task ${task_id} -> ${status}`);
        res.json({ success: true });

    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false });
    }
});

// ==========================================
// B. ENDPOINT VALIDASI & DASHBOARD (NEW)
// ==========================================

// 4. BOT: Kirim Data Konfirmasi Layar (POST)
app.post('/validate-confirmation', async (req, res) => {
    try {
        const d = req.body;
        console.log(`[VALIDASI] Masuk data konfirmasi Task ${d.task_id}`);

        // Insert atau Update ke tabel validasi
        // task_id di sini merujuk ke id di transfer_request
        await pool.execute(
            `INSERT INTO transfer_validations 
            (task_id, device_id, account_name, target_name_extracted, target_rek_extracted, bank_name, total_amount, status) 
            VALUES (?, ?, ?, ?, ?, ?, ?, 'WAITING') 
            ON DUPLICATE KEY UPDATE 
            status='WAITING', target_name_extracted=?, target_rek_extracted=?, updated_at=NOW()`,
            [d.task_id, d.device_id, d.account_name, d.account_name_extracted, d.account_number_extracted, d.bank_name, d.total_amount, d.account_name_extracted, d.account_number_extracted]
        );
        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message });
    }
});

// 5. BOT: Polling Keputusan Admin (GET)
app.get('/get-validation-decision/:task_id', async (req, res) => {
    try {
        const [rows] = await pool.execute('SELECT status FROM transfer_validations WHERE task_id = ?', [req.params.task_id]);

        // Jika data belum masuk atau status WAITING, suruh bot nunggu
        const status = rows.length > 0 ? rows[0].status : 'WAITING';
        res.json({ action: status === 'WAITING' ? 'WAIT' : status });
    } catch (e) {
        res.json({ action: 'WAIT' });
    }
});

// 6. ADMIN: Update Keputusan (POST)
app.post('/update-decision', async (req, res) => {
    try {
        const { task_id, status } = req.body; // status: 'PROCEED' or 'ABORT'
        await pool.execute('UPDATE transfer_validations SET status = ? WHERE task_id = ?', [status, task_id]);

        // Opsional: Jika ABORT, kita juga bisa set status utama jadi FAILED
        if (status === 'ABORT') {
            await pool.execute('UPDATE transfer_request SET status = "FAILED", message = "Rejected by Admin" WHERE id = ?', [task_id]);
        }

        console.log(`[DECISION] Task ${task_id} -> ${status}`);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 7. ADMIN: Halaman Dashboard (HTML)
app.get('/dashboard', async (req, res) => {
    try {
        // Join tabel validation dengan tabel request untuk info lengkap
        const [rows] = await pool.execute(`
            SELECT v.*, r.amount as original_amount, r.dest 
            FROM transfer_validations v 
            JOIN transfer_request r ON v.task_id = r.id 
            WHERE v.status = 'WAITING' 
            ORDER BY v.created_at DESC
        `);

        let htmlRows = rows.map(r => `
            <tr class="hover:bg-gray-50 border-b">
                <td class="p-4 font-bold text-gray-700">${r.task_id}</td>
                <td class="p-4">
                    <div class="font-semibold">${r.target_name_extracted}</div>
                    <div class="text-xs text-blue-600">${r.bank_name} - ${r.target_rek_extracted}</div>
                    <div class="text-xs text-gray-400">Request: ${r.dest}</div>
                </td>
                <td class="p-4">
                    <div class="font-bold text-green-700">Rp ${Number(r.total_amount).toLocaleString('id-ID')}</div>
                    <div class="text-xs text-gray-500">Limit: Rp ${Number(r.original_amount).toLocaleString('id-ID')}</div>
                </td>
                <td class="p-4 text-center">
                    <button onclick="decide(${r.task_id}, 'PROCEED')" class="bg-green-500 hover:bg-green-600 text-white px-4 py-2 rounded shadow mr-2 font-bold">✓ APPROVE</button>
                    <button onclick="decide(${r.task_id}, 'ABORT')" class="bg-red-500 hover:bg-red-600 text-white px-4 py-2 rounded shadow font-bold">✕ REJECT</button>
                </td>
            </tr>
        `).join('');

        if (rows.length === 0) htmlRows = `<tr><td colspan="4" class="p-8 text-center text-gray-400">Tidak ada antrian validasi.</td></tr>`;

        const html = `
        <!DOCTYPE html>
        <html>
        <head>
            <title>Validation Dashboard</title>
            <meta http-equiv="refresh" content="3">
            <script src="https://cdn.tailwindcss.com"></script>
        </head>
        <body class="bg-gray-100 min-h-screen p-8">
            <div class="max-w-5xl mx-auto bg-white rounded-xl shadow-lg overflow-hidden">
                <div class="bg-blue-700 p-6">
                    <h1 class="text-2xl font-bold text-white">🛡️ Transfer Validation Center</h1>
                </div>
                <table class="w-full text-left border-collapse">
                    <thead class="bg-gray-50 text-gray-600 uppercase text-sm">
                        <tr>
                            <th class="p-4">ID</th>
                            <th class="p-4">Penerima (Layar vs Request)</th>
                            <th class="p-4">Nominal</th>
                            <th class="p-4 text-center">Action</th>
                        </tr>
                    </thead>
                    <tbody>${htmlRows}</tbody>
                </table>
            </div>
            <script>
                function decide(id, action) {
                    if(!confirm('Konfirmasi ' + action + ' untuk Task ' + id + '?')) return;
                    fetch('/update-decision', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({ task_id: id, status: action })
                    }).then(() => location.reload());
                }
            </script>
        </body>
        </html>`;

        res.send(html);
    } catch (e) {
        res.status(500).send(e.message);
    }
});

// --- SYSTEM: Auto-Reset Stuck Jobs (> 10 Menit) ---
setInterval(async () => {
    try {
        const sql = `UPDATE transfer_request
                     SET status = 'PENDING', message = 'Auto-reset: Timeout'
                     WHERE status = 'PROCESSING'
                     AND updated_at < (NOW() - INTERVAL 10 MINUTE)`;
        const [result] = await pool.execute(sql);
        if (result.affectedRows > 0) {
            console.log(`[CLEANUP] Reset ${result.affectedRows} jobs.`);
        }
    } catch (err) {
        console.error("Cleanup Error:", err);
    }
}, 60000);

app.listen(PORT, () => {
    console.log(`🚀 Server Combined running on Port ${PORT}`);
    console.log(`📊 Dashboard: http://localhost:${PORT}/dashboard`);
});