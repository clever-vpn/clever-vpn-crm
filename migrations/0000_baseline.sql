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
CREATE TABLE `admin_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`pending` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`last_used_at` text NOT NULL,
	`ip` text,
	`user_agent` text
);
--> statement-breakpoint
CREATE INDEX `idx_admin_sessions_user` ON `admin_sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `admin_users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`email` text NOT NULL,
	`password_hash` text NOT NULL,
	`totp_secret` text,
	`totp_enabled` integer DEFAULT 0 NOT NULL,
	`failed_attempts` integer DEFAULT 0 NOT NULL,
	`locked_until` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `admin_users_email_unique` ON `admin_users` (`email`);--> statement-breakpoint
CREATE TABLE `app_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_id` integer NOT NULL,
	`created_at` text NOT NULL,
	`last_used_at` text NOT NULL,
	`revoked_at` text,
	`app_id` text,
	`ip` text,
	`user_agent` text
);
--> statement-breakpoint
CREATE INDEX `idx_app_sessions_customer` ON `app_sessions` (`customer_id`);--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` text NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`target` text,
	`detail` text
);
--> statement-breakpoint
CREATE INDEX `idx_audit_log_at` ON `audit_log` (`at`);--> statement-breakpoint
CREATE TABLE `customers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`email` text NOT NULL,
	`password_hash` text,
	`display_name` text,
	`status` text DEFAULT 'active' NOT NULL,
	`cf_customer_id` integer,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `customers_email_unique` ON `customers` (`email`);--> statement-breakpoint
CREATE TABLE `email_codes` (
	`email` text PRIMARY KEY NOT NULL,
	`code_hash` text NOT NULL,
	`purpose` text DEFAULT 'login' NOT NULL,
	`sent_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
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
	`payment_method` text NOT NULL,
	`gateway_id` integer,
	`provider_order_no` text,
	`provider_trade_no` text,
	`pay_url` text,
	`raw_create` text,
	`raw_notify` text,
	`expires_at` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`subscription_id` integer,
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
CREATE UNIQUE INDEX `orders_provider_order_no_unique` ON `orders` (`provider_order_no`);--> statement-breakpoint
CREATE INDEX `idx_orders_customer` ON `orders` (`customer_id`,`id`);--> statement-breakpoint
CREATE INDEX `idx_orders_status` ON `orders` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_orders_gateway` ON `orders` (`gateway_id`,`status`);--> statement-breakpoint
CREATE TABLE `payment_gateways` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`driver` text NOT NULL,
	`name` text NOT NULL,
	`endpoint` text,
	`merchant_id` text,
	`secret_enc` text,
	`methods` text DEFAULT '[]' NOT NULL,
	`mapping` text,
	`priority` integer DEFAULT 100 NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`allowed_emails` text,
	`currency` text DEFAULT 'CNY' NOT NULL,
	`last_test_order_id` integer,
	`last_ok_at` text,
	`last_error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_gateways_route` ON `payment_gateways` (`status`,`priority`);--> statement-breakpoint
CREATE TABLE `plans` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`price_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`licence_limit` integer NOT NULL,
	`term_days` integer,
	`monthly_quota_gb` real,
	`traffic_gb` real,
	`validity_days` integer,
	`line_ids` text DEFAULT '[]' NOT NULL,
	`up_mbps` integer,
	`down_mbps` integer,
	`sales_channels` text DEFAULT '[]' NOT NULL,
	`store_product_id` text DEFAULT '{}' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`visibility` text DEFAULT 'public' NOT NULL,
	`retired_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_plans_status` ON `plans` (`status`,`sort_order`);--> statement-breakpoint
CREATE TABLE `platform_subscriptions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`customer_id` integer NOT NULL,
	`order_id` integer,
	`plan_id` text NOT NULL,
	`kind` text NOT NULL,
	`hold` text DEFAULT 'none' NOT NULL,
	`hold_reason` text,
	`hold_at` text,
	`paid_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`licence_limit` integer NOT NULL,
	`term_days` integer,
	`quota_gb` real,
	`traffic_total_gb` real,
	`validity_days` integer,
	`line_ids` text DEFAULT '[]' NOT NULL,
	`started_at` text NOT NULL,
	`expires_at` text,
	`anchor_day` integer,
	`balance_gb` real,
	`remaining_gb` real,
	`last_settled_at` text,
	`platform_customer_id` integer,
	`code` text,
	`params_version` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_subs_customer` ON `platform_subscriptions` (`customer_id`);--> statement-breakpoint
CREATE INDEX `idx_subs_due` ON `platform_subscriptions` (`kind`,`last_settled_at`);--> statement-breakpoint
CREATE INDEX `idx_subs_order` ON `platform_subscriptions` (`order_id`);--> statement-breakpoint
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
CREATE TABLE `subscription_changes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` text NOT NULL,
	`customer_id` integer NOT NULL,
	`subscription_id` integer NOT NULL,
	`action` text NOT NULL,
	`paid_minor` integer,
	`residual_minor` integer,
	`payable_minor` integer,
	`kind_before` text,
	`kind_after` text,
	`plan_before` text,
	`plan_after` text,
	`expires_before` text,
	`expires_after` text,
	`balance_before` real,
	`balance_after` real,
	`detail` text
);
--> statement-breakpoint
CREATE INDEX `idx_changes_customer` ON `subscription_changes` (`customer_id`,`id`);