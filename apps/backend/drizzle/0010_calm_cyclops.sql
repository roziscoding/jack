ALTER TABLE `downloads` ADD `last_operation` text DEFAULT 'transfer' NOT NULL;--> statement-breakpoint
ALTER TABLE `downloads` ADD `operation_failed` integer DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE `downloads`
SET `last_operation` = CASE
  WHEN `completed_at` IS NOT NULL OR `status` IN ('import_queued', 'imported') THEN 'import'
  ELSE 'transfer'
END,
`operation_failed` = CASE WHEN `status` = 'failed' THEN true ELSE false END;
