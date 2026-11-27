-- v4.5.3 (2026-11-27) — Shadow persistence via app_config
--
-- Context: /shadow TG command previously in-memory only (reset on PM2 restart).
-- Owner activation (/shadow on|off|filter X) didn't persist. Aligned with
-- existing auto_approve_enabled pattern — DB-backed flag + in-memory cache
-- loaded at bot boot.
--
-- Idempotent — safe to re-run via deploy retry.
--
-- Rollback SQL (if needed):
--   DELETE FROM app_config WHERE `key` IN ('shadow_enabled', 'shadow_filter');
--
-- Pre-migration state snapshot: SELECT COUNT(*) FROM app_config;
--   Expected baseline: 1 row (auto_approve_enabled)
--   Post-migration:    3 rows (+ shadow_enabled, + shadow_filter)

INSERT INTO `app_config` (`key`, `value`) VALUES
    ('shadow_enabled', 'true'),
    ('shadow_filter',  'all')
ON DUPLICATE KEY UPDATE `key` = `key`;  -- preserve existing values (idempotent no-op)
