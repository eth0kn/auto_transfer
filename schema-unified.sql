-- =============================================================
-- Schema: auto_transfer_db_unified
-- Version: v2 (unified, 2026-09-24)
-- Merge: brimo (:3005) + mybca (:3006) → unified (:3010)
-- Change vs legacy: tambah kolom `app_source` di transfer_request + transfer_validations
-- =============================================================

/*!40101 SET NAMES utf8mb4 */;
/*!40103 SET TIME_ZONE='+00:00' */;

-- =============================================================
-- Table: transfer_request
-- =============================================================
DROP TABLE IF EXISTS `transfer_validations`;
DROP TABLE IF EXISTS `transfer_request`;

CREATE TABLE `transfer_request` (
  `id` varchar(50) NOT NULL,
  `app_source` enum('brimo','mybca','seabank') NOT NULL DEFAULT 'brimo',
  `ref_number` varchar(50) DEFAULT NULL,
  `bot_alias` varchar(50) DEFAULT NULL,
  `bank_type` varchar(50) DEFAULT NULL,
  `dest` varchar(50) DEFAULT NULL,
  `amount` decimal(15,2) DEFAULT NULL,
  `pin` varchar(10) DEFAULT NULL,
  `status` enum('PENDING','PROCESSING','SUCCESS','FAILED') DEFAULT 'PENDING',
  `message` text,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_app_alias` (`app_source`, `bot_alias`),
  KEY `idx_app_status` (`app_source`, `status`),
  KEY `idx_app_created` (`app_source`, `created_at`),
  KEY `idx_status_updated` (`status`, `updated_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- =============================================================
-- Table: transfer_validations
-- =============================================================
CREATE TABLE `transfer_validations` (
  `task_id` varchar(50) NOT NULL,
  `app_source` enum('brimo','mybca','seabank') NOT NULL DEFAULT 'brimo',
  `device_id` varchar(50) DEFAULT NULL,
  `account_name` varchar(100) DEFAULT NULL,
  `target_name_extracted` varchar(100) DEFAULT NULL,
  `target_rek_extracted` varchar(50) DEFAULT NULL,
  `bank_name` varchar(50) DEFAULT NULL,
  `total_amount` decimal(15,2) DEFAULT NULL,
  `status` enum('WAITING','PROCEED','ABORT') DEFAULT 'WAITING',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`task_id`),
  KEY `idx_app_status` (`app_source`, `status`),
  KEY `idx_status_created` (`status`, `created_at`),
  CONSTRAINT `fk_validations_request`
    FOREIGN KEY (`task_id`) REFERENCES `transfer_request` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- =============================================================
-- Notes:
-- - `app_source` DEFAULT 'brimo' supaya legacy write yang TIDAK kirim app_source tetap works.
--   Post-migration selesai, boleh drop DEFAULT (ALTER TABLE).
-- - Index (`app_source`, `bot_alias`) untuk backlog dispatch query (per app per bot).
-- - Index (`app_source`, `status`) untuk stats card query (COUNT/SUM per app per status).
-- - Index (`app_source`, `created_at`) untuk history filter (per app + date range).
-- - Index (`status`, `updated_at`) untuk auto-cleanup interval (PROCESSING > 3 min).
-- - Timestamp storage UTC (TIME_ZONE='+00:00'), display convert client-side.
-- =============================================================
