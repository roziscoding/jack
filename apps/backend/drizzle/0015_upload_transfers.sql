PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_uploads` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`transfer_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`peer_name` text NOT NULL,
	`peer_key_id` integer,
	`item_id` text NOT NULL,
	`filename` text NOT NULL,
	`total_bytes` integer NOT NULL,
	`range_start` integer,
	`sent_bytes` integer DEFAULT 0 NOT NULL,
	`duration_ms` integer,
	`status` text NOT NULL,
	`started_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`finished_at` text,
	CONSTRAINT "uploads_status_check" CHECK("__new_uploads"."status" in ('uploading', 'completed', 'unconfirmed'))
);
--> statement-breakpoint
INSERT INTO `__new_uploads`("id", "transfer_id", "idempotency_key", "peer_name", "peer_key_id", "item_id", "filename", "total_bytes", "range_start", "sent_bytes", "duration_ms", "status", "started_at", "updated_at", "finished_at") SELECT "id", lower(hex(randomblob(16))), 'legacy:' || "id", "peer_name", "peer_key_id", "item_id", "filename", "total_bytes", "range_start", "sent_bytes", "duration_ms", CASE WHEN "status" = 'aborted' THEN 'unconfirmed' ELSE "status" END, "started_at", "updated_at", "finished_at" FROM `uploads`;--> statement-breakpoint
DROP TABLE `uploads`;--> statement-breakpoint
ALTER TABLE `__new_uploads` RENAME TO `uploads`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `uploads_transfer_id_unique` ON `uploads` (`transfer_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uploads_idempotency_key_unique` ON `uploads` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `uploads_status_idx` ON `uploads` (`status`);--> statement-breakpoint
CREATE INDEX `uploads_started_at_idx` ON `uploads` (`started_at`);--> statement-breakpoint
ALTER TABLE `downloads` ADD `speed_bps` integer;