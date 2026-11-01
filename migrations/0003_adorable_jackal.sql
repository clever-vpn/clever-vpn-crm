DROP INDEX `uq_referral_rewards_referral`;--> statement-breakpoint
ALTER TABLE `referral_rewards` ADD `role` text DEFAULT 'referrer' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_referral_rewards_referral` ON `referral_rewards` (`referral_id`,`role`);--> statement-breakpoint
ALTER TABLE `promotions` ADD `referee_reward_type` text;--> statement-breakpoint
ALTER TABLE `promotions` ADD `referee_reward_value` real;