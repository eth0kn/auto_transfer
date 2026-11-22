-- Migration: Add Telegram Bot tables (Sprint 1 Foundation)
-- Feature: Remote Admin via Telegram Bot
-- Concept: docs/feature_telegram_bot_concept_2026-11-21.md
-- Sprint 1: docs/feature_telegram_bot_sprint1_2026-11-22.md
-- Date: 2026-11-22
-- Idempotent: Yes (CREATE TABLE IF NOT EXISTS)

-- ==========================================================
-- Table 1: operators
-- Purpose: Operator identity (Telegram chat_id → access grant)
-- Owner is NOT in this table — hardcode .env OWNER_CHAT_ID
-- ==========================================================
CREATE TABLE IF NOT EXISTS operators (
    id INT AUTO_INCREMENT PRIMARY KEY,
    chat_id VARCHAR(50) NOT NULL UNIQUE,
    username VARCHAR(100),
    display_name VARCHAR(100),
    status ENUM('pending', 'approved', 'rejected', 'revoked') NOT NULL DEFAULT 'pending',
    approved_by VARCHAR(50),
    approved_at TIMESTAMP NULL,
    revoked_at TIMESTAMP NULL,
    allowed_rdp_hostnames JSON COMMENT 'Array of RDP hostnames operator can control, e.g. ["rdp-fajar-01"]. NULL = all approved RDPs.',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_active_at TIMESTAMP NULL,
    INDEX idx_status (status),
    INDEX idx_chat_id_status (chat_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==========================================================
-- Table 2: rdp_registry
-- Purpose: RDP identity (hostname → bind status)
-- Model C Auto-Sync: auto-INSERT pending on first bot:register from new hostname
-- Same-IP Relax: bound_ts_ip === current rdp_ts_ip → auto-approve (reinstall scenario)
-- ==========================================================
CREATE TABLE IF NOT EXISTS rdp_registry (
    rdp_hostname VARCHAR(100) PRIMARY KEY,
    last_ts_ip VARCHAR(50) COMMENT 'Most recent Tailscale IP reported by this RDP (for display)',
    bound_ts_ip VARCHAR(50) COMMENT 'Tailscale IP at time of approval. Used by Same-IP Relax on reinstall.',
    status ENUM('pending', 'approved', 'revoked') NOT NULL DEFAULT 'pending',
    approved_by VARCHAR(50) COMMENT 'Owner chat_id who approved, or "auto-same-ip-relax"',
    approved_at TIMESTAMP NULL,
    revoked_at TIMESTAMP NULL,
    first_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    note VARCHAR(255),
    INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==========================================================
-- Table 3: tg_audit_log
-- Purpose: Audit trail for every Telegram command (D3: all commands logged)
-- Retention: 90 days (D8 — cron purge TBD Sprint 2+)
-- ==========================================================
CREATE TABLE IF NOT EXISTS tg_audit_log (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    chat_id VARCHAR(50) NOT NULL,
    role ENUM('owner', 'operator', 'unknown') NOT NULL,
    cmd VARCHAR(100),
    args TEXT,
    result ENUM('success', 'denied', 'error', 'rejected') NOT NULL,
    error_message TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_chat_id (chat_id),
    INDEX idx_created_at (created_at),
    INDEX idx_cmd (cmd),
    INDEX idx_role_result (role, result)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==========================================================
-- Table 4: wizard_sessions
-- Purpose: Multi-step wizard state (Sprint 2+ `/add`, `/edit` Opsi C)
-- TTL: D4 15 menit — wizard timeout cleanup via cron
-- ==========================================================
CREATE TABLE IF NOT EXISTS wizard_sessions (
    chat_id VARCHAR(50) PRIMARY KEY,
    wizard_type VARCHAR(50) COMMENT 'e.g. "add-account", "edit-account"',
    state_json JSON,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_expires_at (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==========================================================
-- Verification: list new tables
-- Run after migration:
--   SHOW TABLES LIKE 'operators';
--   SHOW TABLES LIKE 'rdp_registry';
--   SHOW TABLES LIKE 'tg_audit_log';
--   SHOW TABLES LIKE 'wizard_sessions';
-- ==========================================================
