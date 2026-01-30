require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 80;

app.use(cors());
app.use(express.json());

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

// --- 1. ADMIN: Buat Request Transfer (POST) ---
// Payload: { "alias": "Toko-A", "bank": "BRI", "dest": "Udin Sedunia", "amount": 50000, "pin": "123456" }
app.post('/transfer', async (req, res) => {
    try {
        // [REVISI] Menerima 'dest' (bisa nama atau nomor)
        const { alias, bank, dest, amount, pin } = req.body;

        if (!alias || !dest || !amount || !pin) {
            return res.status(400).json({ success: false, msg: "Data alias, dest, amount, pin wajib diisi" });
        }

        // [REVISI] Query ke tabel 'transfer_request' dan kolom 'dest'
        const sql = `INSERT INTO transfer_request (bot_alias, bank_type, dest, amount, pin, status) VALUES (?, ?, ?, ?, ?, 'PENDING')`;
        const [result] = await pool.execute(sql, [alias, bank || 'BRI', dest, amount, pin]);

        res.json({
            success: true,
            msg: "Request transfer berhasil masuk antrian",
            task_id: result.insertId
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, msg: err.message });
    }
});

// --- 2. BOT: Ambil Request (POST) ---
// Payload: { "alias": "Toko-A" }
app.post('/get-task', async (req, res) => {
    const { alias } = req.body;
    if (!alias) return res.status(400).json({ msg: "Alias required" });

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        // 1. Cari request terlama (FIFO) yg PENDING
        // [REVISI] Query tabel 'transfer_request'
        const [rows] = await connection.execute(
            `SELECT * FROM transfer_request 
             WHERE bot_alias = ? AND status = 'PENDING' 
             ORDER BY created_at ASC LIMIT 1 FOR UPDATE`,
            [alias]
        );

        if (rows.length === 0) {
            await connection.rollback();
            return res.json({ task_available: false });
        }

        const task = rows[0];

        // 2. Lock status jadi PROCESSING
        await connection.execute(
            `UPDATE transfer_request SET status = 'PROCESSING', updated_at = NOW() WHERE id = ?`,
            [task.id]
        );

        await connection.commit();

        console.log(`[DISPATCH] Request ID ${task.id} dikirim ke ${alias}`);

        // Kirim data ke Bot
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

// --- 3. BOT: Lapor Status (POST) ---
app.post('/update-task', async (req, res) => {
    try {
        const { task_id, status, message } = req.body;

        if (!['SUCCESS', 'FAILED'].includes(status)) {
            return res.status(400).json({ msg: "Invalid Status" });
        }

        // [REVISI] Update tabel 'transfer_request'
        await pool.execute(
            `UPDATE transfer_request SET status = ?, message = ?, updated_at = NOW() WHERE id = ?`,
            [status, message || '', task_id]
        );

        console.log(`[REPORT] Request ID ${task_id} -> ${status}`);
        res.json({ success: true });

    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false });
    }
});

// --- 4. SYSTEM: Auto-Reset Stuck Jobs (> 10 Menit) ---
setInterval(async () => {
    try {
        // [REVISI] Reset tabel 'transfer_request'
        const sql = `UPDATE transfer_request 
                     SET status = 'PENDING', message = 'Auto-reset: Timeout' 
                     WHERE status = 'PROCESSING' 
                     AND updated_at < (NOW() - INTERVAL 10 MINUTE)`;

        const [result] = await pool.execute(sql);

        if (result.affectedRows > 0) {
            console.log(`[CLEANUP] Mengembalikan ${result.affectedRows} request nyangkut ke PENDING.`);
        }
    } catch (err) {
        console.error("Cleanup Error:", err);
    }
}, 60000);

app.listen(PORT, () => {
    console.log(`🚀 Server Auto Transfer (DB: auto_transfer_db) running on Port ${PORT}`);
});