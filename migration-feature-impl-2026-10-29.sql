-- =============================================================
-- Migration: Feature Implementation 2026-10-29
-- Features:
--   F1 — Auto-approve toggle (global, DB-backed)
--   F2 — Transfer status endpoint (uses decision_source audit column)
--
-- Idempotent: safe to run multiple times (IF NOT EXISTS + ON DUPLICATE KEY).
-- Backward-compat: new column NULL for existing rows.
--
-- Rollback:
--   ALTER TABLE transfer_validations DROP COLUMN decision_source;
--   DROP TABLE app_config;
-- =============================================================

-- 1. Generic key-value config storage (future-proof for other feature flags)
CREATE TABLE IF NOT EXISTS `app_config` (
    `key` VARCHAR(100) NOT NULL,
    `value` VARCHAR(500) NOT NULL,
    `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 2. Seed default: auto-approve DISABLED by default (safe default — admin eksplisit enable)
INSERT INTO `app_config` (`key`, `value`) VALUES ('auto_approve_enabled', 'false')
ON DUPLICATE KEY UPDATE `value` = `value`;

-- 3. Audit column — tracks WHO approved each validation decision.
-- NULL for existing rows (backward-compat). Enum enforced for new writes.
-- - ADMIN   = dashboard admin clicked PROCEED/ABORT manually
-- - TIMEOUT = 60s timeout auto-ABORT (VALIDATION_TIMEOUT_MS)
-- - AUTO    = auto-approve global toggle was ON when validation came in
ALTER TABLE `transfer_validations`
ADD COLUMN `decision_source` ENUM('ADMIN','TIMEOUT','AUTO') NULL
AFTER `status`;

-- =============================================================
-- Verify:
--   SELECT * FROM app_config;
--     Expected: 1 row — auto_approve_enabled=false
--   DESCRIBE transfer_validations;
--     Expected: decision_source column present (ENUM, NULL)
-- =============================================================
