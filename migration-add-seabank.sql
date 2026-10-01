-- =============================================================
-- Migration: tambah 'seabank' ke app_source enum (unified backend)
-- Target: DB produksi `auto_transfer_db_unified` di VPS okta-prod (MySQL 8).
-- Jalankan SEBELUM restart backend unified (pm2) yang sudah ada APP_SOURCES += 'seabank'.
-- Tanpa ALTER ini, INSERT app_source='seabank' akan DITOLAK MySQL (strict enum).
-- Aman dijalankan sekali; ALTER MODIFY idempotent (hasil akhir sama).
-- =============================================================

ALTER TABLE `transfer_request`
  MODIFY `app_source` enum('brimo','mybca','seabank') NOT NULL DEFAULT 'brimo';

ALTER TABLE `transfer_validations`
  MODIFY `app_source` enum('brimo','mybca','seabank') NOT NULL DEFAULT 'brimo';

-- Verifikasi:
-- SHOW COLUMNS FROM transfer_request LIKE 'app_source';
-- SHOW COLUMNS FROM transfer_validations LIKE 'app_source';
