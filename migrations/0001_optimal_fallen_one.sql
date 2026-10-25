CREATE TABLE `promotions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`code` text,
	`name` text NOT NULL,
	`kind` text DEFAULT 'coupon' NOT NULL,
	`benefit_type` text NOT NULL,
	`benefit_value` integer NOT NULL,
	`min_subtotal_minor` integer DEFAULT 0 NOT NULL,
	`limit_plan_kinds` text DEFAULT '[]' NOT NULL,
	`limit_plan_ids` text DEFAULT '[]' NOT NULL,
	`first_purchase_only` integer DEFAULT 0 NOT NULL,
	`new_user_within_days` integer,
	`starts_at` text,
	`ends_at` text,
	`max_uses` integer,
	`max_uses_per_customer` integer DEFAULT 1 NOT NULL,
	`badge_label` text,
	`visible` integer DEFAULT 1 NOT NULL,
	`referrer_reward_type` text,
	`referrer_reward_value` real,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `promotions_code_unique` ON `promotions` (`code`);--> statement-breakpoint
CREATE INDEX `idx_promotions_status` ON `promotions` (`status`,`kind`);--> statement-breakpoint
CREATE TABLE `redemptions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`promotion_id` integer NOT NULL,
	`customer_id` integer NOT NULL,
	`order_id` integer NOT NULL,
	`discount_minor` integer DEFAULT 0 NOT NULL,
	`granted_json` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_redemptions_order_promo` ON `redemptions` (`promotion_id`,`order_id`);--> statement-breakpoint
CREATE INDEX `idx_redemptions_customer` ON `redemptions` (`customer_id`);--> statement-breakpoint
CREATE INDEX `idx_redemptions_promotion` ON `redemptions` (`promotion_id`);--> statement-breakpoint
CREATE TABLE `referrals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`customer_id` integer NOT NULL,
	`referrer_id` integer NOT NULL,
	`promotion_id` integer,
	`code` text NOT NULL,
	`rewarded_at` text,
	`reward_type` text,
	`reward_value` real,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_referrals_customer` ON `referrals` (`customer_id`);--> statement-breakpoint
CREATE INDEX `idx_referrals_referrer` ON `referrals` (`referrer_id`);--> statement-breakpoint
ALTER TABLE `customers` ADD `referral_code` text;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_customers_referral_code` ON `customers` (`referral_code`);--> statement-breakpoint
ALTER TABLE `orders` ADD `discount_minor` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `orders` ADD `promotion_id` integer;--> statement-breakpoint
ALTER TABLE `orders` ADD `entry` text;