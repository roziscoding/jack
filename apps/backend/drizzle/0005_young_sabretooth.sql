PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_downloads` (
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
	`attempts` integer DEFAULT 0 NOT NULL,
	`status` text NOT NULL,
	`started_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`completed_at` text,
	`error` text,
	`qb_category` text,
	`qb_source_server` text,
	CONSTRAINT "downloads_status_check" CHECK("__new_downloads"."status" in ('downloading', 'import_queued', 'imported', 'failed')),
	CONSTRAINT "downloads_expected_bytes_source_check" CHECK("__new_downloads"."expected_bytes_source" is null or "__new_downloads"."expected_bytes_source" in ('content_length', 'content_range', 'release_size'))
);
--> statement-breakpoint
INSERT INTO `__new_downloads`("id", "torrent_filename", "peer_id", "peer_name", "item_id", "filename", "dest_path", "part_path", "release_size", "release_json", "expected_bytes", "expected_bytes_source", "expected_bytes_mismatch", "downloaded_bytes", "attempts", "status", "started_at", "updated_at", "completed_at", "error", "qb_category", "qb_source_server") SELECT "id", "torrent_filename", "peer_id", "peer_name", "item_id", "filename", "dest_path", "part_path", "release_size", "release_json", "expected_bytes", "expected_bytes_source", "expected_bytes_mismatch", "downloaded_bytes", "attempts", CASE WHEN "status" = 'completed' THEN 'imported' ELSE "status" END, "started_at", "updated_at", "completed_at", "error", "qb_category", "qb_source_server" FROM `downloads`;--> statement-breakpoint
DROP TABLE `downloads`;--> statement-breakpoint
ALTER TABLE `__new_downloads` RENAME TO `downloads`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `downloads_status_idx` ON `downloads` (`status`);--> statement-breakpoint
CREATE INDEX `downloads_updated_at_idx` ON `downloads` (`updated_at`);