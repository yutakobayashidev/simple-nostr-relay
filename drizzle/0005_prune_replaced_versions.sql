-- NIP-01: relays only have to keep the newest version of a replaceable event (kind 0, 3, 10000-19999)
-- and of an addressable event (kind 30000-39999, addressed by its d tag). Older versions used to stay
-- in the table with replaced = 1, so every save re-processed the whole history of its address.
-- Keep the newest version of each address (the lowest id wins a created_at tie) and delete the rest
-- together with their tags.
CREATE TEMP TABLE `stale_versions` (`id` text PRIMARY KEY NOT NULL);
--> statement-breakpoint
INSERT INTO `stale_versions` (`id`)
SELECT `id` FROM (
	SELECT
		`id`,
		row_number() OVER (PARTITION BY `author`, `kind`, `d` ORDER BY `created_at` DESC, `id` ASC) AS `version_rank`
	FROM (
		SELECT
			`events`.`id`,
			`events`.`author`,
			`events`.`kind`,
			`events`.`created_at`,
			CASE WHEN `events`.`kind` >= 30000 THEN coalesce(
				(SELECT `tags`.`value` FROM `tags` WHERE `tags`.`event_id` = `events`.`id` AND `tags`.`name` = 'd' LIMIT 1),
				''
			) ELSE '' END AS `d`
		FROM `events`
		WHERE `events`.`kind` IN (0, 3) OR `events`.`kind` BETWEEN 10000 AND 19999 OR `events`.`kind` BETWEEN 30000 AND 39999
	)
)
WHERE `version_rank` > 1;
--> statement-breakpoint
DELETE FROM `tags` WHERE `event_id` IN (SELECT `id` FROM `stale_versions`);
--> statement-breakpoint
DELETE FROM `events` WHERE `id` IN (SELECT `id` FROM `stale_versions`);
--> statement-breakpoint
-- The previous save logic could leave the newest version flagged when an older one arrived later.
UPDATE `events` SET `replaced` = 0
WHERE `replaced` = 1 AND (`kind` IN (0, 3) OR `kind` BETWEEN 10000 AND 19999 OR `kind` BETWEEN 30000 AND 39999);
--> statement-breakpoint
DROP TABLE `stale_versions`;
