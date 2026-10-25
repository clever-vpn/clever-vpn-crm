CREATE TABLE `promotion_codes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`promotion_id` integer NOT NULL,
	`code` text NOT NULL,
	`batch_id` text,
	`max_uses` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`expires_at` text,
	`note` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `promotion_codes_code_unique` ON `promotion_codes` (`code`);--> statement-breakpoint
CREATE INDEX `idx_promotion_codes_promotion` ON `promotion_codes` (`promotion_id`);--> statement-breakpoint
CREATE INDEX `idx_promotion_codes_batch` ON `promotion_codes` (`batch_id`);--> statement-breakpoint
ALTER TABLE `redemptions` ADD `code_id` integer;--> statement-breakpoint
CREATE INDEX `idx_redemptions_code` ON `redemptions` (`code_id`);