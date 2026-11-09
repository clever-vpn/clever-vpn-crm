CREATE TABLE `cf_api` (
	`id` integer PRIMARY KEY NOT NULL,
	`base_url` text DEFAULT '' NOT NULL,
	`token_enc` text DEFAULT '' NOT NULL,
	`verified_at` text,
	`last_error` text,
	`_updated_at` text DEFAULT '' NOT NULL
);
