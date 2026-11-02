CREATE TABLE `own_catalog_releases` (
	`id` text PRIMARY KEY NOT NULL,
	`title_key` text NOT NULL,
	`media_type` text NOT NULL,
	`tmdb_id` integer,
	`imdb_id` text,
	`tvdb_id` integer,
	`season` integer,
	`episode` integer,
	`data` text NOT NULL,
	CONSTRAINT "own_catalog_releases_media_type_check" CHECK("own_catalog_releases"."media_type" in ('movie', 'tv'))
);
--> statement-breakpoint
CREATE INDEX `own_catalog_releases_title_key_idx` ON `own_catalog_releases` (`title_key`);--> statement-breakpoint
CREATE INDEX `own_catalog_releases_tmdb_id_idx` ON `own_catalog_releases` (`tmdb_id`);--> statement-breakpoint
CREATE INDEX `own_catalog_releases_imdb_id_idx` ON `own_catalog_releases` (`imdb_id`);--> statement-breakpoint
CREATE INDEX `own_catalog_releases_tvdb_id_idx` ON `own_catalog_releases` (`tvdb_id`);--> statement-breakpoint
CREATE TABLE `own_catalog_titles` (
	`title_key` text PRIMARY KEY NOT NULL,
	`media_type` text NOT NULL,
	`tmdb_id` integer,
	`imdb_id` text,
	`tvdb_id` integer,
	`title` text NOT NULL,
	`release_count` integer NOT NULL,
	`total_size` integer NOT NULL,
	`resolutions` text NOT NULL,
	`poster_url` text,
	`backdrop_url` text,
	`genres` text,
	`revision` integer NOT NULL,
	`deleted` integer DEFAULT false NOT NULL,
	CONSTRAINT "own_catalog_titles_media_type_check" CHECK("own_catalog_titles"."media_type" in ('movie', 'tv'))
);
--> statement-breakpoint
CREATE INDEX `own_catalog_titles_revision_idx` ON `own_catalog_titles` (`revision`);--> statement-breakpoint
CREATE TABLE `peer_catalog_sync` (
	`peer_id` text PRIMARY KEY NOT NULL,
	`revision` integer,
	`synced_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `peer_catalog_titles` (
	`peer_id` text NOT NULL,
	`title_key` text NOT NULL,
	`media_type` text NOT NULL,
	`tmdb_id` integer,
	`imdb_id` text,
	`tvdb_id` integer,
	`title` text NOT NULL,
	`release_count` integer NOT NULL,
	`total_size` integer NOT NULL,
	`resolutions` text NOT NULL,
	`poster_url` text,
	`backdrop_url` text,
	`genres` text,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`peer_id`, `title_key`),
	CONSTRAINT "peer_catalog_titles_media_type_check" CHECK("peer_catalog_titles"."media_type" in ('movie', 'tv'))
);
--> statement-breakpoint
CREATE TABLE `tmdb_metadata` (
	`media_type` text NOT NULL,
	`tmdb_id` integer NOT NULL,
	`data` text,
	`fetched_at` text NOT NULL,
	PRIMARY KEY(`media_type`, `tmdb_id`),
	CONSTRAINT "tmdb_metadata_media_type_check" CHECK("tmdb_metadata"."media_type" in ('movie', 'tv'))
);
