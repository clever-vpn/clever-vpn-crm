CREATE TABLE `store_channels` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`platform` text NOT NULL,
	`endpoint` text,
	`identifier` text NOT NULL,
	`environment` text DEFAULT 'production' NOT NULL,
	`secret_enc` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`last_ok_at` text,
	`last_error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_store_channels_platform` ON `store_channels` (`platform`);