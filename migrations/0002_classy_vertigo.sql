CREATE TABLE `promotion_targets` (
	`promotion_id` integer NOT NULL,
	`customer_id` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_promotion_targets` ON `promotion_targets` (`promotion_id`,`customer_id`);--> statement-breakpoint
CREATE INDEX `idx_promotion_targets_customer` ON `promotion_targets` (`customer_id`);--> statement-breakpoint
ALTER TABLE `promotions` ADD `rewards_json` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `promotions` ADD `audience` text DEFAULT 'all' NOT NULL;--> statement-breakpoint
ALTER TABLE `promotions` ADD `audience_days` integer;--> statement-breakpoint
ALTER TABLE `promotions` ADD `cooldown_hours` integer;--> statement-breakpoint
-- 回填：老的「仅首单」布尔 → 新的人群枚举（0003 会删掉这一列）
UPDATE `promotions` SET `audience` = 'new' WHERE `first_purchase_only` = 1;