-- =============================================================
-- Migration: 2026-11-01_add_callback_fields.sql
-- Feature: Transfer Status Callback (v4.1.0)
-- Spec:    docs/feature-callback-2026-11-01.md
-- Decision D1=B, D4=C, D9=F1+F3 hybrid, D10=minimal payload
--
-- Scope: ALTER transfer_request — additive 10 kolom + 1 index.
--        Blue-green safe (zero drop/rename).
-- =============================================================

ALTER TABLE `transfer_request`
  ADD COLUMN `balance_after`             BIGINT       NULL     AFTER `message`,
  ADD COLUMN `balance_source`            ENUM('SCRAPED','COMPUTED','UNAVAILABLE')
                                                      NULL     AFTER `balance_after`,
  ADD COLUMN `callback_url`              TEXT         NULL     AFTER `balance_source`,
  ADD COLUMN `callback_secret`           VARCHAR(128) NULL     AFTER `callback_url`,
  ADD COLUMN `callback_status`           ENUM('NONE','PENDING','DELIVERED','DEAD')
                                                      NOT NULL DEFAULT 'NONE' AFTER `callback_secret`,
  ADD COLUMN `callback_attempts`         INT          NOT NULL DEFAULT 0 AFTER `callback_status`,
  ADD COLUMN `callback_last_error`       TEXT         NULL     AFTER `callback_attempts`,
  ADD COLUMN `callback_last_attempt_at`  TIMESTAMP    NULL     AFTER `callback_last_error`,
  ADD COLUMN `callback_next_attempt_at`  TIMESTAMP    NULL     AFTER `callback_last_attempt_at`,
  ADD COLUMN `callback_delivered_at`     TIMESTAMP    NULL     AFTER `callback_next_attempt_at`,
  ADD INDEX  `idx_callback_pending` (`callback_status`, `callback_next_attempt_at`);

-- Verify:
-- SHOW COLUMNS FROM transfer_request LIKE 'balance_%';
-- SHOW COLUMNS FROM transfer_request LIKE 'callback_%';
-- SHOW INDEX FROM transfer_request WHERE Key_name='idx_callback_pending';
