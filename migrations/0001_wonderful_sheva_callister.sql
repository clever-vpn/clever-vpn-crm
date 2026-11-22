CREATE TABLE `domain_checks` (
	`hostname` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`checked_at` text NOT NULL
);
