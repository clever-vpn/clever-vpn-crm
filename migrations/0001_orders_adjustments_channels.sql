CREATE TABLE `adjustments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`customer_id` integer NOT NULL,
	`subscription_id` integer,
	`at` text NOT NULL,
	`field` text NOT NULL,
	`delta` text,
	`before_value` text,
	`after_value` text,
	`reason` text NOT NULL,
	`operator` text NOT NULL,
	`platform_applied_at` text,
	`platform_error` text
);
--> statement-breakpoint
CREATE INDEX `idx_adjustments_customer` ON `adjustments` (`customer_id`,`id`);--> statement-breakpoint
CREATE INDEX `idx_adjustments_sub` ON `adjustments` (`subscription_id`,`id`);--> statement-breakpoint
CREATE TABLE `orders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`code` text NOT NULL,
	`customer_id` integer NOT NULL,
	`plan_id` text NOT NULL,
	`kind` text NOT NULL,
	`plan_snapshot` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`currency` text DEFAULT 'CNY' NOT NULL,
	`source` text DEFAULT 'purchase' NOT NULL,
	`channel` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`subscription_id` integer,
	`external_id` text,
	`refunded_minor` integer DEFAULT 0 NOT NULL,
	`voided_at` text,
	`refund_mode` text,
	`refund_reason` text,
	`paid_at` text,
	`provisioned_at` text,
	`provision_attempts` integer DEFAULT 0 NOT NULL,
	`provision_error` text,
	`note` text,
	`operator` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `orders_code_unique` ON `orders` (`code`);--> statement-breakpoint
CREATE INDEX `idx_orders_customer` ON `orders` (`customer_id`,`id`);--> statement-breakpoint
CREATE INDEX `idx_orders_status` ON `orders` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_orders_external` ON `orders` (`channel`,`external_id`);--> statement-breakpoint
CREATE TABLE `payment_channels` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`currency` text DEFAULT 'CNY' NOT NULL,
	`fee_bps` integer DEFAULT 0 NOT NULL,
	`config` text DEFAULT '{}' NOT NULL,
	`webhook_path` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_channels_type` ON `payment_channels` (`type`);--> statement-breakpoint
CREATE TABLE `refunds` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer NOT NULL,
	`amount_minor` integer NOT NULL,
	`mode` text NOT NULL,
	`reason` text,
	`operator` text NOT NULL,
	`at` text NOT NULL,
	`channel_refund_id` text,
	`status` text DEFAULT 'done' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_refunds_order` ON `refunds` (`order_id`,`id`);--> statement-breakpoint
ALTER TABLE `customers` ADD `cf_customer_id` integer;--> statement-breakpoint
ALTER TABLE `plans` ADD `visibility` text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE `platform_subscriptions` ADD `order_id` integer;--> statement-breakpoint
ALTER TABLE `platform_subscriptions` ADD `params_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `platform_subscriptions` ADD `revoked_at` text;--> statement-breakpoint
ALTER TABLE `platform_subscriptions` ADD `revoke_reason` text;--> statement-breakpoint
CREATE INDEX `idx_subs_order` ON `platform_subscriptions` (`order_id`);