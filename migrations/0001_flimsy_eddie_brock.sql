CREATE TABLE `referral_rewards` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`referral_id` integer NOT NULL,
	`referrer_id` integer NOT NULL,
	`promotion_id` integer NOT NULL,
	`rewards_json` text NOT NULL,
	`promotion_snapshot` text,
	`state` text DEFAULT 'pending' NOT NULL,
	`claiming_at` text,
	`claimed_at` text,
	`redemption_id` integer,
	`granted_json` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_referral_rewards_referral` ON `referral_rewards` (`referral_id`);--> statement-breakpoint
CREATE INDEX `idx_referral_rewards_referrer` ON `referral_rewards` (`referrer_id`);