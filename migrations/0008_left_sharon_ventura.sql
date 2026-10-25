ALTER TABLE `promotions` ADD `auto_apply` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- 老的「自动活动」= code IS NULL 的优惠券（v17 的判定方式）
UPDATE `promotions` SET `auto_apply` = 1 WHERE `code` IS NULL AND `kind` = 'coupon';
--> statement-breakpoint
-- 把老的主码搬进码表（**必须在删列之前**，否则已发出去的码全部失效）。
-- v17 的主码是"一码多人用"，所以 max_uses 取活动的总名额；活动不限名额则给一个足够大的数。
INSERT OR IGNORE INTO `promotion_codes`
  (`promotion_id`, `code`, `batch_id`, `max_uses`, `status`, `expires_at`, `note`, `created_at`)
SELECT `id`, `code`, NULL, COALESCE(`max_uses`, 1000000), 'active', NULL, 'v18 迁移：原 promotions.code', `created_at`
  FROM `promotions` WHERE `code` IS NOT NULL AND `code` <> '';
