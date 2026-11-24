ALTER TABLE `payment_gateways` ADD `channel_codes` text;--> statement-breakpoint
UPDATE `payment_gateways`
SET `channel_codes` = json_extract(`mapping`, '$.channel_codes')
WHERE `mapping` IS NOT NULL
  AND json_extract(`mapping`, '$.channel_codes') IS NOT NULL;--> statement-breakpoint
UPDATE `payment_gateways`
SET `mapping` = json_remove(`mapping`, '$.channel_codes', '$.sign.exclude_variants', '$.response.pay_url_force_https')
WHERE `mapping` IS NOT NULL;
