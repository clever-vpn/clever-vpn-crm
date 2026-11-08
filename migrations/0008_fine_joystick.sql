CREATE TABLE `site_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`site_name` text DEFAULT '' NOT NULL,
	`tagline` text DEFAULT '' NOT NULL,
	`color` text,
	`contact_email` text,
	`footer_note` text,
	`updated_at` text DEFAULT '' NOT NULL
);
