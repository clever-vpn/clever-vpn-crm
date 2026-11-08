ALTER TABLE `site_settings` ADD `values` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `site_settings` ADD `rev` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `site_settings` SET `values` = json_object(
  'site', json_object(
    'name', `site_name`,
    'tagline', `tagline`,
    'contact_email', coalesce(`contact_email`, ''),
    'footer_note', coalesce(`footer_note`, ''),
    'hero', json_object(
      'title', coalesce(`hero_title`, ''),
      'sub', coalesce(`hero_sub`, '')
    ),
    'theme', json_object('brand', coalesce(`color`, '#4f46e5'))
  )
) WHERE `values` = '{}';
