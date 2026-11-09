CREATE TABLE `uploads` (
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
	CONSTRAINT "uploads_status_check" CHECK("uploads"."status" in ('uploading', 'completed', 'unconfirmed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uploads_transfer_id_unique` ON `uploads` (`transfer_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uploads_idempotency_key_unique` ON `uploads` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `uploads_status_idx` ON `uploads` (`status`);--> statement-breakpoint
CREATE INDEX `uploads_started_at_idx` ON `uploads` (`started_at`);--> statement-breakpoint
ALTER TABLE `downloads` ADD `speed_bps` integer;