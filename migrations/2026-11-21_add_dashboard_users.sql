-- Migration: dashboard_users table (multi-user auth)
-- Date: 2026-11-21
-- Context: Replaces single DASHBOARD_USER/DASHBOARD_PASS env credential with
-- DB-backed multi-user table. Env values WILL BE SEEDED as first user via
-- scripts/add-user.js post-migration.

CREATE TABLE IF NOT EXISTS dashboard_users (
  id INT PRIMARY KEY AUTO_INCREMENT,
  username VARCHAR(100) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,   -- bcrypt output (60-char typical, 255 for safety)
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_login_at TIMESTAMP NULL,
  disabled TINYINT(1) DEFAULT 0 NOT NULL,
  INDEX idx_username (username),
  INDEX idx_disabled (disabled)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Post-migration seed (run di okta-prod via `node scripts/add-user.js`):
--   1. node scripts/add-user.js "$DASHBOARD_USER" "$DASHBOARD_PASS"
--      (seed existing env credential sebagai user #1 — preserve existing access)
--   2. node scripts/add-user.js admin2 'AutoTF2026!!'
--      (seed user #2 per user request 2026-11-21)
--
-- Env DASHBOARD_USER + DASHBOARD_PASS boleh di-keep di .env (zero harm, tidak
-- di-consume setelah migration — login handler query DB). Boleh dihapus kalau
-- mau cleanup.
