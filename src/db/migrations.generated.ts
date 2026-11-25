/**
 * **生成文件，不要手改。** 由 `npm run db:embed` 从 `migrations/*.sql` 产出，
 * CI 用 `npm run db:embed:check` 校验一致性。
 *
 * 这份 bundle 是**门禁的期望值**（`src/db/schema-guard.ts`）：租户库的
 * `d1_migrations` 台账里的文件名集合必须与 `files[].name` 集合相等 ——
 * 缺就 `batch` 补上，多就是"库比代码新"，拒绝服务。
 *
 * `schemaVersion`（sha256:335521fe41383c51）是全部 `(name, sql)` 的内容指纹，
 * 只用于日志与排障 —— **不参与门禁判断**（判据是文件名集合，理由见 ADR
 * `0007-tenant-migration-execution.md`）。
 */
export interface EmbeddedMigrationFile {
  /** 文件名，同时是 `d1_migrations.name`；升序即执行顺序 */
  readonly name: string;
  /** 归一化后整文件 SQL 的 sha256（hex）——与 release asset 里的同一个值 */
  readonly sha256: string;
  /** 语句数组：`batch` 里逐条 prepare，**DDL 与台账 INSERT 同批提交** */
  readonly statements: readonly string[];
}

export const MIGRATION_BUNDLE: {
  readonly schemaVersion: string;
  readonly files: readonly EmbeddedMigrationFile[];
} = {
  "schemaVersion": "sha256:335521fe41383c51",
  "files": [
    {
      "name": "0000_baseline.sql",
      "sha256": "03d5f38b875c83aafecbe4d96bb1f8aaa1da87c7b3063c6f82c3482e10cd93b1",
      "statements": [
        "CREATE TABLE `adjustments` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,\n\t`customer_id` integer NOT NULL,\n\t`subscription_id` integer,\n\t`at` text NOT NULL,\n\t`field` text NOT NULL,\n\t`delta` text,\n\t`before_value` text,\n\t`after_value` text,\n\t`reason` text NOT NULL,\n\t`operator` text NOT NULL,\n\t`platform_applied_at` text,\n\t`platform_error` text\n);",
        "CREATE INDEX `idx_adjustments_customer` ON `adjustments` (`customer_id`,`id`);",
        "CREATE INDEX `idx_adjustments_sub` ON `adjustments` (`subscription_id`,`id`);",
        "CREATE TABLE `admin_sessions` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`user_id` integer NOT NULL,\n\t`pending` integer DEFAULT 0 NOT NULL,\n\t`created_at` text NOT NULL,\n\t`last_used_at` text NOT NULL,\n\t`ip` text,\n\t`user_agent` text\n);",
        "CREATE INDEX `idx_admin_sessions_user` ON `admin_sessions` (`user_id`);",
        "CREATE TABLE `admin_users` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,\n\t`email` text NOT NULL,\n\t`password_hash` text NOT NULL,\n\t`totp_secret` text,\n\t`totp_enabled` integer DEFAULT 0 NOT NULL,\n\t`failed_attempts` integer DEFAULT 0 NOT NULL,\n\t`locked_until` text,\n\t`created_at` text NOT NULL,\n\t`updated_at` text NOT NULL\n);",
        "CREATE UNIQUE INDEX `admin_users_email_unique` ON `admin_users` (`email`);",
        "CREATE TABLE `app_sessions` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`customer_id` integer NOT NULL,\n\t`created_at` text NOT NULL,\n\t`last_used_at` text NOT NULL,\n\t`revoked_at` text,\n\t`app_id` text,\n\t`ip` text,\n\t`user_agent` text\n);",
        "CREATE INDEX `idx_app_sessions_customer` ON `app_sessions` (`customer_id`);",
        "CREATE TABLE `audit_log` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,\n\t`at` text NOT NULL,\n\t`actor` text NOT NULL,\n\t`action` text NOT NULL,\n\t`target` text,\n\t`detail` text\n);",
        "CREATE INDEX `idx_audit_log_at` ON `audit_log` (`at`);",
        "CREATE TABLE `cf_api` (\n\t`id` integer PRIMARY KEY NOT NULL,\n\t`base_url` text DEFAULT '' NOT NULL,\n\t`token_enc` text DEFAULT '' NOT NULL,\n\t`verified_at` text,\n\t`last_error` text,\n\t`_updated_at` text DEFAULT '' NOT NULL\n);",
        "CREATE TABLE `customers` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,\n\t`uuid` text NOT NULL,\n\t`email` text NOT NULL,\n\t`password_hash` text,\n\t`display_name` text,\n\t`status` text DEFAULT 'active' NOT NULL,\n\t`referral_code` text,\n\t`marketing_opt_out` integer DEFAULT 0 NOT NULL,\n\t`created_at` text NOT NULL\n);",
        "CREATE UNIQUE INDEX `customers_email_unique` ON `customers` (`email`);",
        "CREATE UNIQUE INDEX `uq_customers_referral_code` ON `customers` (`referral_code`);",
        "CREATE UNIQUE INDEX `uq_customers_uuid` ON `customers` (`uuid`);",
        "CREATE TABLE `email_codes` (\n\t`email` text PRIMARY KEY NOT NULL,\n\t`code_hash` text NOT NULL,\n\t`purpose` text DEFAULT 'login' NOT NULL,\n\t`sent_at` text NOT NULL,\n\t`expires_at` text NOT NULL,\n\t`attempts` integer DEFAULT 0 NOT NULL\n);",
        "CREATE TABLE `notices` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,\n\t`customer_id` integer NOT NULL,\n\t`kind` text NOT NULL,\n\t`ref_id` text NOT NULL,\n\t`title` text NOT NULL,\n\t`body` text NOT NULL,\n\t`action_url` text,\n\t`action_text` text,\n\t`status` text DEFAULT 'pending' NOT NULL,\n\t`attempts` integer DEFAULT 0 NOT NULL,\n\t`next_attempt_at` text NOT NULL,\n\t`sent_at` text,\n\t`created_at` text NOT NULL\n);",
        "CREATE UNIQUE INDEX `uq_notices` ON `notices` (`kind`,`customer_id`,`ref_id`);",
        "CREATE INDEX `idx_notices_pending` ON `notices` (`status`,`next_attempt_at`);",
        "CREATE INDEX `idx_notices_customer` ON `notices` (`customer_id`,`id`);",
        "CREATE TABLE `orders` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,\n\t`code` text NOT NULL,\n\t`customer_id` integer NOT NULL,\n\t`plan_id` text NOT NULL,\n\t`kind` text NOT NULL,\n\t`plan_snapshot` text NOT NULL,\n\t`amount_minor` integer NOT NULL,\n\t`discount_minor` integer DEFAULT 0 NOT NULL,\n\t`promotion_id` integer,\n\t`code_id` integer,\n\t`currency` text DEFAULT 'CNY' NOT NULL,\n\t`source` text DEFAULT 'purchase' NOT NULL,\n\t`payment_method` text NOT NULL,\n\t`entry` text,\n\t`gateway_id` integer,\n\t`provider_order_no` text,\n\t`provider_trade_no` text,\n\t`pay_url` text,\n\t`iap_key` text,\n\t`raw_create` text,\n\t`raw_notify` text,\n\t`expires_at` text,\n\t`next_poll_at` text,\n\t`poll_attempts` integer DEFAULT 0 NOT NULL,\n\t`status` text DEFAULT 'pending' NOT NULL,\n\t`subscription_id` integer,\n\t`refunded_minor` integer DEFAULT 0 NOT NULL,\n\t`voided_at` text,\n\t`refund_mode` text,\n\t`refund_reason` text,\n\t`paid_at` text,\n\t`provisioned_at` text,\n\t`provision_attempts` integer DEFAULT 0 NOT NULL,\n\t`provision_error` text,\n\t`note` text,\n\t`operator` text,\n\t`created_at` text NOT NULL,\n\t`updated_at` text NOT NULL\n);",
        "CREATE UNIQUE INDEX `orders_code_unique` ON `orders` (`code`);",
        "CREATE UNIQUE INDEX `orders_provider_order_no_unique` ON `orders` (`provider_order_no`);",
        "CREATE INDEX `idx_orders_customer` ON `orders` (`customer_id`,`id`);",
        "CREATE INDEX `idx_orders_poll` ON `orders` (`status`,`next_poll_at`);",
        "CREATE UNIQUE INDEX `uq_orders_iap_key` ON `orders` (`iap_key`);",
        "CREATE INDEX `idx_orders_status` ON `orders` (`status`,`created_at`);",
        "CREATE INDEX `idx_orders_gateway` ON `orders` (`gateway_id`,`status`);",
        "CREATE TABLE `payment_gateways` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,\n\t`driver` text NOT NULL,\n\t`name` text NOT NULL,\n\t`endpoint` text,\n\t`merchant_id` text,\n\t`secret_enc` text,\n\t`methods` text DEFAULT '[]' NOT NULL,\n\t`mapping` text,\n\t`priority` integer DEFAULT 100 NOT NULL,\n\t`status` text DEFAULT 'draft' NOT NULL,\n\t`allowed_emails` text,\n\t`currency` text DEFAULT 'CNY' NOT NULL,\n\t`last_test_order_id` integer,\n\t`last_ok_at` text,\n\t`last_error` text,\n\t`created_at` text NOT NULL,\n\t`updated_at` text NOT NULL\n);",
        "CREATE INDEX `idx_gateways_route` ON `payment_gateways` (`status`,`priority`);",
        "CREATE TABLE `plans` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`name` text NOT NULL,\n\t`kind` text NOT NULL,\n\t`price_minor` integer NOT NULL,\n\t`currency` text NOT NULL,\n\t`licence_limit` integer NOT NULL,\n\t`term_days` integer,\n\t`monthly_quota_gb` real,\n\t`traffic_gb` real,\n\t`validity_days` integer,\n\t`line_ids` text DEFAULT '[]' NOT NULL,\n\t`up_mbps` integer,\n\t`down_mbps` integer,\n\t`sales_channels` text DEFAULT '[]' NOT NULL,\n\t`store_product_id` text DEFAULT '{}' NOT NULL,\n\t`sort_order` integer DEFAULT 0 NOT NULL,\n\t`status` text DEFAULT 'draft' NOT NULL,\n\t`visibility` text DEFAULT 'public' NOT NULL,\n\t`trial` integer DEFAULT 0 NOT NULL,\n\t`retired_at` text,\n\t`created_at` text NOT NULL,\n\t`updated_at` text NOT NULL\n);",
        "CREATE INDEX `idx_plans_status` ON `plans` (`status`,`sort_order`);",
        "CREATE UNIQUE INDEX `uq_plans_trial` ON `plans` (`trial`) WHERE \"plans\".\"trial\" = 1;",
        "CREATE TABLE `platform_subscriptions` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,\n\t`customer_id` integer NOT NULL,\n\t`order_id` integer,\n\t`plan_id` text NOT NULL,\n\t`kind` text NOT NULL,\n\t`hold` text DEFAULT 'none' NOT NULL,\n\t`hold_reason` text,\n\t`hold_at` text,\n\t`paid_minor` integer NOT NULL,\n\t`currency` text NOT NULL,\n\t`licence_limit` integer NOT NULL,\n\t`period_term_days` integer,\n\t`period_quota_gb` real,\n\t`period_anchor_day` integer,\n\t`period_extra_gb` real,\n\t`period_settled_at` text,\n\t`traffic_total_gb` real,\n\t`traffic_remaining_gb` real,\n\t`traffic_synced_at` text,\n\t`traffic_validity_days` integer,\n\t`line_ids` text DEFAULT '[]' NOT NULL,\n\t`started_at` text NOT NULL,\n\t`expires_at` text,\n\t`platform_customer_id` integer,\n\t`activation_code` text,\n\t`trial` integer DEFAULT 0 NOT NULL,\n\t`created_at` text NOT NULL,\n\t`updated_at` text NOT NULL\n);",
        "CREATE UNIQUE INDEX `uq_subs_customer` ON `platform_subscriptions` (`customer_id`);",
        "CREATE INDEX `idx_subs_due` ON `platform_subscriptions` (`kind`,`period_settled_at`);",
        "CREATE INDEX `idx_subs_order` ON `platform_subscriptions` (`order_id`);",
        "CREATE TABLE `promotion_codes` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,\n\t`promotion_id` integer NOT NULL,\n\t`code` text NOT NULL,\n\t`batch_id` text,\n\t`max_uses` integer DEFAULT 1 NOT NULL,\n\t`status` text DEFAULT 'active' NOT NULL,\n\t`expires_at` text,\n\t`note` text,\n\t`created_at` text NOT NULL\n);",
        "CREATE UNIQUE INDEX `promotion_codes_code_unique` ON `promotion_codes` (`code`);",
        "CREATE INDEX `idx_promotion_codes_promotion` ON `promotion_codes` (`promotion_id`);",
        "CREATE INDEX `idx_promotion_codes_batch` ON `promotion_codes` (`batch_id`);",
        "CREATE TABLE `promotion_targets` (\n\t`promotion_id` integer NOT NULL,\n\t`customer_id` integer NOT NULL,\n\t`created_at` text NOT NULL\n);",
        "CREATE UNIQUE INDEX `uq_promotion_targets` ON `promotion_targets` (`promotion_id`,`customer_id`);",
        "CREATE INDEX `idx_promotion_targets_customer` ON `promotion_targets` (`customer_id`);",
        "CREATE TABLE `promotions` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,\n\t`auto_apply` integer DEFAULT 0 NOT NULL,\n\t`name` text NOT NULL,\n\t`kind` text DEFAULT 'coupon' NOT NULL,\n\t`benefit_type` text NOT NULL,\n\t`benefit_value` integer NOT NULL,\n\t`rewards_json` text DEFAULT '{}' NOT NULL,\n\t`min_subtotal_minor` integer DEFAULT 0 NOT NULL,\n\t`limit_plan_kinds` text DEFAULT '[]' NOT NULL,\n\t`limit_plan_ids` text DEFAULT '[]' NOT NULL,\n\t`audience` text DEFAULT 'all' NOT NULL,\n\t`audience_days` integer,\n\t`new_user_within_days` integer,\n\t`starts_at` text,\n\t`ends_at` text,\n\t`max_uses` integer,\n\t`max_uses_per_customer` integer DEFAULT 1 NOT NULL,\n\t`cooldown_hours` integer,\n\t`notify` integer DEFAULT 0 NOT NULL,\n\t`badge_label` text,\n\t`visible` integer DEFAULT 1 NOT NULL,\n\t`referrer_reward_type` text,\n\t`referrer_reward_value` real,\n\t`referee_reward_type` text,\n\t`referee_reward_value` real,\n\t`status` text DEFAULT 'draft' NOT NULL,\n\t`created_at` text NOT NULL,\n\t`updated_at` text NOT NULL\n);",
        "CREATE INDEX `idx_promotions_status` ON `promotions` (`status`,`kind`);",
        "CREATE TABLE `redemptions` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,\n\t`promotion_id` integer NOT NULL,\n\t`customer_id` integer NOT NULL,\n\t`order_id` integer,\n\t`settled_at` text,\n\t`promotion_snapshot` text,\n\t`code_id` integer,\n\t`discount_minor` integer DEFAULT 0 NOT NULL,\n\t`granted_json` text,\n\t`created_at` text NOT NULL\n);",
        "CREATE UNIQUE INDEX `uq_redemptions_order_promo` ON `redemptions` (`promotion_id`,`order_id`);",
        "CREATE INDEX `idx_redemptions_customer` ON `redemptions` (`customer_id`);",
        "CREATE INDEX `idx_redemptions_promotion` ON `redemptions` (`promotion_id`);",
        "CREATE INDEX `idx_redemptions_code` ON `redemptions` (`code_id`);",
        "CREATE UNIQUE INDEX `uq_redemptions_code_customer` ON `redemptions` (`code_id`,`customer_id`);",
        "CREATE UNIQUE INDEX `uq_redemptions_promo_customer` ON `redemptions` (`promotion_id`,`customer_id`);",
        "CREATE TABLE `referral_rewards` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,\n\t`referral_id` integer NOT NULL,\n\t`referrer_id` integer NOT NULL,\n\t`role` text DEFAULT 'referrer' NOT NULL,\n\t`promotion_id` integer NOT NULL,\n\t`rewards_json` text NOT NULL,\n\t`promotion_snapshot` text,\n\t`state` text DEFAULT 'pending' NOT NULL,\n\t`claiming_at` text,\n\t`claimed_at` text,\n\t`redemption_id` integer,\n\t`granted_json` text,\n\t`created_at` text NOT NULL\n);",
        "CREATE UNIQUE INDEX `uq_referral_rewards_referral` ON `referral_rewards` (`referral_id`,`role`);",
        "CREATE INDEX `idx_referral_rewards_referrer` ON `referral_rewards` (`referrer_id`);",
        "CREATE TABLE `referrals` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,\n\t`customer_id` integer NOT NULL,\n\t`referrer_id` integer NOT NULL,\n\t`promotion_id` integer,\n\t`code` text NOT NULL,\n\t`rewarded_at` text,\n\t`reward_type` text,\n\t`reward_value` real,\n\t`created_at` text NOT NULL\n);",
        "CREATE UNIQUE INDEX `uq_referrals_customer` ON `referrals` (`customer_id`);",
        "CREATE INDEX `idx_referrals_referrer` ON `referrals` (`referrer_id`);",
        "CREATE TABLE `refunds` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,\n\t`order_id` integer NOT NULL,\n\t`amount_minor` integer NOT NULL,\n\t`mode` text NOT NULL,\n\t`reason` text,\n\t`operator` text NOT NULL,\n\t`at` text NOT NULL,\n\t`channel_refund_id` text,\n\t`status` text DEFAULT 'done' NOT NULL\n);",
        "CREATE INDEX `idx_refunds_order` ON `refunds` (`order_id`,`id`);",
        "CREATE TABLE `settings` (\n\t`key` text PRIMARY KEY NOT NULL,\n\t`value` text NOT NULL,\n\t`updated_at` text NOT NULL\n);",
        "CREATE TABLE `site_assets` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`tenant_id` text NOT NULL,\n\t`kind` text DEFAULT 'content' NOT NULL,\n\t`name` text DEFAULT '' NOT NULL,\n\t`mime` text NOT NULL,\n\t`bytes` integer DEFAULT 0 NOT NULL,\n\t`sha256` text NOT NULL,\n\t`description` text DEFAULT '' NOT NULL,\n\t`width` integer DEFAULT 0 NOT NULL,\n\t`height` integer DEFAULT 0 NOT NULL,\n\t`created_at` text DEFAULT '' NOT NULL,\n\t`deleted_at` text\n);",
        "CREATE TABLE `site_pointer_log` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,\n\t`tenant_id` text DEFAULT '' NOT NULL,\n\t`from_n` integer,\n\t`to_n` integer NOT NULL,\n\t`reason` text NOT NULL,\n\t`created_by` text,\n\t`created_at` text NOT NULL\n);",
        "CREATE INDEX `idx_site_pointer_log_tenant_at` ON `site_pointer_log` (`tenant_id`,`created_at`);",
        "CREATE TABLE `site_releases` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,\n\t`tenant_id` text DEFAULT '' NOT NULL,\n\t`seq` integer NOT NULL,\n\t`source_sha` text NOT NULL,\n\t`artifact_sha` text NOT NULL,\n\t`seed_sha` text DEFAULT '' NOT NULL,\n\t`files` integer NOT NULL,\n\t`bytes` integer NOT NULL,\n\t`idem_key` text DEFAULT '' NOT NULL,\n\t`created_by` text,\n\t`created_at` text NOT NULL\n);",
        "CREATE UNIQUE INDEX `uq_site_releases_tenant_seq` ON `site_releases` (`tenant_id`,`seq`);",
        "CREATE INDEX `idx_site_releases_tenant_source` ON `site_releases` (`tenant_id`,`source_sha`);",
        "CREATE TABLE `site_settings` (\n\t`id` integer PRIMARY KEY NOT NULL,\n\t`values` text DEFAULT '{}' NOT NULL,\n\t`collections` text DEFAULT '{}' NOT NULL,\n\t`rev` integer DEFAULT 0 NOT NULL,\n\t`updated_at` text DEFAULT '' NOT NULL\n);",
        "CREATE TABLE `store_channels` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,\n\t`platform` text NOT NULL,\n\t`endpoint` text,\n\t`identifier` text NOT NULL,\n\t`environment` text DEFAULT 'production' NOT NULL,\n\t`secret_enc` text,\n\t`status` text DEFAULT 'draft' NOT NULL,\n\t`last_ok_at` text,\n\t`last_error` text,\n\t`created_at` text NOT NULL,\n\t`updated_at` text NOT NULL\n);",
        "CREATE UNIQUE INDEX `uq_store_channels_platform` ON `store_channels` (`platform`);",
        "CREATE TABLE `subscription_changes` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,\n\t`at` text NOT NULL,\n\t`customer_id` integer NOT NULL,\n\t`subscription_id` integer NOT NULL,\n\t`action` text NOT NULL,\n\t`paid_minor` integer,\n\t`residual_minor` integer,\n\t`payable_minor` integer,\n\t`kind_before` text,\n\t`kind_after` text,\n\t`plan_before` text,\n\t`plan_after` text,\n\t`expires_before` text,\n\t`expires_after` text,\n\t`period_extra_before` real,\n\t`period_extra_after` real,\n\t`detail` text\n);",
        "CREATE INDEX `idx_changes_customer` ON `subscription_changes` (`customer_id`,`id`);"
      ]
    },
    {
      "name": "0001_wonderful_sheva_callister.sql",
      "sha256": "287288e5f9dde841e4e27ed1f5c3d6e5ec2f991f786b2d55c34f433fb952693f",
      "statements": [
        "CREATE TABLE `domain_checks` (\n\t`hostname` text PRIMARY KEY NOT NULL,\n\t`status` text NOT NULL,\n\t`checked_at` text NOT NULL\n);"
      ]
    },
    {
      "name": "0002_true_menace.sql",
      "sha256": "15ce3cb108fe80458040baaec6d06e11028a29a760e762da75ac40d487a6c6c6",
      "statements": [
        "ALTER TABLE `orders` ADD `return_poll_at` text;",
        "ALTER TABLE `payment_gateways` ADD `webhook_enc` text;"
      ]
    },
    {
      "name": "0003_instance_channel_codes.sql",
      "sha256": "1c9e31924428c24599ed9615eeb2b1bcf9c5f8ad681abe9e27efc5bd92a3cad9",
      "statements": [
        "ALTER TABLE `payment_gateways` ADD `channel_codes` text;",
        "UPDATE `payment_gateways`\nSET `channel_codes` = json_extract(`mapping`, '$.channel_codes')\nWHERE `mapping` IS NOT NULL\n  AND json_extract(`mapping`, '$.channel_codes') IS NOT NULL;",
        "UPDATE `payment_gateways`\nSET `mapping` = json_remove(`mapping`, '$.channel_codes', '$.sign.exclude_variants', '$.response.pay_url_force_https')\nWHERE `mapping` IS NOT NULL;"
      ]
    },
    {
      "name": "0004_polite_meggan.sql",
      "sha256": "85fc4709186caf342a7a1828f0bbd40bd09294a49044b61fd120162963a182f6",
      "statements": [
        "ALTER TABLE `orders` ADD `provider_amount_minor` integer;",
        "ALTER TABLE `orders` ADD `provider_currency` text;",
        "ALTER TABLE `orders` ADD `fx_rate` real;",
        "ALTER TABLE `payment_gateways` ADD `fx_rate` real DEFAULT 1 NOT NULL;",
        "ALTER TABLE `payment_gateways` ADD `test_amount_minor` integer DEFAULT 100 NOT NULL;",
        "ALTER TABLE `payment_gateways` ADD `test_create_ok_at` text;",
        "ALTER TABLE `payment_gateways` ADD `test_query_ok_at` text;",
        "ALTER TABLE `payment_gateways` ADD `test_callback_ok_at` text;",
        "ALTER TABLE `payment_gateways` ADD `tested_config_hash` text;"
      ]
    },
    {
      "name": "0005_right_ser_duncan.sql",
      "sha256": "b448055afd25dc99e0419df39449415109c4428acf0a5bcebe80a0966ed05e9e",
      "statements": [
        "ALTER TABLE `payment_gateways` ADD `test_require_callback` integer DEFAULT 0 NOT NULL;"
      ]
    },
    {
      "name": "0006_vengeful_stryfe.sql",
      "sha256": "8001b2754062a478c10cf6566f96936f5d27948624eb274223c2f8c6aaec0737",
      "statements": [
        "ALTER TABLE `payment_gateways` ADD `paypal_env` text;"
      ]
    }
  ]
};

/** 期望值 = 文件名集合（纯 A 判据；release tag 不参与） */
export const EXPECTED_NAMES: ReadonlySet<string> = new Set(
  MIGRATION_BUNDLE.files.map((file) => file.name),
);
