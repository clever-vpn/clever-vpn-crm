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
	`referral_code` text,
	`marketing_opt_out` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `customers_email_unique` ON `customers` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_customers_referral_code` ON `customers` (`referral_code`);--> statement-breakpoint
CREATE TABLE `email_codes` (
	`email` text PRIMARY KEY NOT NULL,
	`code_hash` text NOT NULL,
	`purpose` text DEFAULT 'login' NOT NULL,
	`sent_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `notices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`customer_id` integer NOT NULL,
	`kind` text NOT NULL,
	`ref_id` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`action_url` text,
	`action_text` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text NOT NULL,
	`sent_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_notices` ON `notices` (`kind`,`customer_id`,`ref_id`);--> statement-breakpoint
CREATE INDEX `idx_notices_pending` ON `notices` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `idx_notices_customer` ON `notices` (`customer_id`,`id`);--> statement-breakpoint
CREATE TABLE `orders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`code` text NOT NULL,
	`customer_id` integer NOT NULL,
	`plan_id` text NOT NULL,
	`kind` text NOT NULL,
	`plan_snapshot` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`discount_minor` integer DEFAULT 0 NOT NULL,
	`promotion_id` integer,
	`code_id` integer,
	`currency` text DEFAULT 'CNY' NOT NULL,
	`source` text DEFAULT 'purchase' NOT NULL,
	`payment_method` text NOT NULL,
	`entry` text,
	`gateway_id` integer,
	`provider_order_no` text,
	`provider_trade_no` text,
	`pay_url` text,
	`raw_create` text,
	`raw_notify` text,
	`expires_at` text,
	`next_poll_at` text,
	`poll_attempts` integer DEFAULT 0 NOT NULL,
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
CREATE INDEX `idx_orders_poll` ON `orders` (`status`,`next_poll_at`);--> statement-breakpoint
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
	`trial` integer DEFAULT 0 NOT NULL,
	`retired_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_plans_status` ON `plans` (`status`,`sort_order`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_plans_trial` ON `plans` (`trial`) WHERE "plans"."trial" = 1;--> statement-breakpoint
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
	`period_term_days` integer,
	`period_quota_gb` real,
	`period_anchor_day` integer,
	`period_extra_gb` real,
	`period_settled_at` text,
	`traffic_total_gb` real,
	`traffic_remaining_gb` real,
	`traffic_synced_at` text,
	`traffic_validity_days` integer,
	`line_ids` text DEFAULT '[]' NOT NULL,
	`started_at` text NOT NULL,
	`expires_at` text,
	`platform_customer_id` integer,
	`activation_code` text,
	`trial` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_subs_customer` ON `platform_subscriptions` (`customer_id`);--> statement-breakpoint
CREATE INDEX `idx_subs_due` ON `platform_subscriptions` (`kind`,`period_settled_at`);--> statement-breakpoint
CREATE INDEX `idx_subs_order` ON `platform_subscriptions` (`order_id`);--> statement-breakpoint
CREATE TABLE `promotion_claims` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`promotion_id` integer NOT NULL,
	`customer_id` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`source` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`claimed_at` text,
	`order_id` integer,
	`granted_json` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_promotion_claims` ON `promotion_claims` (`promotion_id`,`customer_id`);--> statement-breakpoint
CREATE INDEX `idx_promotion_claims_customer` ON `promotion_claims` (`customer_id`,`status`);--> statement-breakpoint
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
CREATE TABLE `promotion_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`promotion_id` integer NOT NULL,
	`snapshot_max_id` integer NOT NULL,
	`cursor` integer DEFAULT 0 NOT NULL,
	`total` integer DEFAULT 0 NOT NULL,
	`processed` integer DEFAULT 0 NOT NULL,
	`granted` integer DEFAULT 0 NOT NULL,
	`pending` integer DEFAULT 0 NOT NULL,
	`skipped` integer DEFAULT 0 NOT NULL,
	`failed` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`finished_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_promotion_runs_promotion` ON `promotion_runs` (`promotion_id`,`id`);--> statement-breakpoint
CREATE INDEX `idx_promotion_runs_status` ON `promotion_runs` (`status`,`id`);--> statement-breakpoint
CREATE TABLE `promotion_targets` (
	`promotion_id` integer NOT NULL,
	`customer_id` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_promotion_targets` ON `promotion_targets` (`promotion_id`,`customer_id`);--> statement-breakpoint
CREATE INDEX `idx_promotion_targets_customer` ON `promotion_targets` (`customer_id`);--> statement-breakpoint
CREATE TABLE `promotions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`auto_apply` integer DEFAULT 0 NOT NULL,
	`name` text NOT NULL,
	`kind` text DEFAULT 'coupon' NOT NULL,
	`benefit_type` text NOT NULL,
	`benefit_value` integer NOT NULL,
	`rewards_json` text DEFAULT '{}' NOT NULL,
	`min_subtotal_minor` integer DEFAULT 0 NOT NULL,
	`limit_plan_kinds` text DEFAULT '[]' NOT NULL,
	`limit_plan_ids` text DEFAULT '[]' NOT NULL,
	`audience` text DEFAULT 'all' NOT NULL,
	`audience_days` integer,
	`new_user_within_days` integer,
	`starts_at` text,
	`ends_at` text,
	`max_uses` integer,
	`max_uses_per_customer` integer DEFAULT 1 NOT NULL,
	`cooldown_hours` integer,
	`plan_id` text,
	`delivery` text DEFAULT 'auto' NOT NULL,
	`claim_valid_days` integer,
	`notify` integer DEFAULT 1 NOT NULL,
	`badge_label` text,
	`visible` integer DEFAULT 1 NOT NULL,
	`referrer_reward_type` text,
	`referrer_reward_value` real,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_promotions_status` ON `promotions` (`status`,`kind`);--> statement-breakpoint
CREATE TABLE `redemptions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`promotion_id` integer NOT NULL,
	`customer_id` integer NOT NULL,
	`order_id` integer,
	`code_id` integer,
	`discount_minor` integer DEFAULT 0 NOT NULL,
	`granted_json` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_redemptions_order_promo` ON `redemptions` (`promotion_id`,`order_id`);--> statement-breakpoint
CREATE INDEX `idx_redemptions_customer` ON `redemptions` (`customer_id`);--> statement-breakpoint
CREATE INDEX `idx_redemptions_promotion` ON `redemptions` (`promotion_id`);--> statement-breakpoint
CREATE INDEX `idx_redemptions_code` ON `redemptions` (`code_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_redemptions_code_customer` ON `redemptions` (`code_id`,`customer_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_redemptions_promo_customer` ON `redemptions` (`promotion_id`,`customer_id`);--> statement-breakpoint
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
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
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
	`period_extra_before` real,
	`period_extra_after` real,
	`detail` text
);
--> statement-breakpoint
CREATE INDEX `idx_changes_customer` ON `subscription_changes` (`customer_id`,`id`);