CREATE TABLE `site_pointer_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tenant_id` text DEFAULT '' NOT NULL,
	`from_n` integer,
	`to_n` integer NOT NULL,
	`reason` text NOT NULL,
	`created_by` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_site_pointer_log_tenant_at` ON `site_pointer_log` (`tenant_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `site_releases` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tenant_id` text DEFAULT '' NOT NULL,
	`seq` integer NOT NULL,
	`source_sha` text NOT NULL,
	`artifact_sha` text NOT NULL,
	`seed_sha` text DEFAULT '' NOT NULL,
	`files` integer NOT NULL,
	`bytes` integer NOT NULL,
	`idem_key` text DEFAULT '' NOT NULL,
	`created_by` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_site_releases_tenant_seq` ON `site_releases` (`tenant_id`,`seq`);--> statement-breakpoint
CREATE INDEX `idx_site_releases_tenant_source` ON `site_releases` (`tenant_id`,`source_sha`);--> statement-breakpoint
DROP TABLE `site_templates`;--> statement-breakpoint
DROP TABLE `site_versions`;--> statement-breakpoint
ALTER TABLE `site_settings` DROP COLUMN `template_version`;