CREATE TABLE `catalog_size_history` (
	`day` text NOT NULL,
	`source_id` text NOT NULL,
	`source_name` text NOT NULL,
	`titles` integer NOT NULL,
	`bytes` integer NOT NULL,
	PRIMARY KEY(`day`, `source_id`)
);
--> statement-breakpoint
ALTER TABLE `downloads` ADD `imported_at` text;