CREATE TABLE `site_templates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tenant_id` text DEFAULT '' NOT NULL,
	`seq` integer NOT NULL,
	`version` text NOT NULL,
	`parent_sha` text DEFAULT '' NOT NULL,
	`sha` text NOT NULL,
	`engine` text NOT NULL,
	`schema_version` integer DEFAULT 1 NOT NULL,
	`files` integer NOT NULL,
	`bytes` integer NOT NULL,
	`created_by` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_site_templates_tenant_version` ON `site_templates` (`tenant_id`,`version`);--> statement-breakpoint
CREATE INDEX `idx_site_templates_tenant_sha` ON `site_templates` (`tenant_id`,`sha`);--> statement-breakpoint
ALTER TABLE `site_settings` ADD `template_version` text DEFAULT '' NOT NULL;