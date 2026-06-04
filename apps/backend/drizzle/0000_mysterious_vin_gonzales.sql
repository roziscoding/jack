CREATE TABLE `downloads` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`torrent_filename` text NOT NULL,
	`peer_id` text NOT NULL,
	`peer_name` text NOT NULL,
	`item_id` text NOT NULL,
	`filename` text NOT NULL,
	`dest_path` text NOT NULL,
	`part_path` text NOT NULL,
	`release_size` integer NOT NULL,
	`release_json` text NOT NULL,
	`expected_bytes` integer,
	`expected_bytes_source` text,
	`expected_bytes_mismatch` integer DEFAULT false NOT NULL,
	`downloaded_bytes` integer DEFAULT 0 NOT NULL,
	`status` text NOT NULL,
	`started_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`completed_at` text,
	`error` text,
	CONSTRAINT "downloads_status_check" CHECK("downloads"."status" in ('downloading', 'completed', 'failed', 'import_queued')),
	CONSTRAINT "downloads_expected_bytes_source_check" CHECK("downloads"."expected_bytes_source" is null or "downloads"."expected_bytes_source" = 'content_length')
);
--> statement-breakpoint
CREATE INDEX `downloads_status_idx` ON `downloads` (`status`);--> statement-breakpoint
CREATE INDEX `downloads_updated_at_idx` ON `downloads` (`updated_at`);