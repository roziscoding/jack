CREATE TABLE `uploads` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`peer_name` text NOT NULL,
	`peer_key_id` integer,
	`item_id` text NOT NULL,
	`filename` text NOT NULL,
	`total_bytes` integer NOT NULL,
	`range_start` integer DEFAULT 0 NOT NULL,
	`requested_bytes` integer NOT NULL,
	`sent_bytes` integer DEFAULT 0 NOT NULL,
	`duration_ms` integer,
	`status` text NOT NULL,
	`error` text,
	`started_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`finished_at` text,
	CONSTRAINT "uploads_status_check" CHECK("uploads"."status" in ('uploading', 'completed', 'aborted', 'unconfirmed'))
);
--> statement-breakpoint
CREATE INDEX `uploads_status_idx` ON `uploads` (`status`);--> statement-breakpoint
CREATE INDEX `uploads_started_at_idx` ON `uploads` (`started_at`);