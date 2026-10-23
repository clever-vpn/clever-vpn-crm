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
	`allow_addons` integer DEFAULT 0 NOT NULL,
	`line_ids` text DEFAULT '[]' NOT NULL,
	`up_mbps` integer,
	`down_mbps` integer,
	`channels` text DEFAULT '[]' NOT NULL,
	`store_product_id` text DEFAULT '{}' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`supersedes_id` text,
	`retired_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_plans_status` ON `plans` (`status`,`sort_order`);--> statement-breakpoint
CREATE TABLE `platform_subscriptions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`customer_id` integer NOT NULL,
	`plan_id` text NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`paid_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`licence_limit` integer NOT NULL,
	`term_days` integer,
	`quota_gb` real,
	`traffic_total_gb` real,
	`validity_days` integer,
	`allow_addons` integer DEFAULT 0 NOT NULL,
	`line_ids` text DEFAULT '[]' NOT NULL,
	`started_at` text NOT NULL,
	`expires_at` text,
	`anchor_day` integer,
	`balance_gb` real,
	`remaining_gb` real,
	`last_settled_at` text,
	`platform_customer_id` integer,
	`code` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_subs_customer` ON `platform_subscriptions` (`customer_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_subs_due` ON `platform_subscriptions` (`kind`,`status`,`last_settled_at`);--> statement-breakpoint
CREATE TABLE `subscription_changes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` text NOT NULL,
	`customer_id` integer NOT NULL,
	`from_subscription_id` integer,
	`to_subscription_id` integer,
	`action` text NOT NULL,
	`paid_minor` integer,
	`residual_minor` integer,
	`payable_minor` integer,
	`balance_before` real,
	`balance_after` real,
	`detail` text
);
--> statement-breakpoint
CREATE INDEX `idx_changes_customer` ON `subscription_changes` (`customer_id`,`id`);