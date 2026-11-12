CREATE TABLE `site_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`kind` text DEFAULT 'content' NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`mime` text NOT NULL,
	`bytes` integer DEFAULT 0 NOT NULL,
	`sha256` text NOT NULL,
	`created_at` text DEFAULT '' NOT NULL,
	`deleted_at` text
);
