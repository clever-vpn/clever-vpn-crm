ALTER TABLE `orders` ADD `iap_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_orders_iap_key` ON `orders` (`iap_key`);