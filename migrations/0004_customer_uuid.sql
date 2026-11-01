ALTER TABLE `customers` ADD `uuid` text NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_customers_uuid` ON `customers` (`uuid`);