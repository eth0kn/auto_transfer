#!/usr/bin/env node
// scripts/add-user.js — CLI utility untuk tambah user dashboard
//
// Usage:
//   node scripts/add-user.js <username> <password>
//
// Contoh:
//   node scripts/add-user.js admin2 'AutoTF2026!!'
//
// Pattern:
//   - bcrypt hash password (cost 10)
//   - Insert ke table dashboard_users
//   - Username unique constraint → duplicate rejected
//
// Dipakai untuk:
//   - Seed initial users post-migration (existing env credential + new admin)
//   - Bootstrap rescue kalau admin lupa password (bisa buat admin baru)
//   - Admin tambah operator baru offline tanpa dashboard UI
//
// Gotcha: password visible di `ps aux` selama durasi process. Risk LOW (local
// admin SSH session only). Kalau butuh lebih secure, bisa add env var fallback
// atau stdin input — defer kalau user minta.

require('dotenv').config();
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');

const BCRYPT_COST = 10;

async function main() {
    const [, , username, password] = process.argv;
    if (!username || !password) {
        console.error('❌ Usage: node scripts/add-user.js <username> <password>');
        console.error('   Contoh: node scripts/add-user.js admin2 \'AutoTF2026!!\'');
        process.exit(1);
    }

    // Validasi minimum — same rules as /api/admin/users POST endpoint
    if (username.length < 3 || username.length > 100) {
        console.error('❌ Username length must be 3-100 chars');
        process.exit(1);
    }
    if (password.length < 6) {
        console.error('❌ Password length minimum 6 chars');
        process.exit(1);
    }

    const pool = mysql.createPool({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME || 'auto_transfer_db_unified',
        waitForConnections: true,
        connectionLimit: 1,
    });

    try {
        const hash = await bcrypt.hash(password, BCRYPT_COST);
        const [result] = await pool.execute(
            'INSERT INTO dashboard_users (username, password_hash) VALUES (?, ?)',
            [username, hash]
        );
        console.log(`✅ User '${username}' created (id=${result.insertId})`);
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
            console.error(`❌ Username '${username}' already exists`);
            process.exit(1);
        }
        if (err.code === 'ER_NO_SUCH_TABLE') {
            console.error('❌ Table dashboard_users tidak ada. Jalankan migration dulu:');
            console.error('   mysql -u <user> -p<pass> <db> < migrations/2026-11-21_add_dashboard_users.sql');
            process.exit(1);
        }
        console.error(`❌ Error: ${err.message}`);
        process.exit(1);
    } finally {
        await pool.end();
    }
}

main();
