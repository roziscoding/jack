ALTER TABLE `downloads` ADD `error_code` text;--> statement-breakpoint
UPDATE `downloads`
SET `error_code` = CASE
  WHEN `last_operation` = 'import' AND `error` LIKE 'manual import failed after%' THEN 'IMPORT_TRIGGER_FAILED'
  WHEN `last_operation` = 'import' THEN 'IMPORT_REJECTED'
  WHEN `error` LIKE '%cancelled%' THEN 'CANCELLED'
  WHEN `error` LIKE 'superseded%' THEN 'SUPERSEDED'
  WHEN `error` LIKE 'stale download after Jack restart%' THEN 'STALE_AFTER_RESTART'
  WHEN `error` LIKE 'Incomplete file download%' THEN 'INCOMPLETE_DOWNLOAD'
  WHEN `error` LIKE 'Peer download stalled%' THEN 'IDLE_TIMEOUT'
  WHEN `error` LIKE 'Cannot verify download%' THEN 'UNKNOWN_SIZE'
  WHEN `error` LIKE 'Peer % not found' THEN 'PEER_NOT_FOUND'
  WHEN `error` LIKE 'Failed to download file from peer%' OR `error` LIKE 'Failed to resume download from peer%' THEN 'PEER_HTTP_ERROR'
  ELSE 'UNKNOWN_ERROR'
END
WHERE `status` = 'failed' AND `operation_failed` = true;
