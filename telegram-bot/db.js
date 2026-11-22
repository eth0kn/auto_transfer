// Telegram Bot — DB Pool (reuse backend DB_* env)
// Sprint 1: shared .env at /var/automate/auto_transfer/.env
// Pool separate from unified-backend process (own connection pool, same DB)

const mysql = require('mysql2/promise');

const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'auto_transfer_db_unified',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

module.exports = { pool };
