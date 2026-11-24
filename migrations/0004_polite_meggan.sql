ALTER TABLE `orders` ADD `provider_amount_minor` integer;--> statement-breakpoint
ALTER TABLE `orders` ADD `provider_currency` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `fx_rate` real;--> statement-breakpoint
ALTER TABLE `payment_gateways` ADD `fx_rate` real DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `payment_gateways` ADD `test_amount_minor` integer DEFAULT 100 NOT NULL;--> statement-breakpoint
ALTER TABLE `payment_gateways` ADD `test_create_ok_at` text;--> statement-breakpoint
ALTER TABLE `payment_gateways` ADD `test_query_ok_at` text;--> statement-breakpoint
ALTER TABLE `payment_gateways` ADD `test_callback_ok_at` text;--> statement-breakpoint
ALTER TABLE `payment_gateways` ADD `tested_config_hash` text;