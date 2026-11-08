CREATE TABLE `site_versions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`seq` integer NOT NULL,
	`template` text NOT NULL,
	`template_version` text NOT NULL,
	`files` integer NOT NULL,
	`bytes` integer NOT NULL,
	`created_by` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_site_versions_seq` ON `site_versions` (`seq`);