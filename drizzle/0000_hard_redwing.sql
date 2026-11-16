CREATE TABLE `photos` (
	`session` text NOT NULL,
	`id` text NOT NULL,
	`sha256` text NOT NULL,
	`size` integer NOT NULL,
	`ready` integer DEFAULT 0 NOT NULL,
	`position` integer NOT NULL,
	PRIMARY KEY(`session`, `id`),
	FOREIGN KEY (`session`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`environment` text NOT NULL,
	`thread` text NOT NULL,
	`label` text NOT NULL,
	`delivery_hash` text NOT NULL,
	`state` text DEFAULT 'open' NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`purge_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sessions_purge` ON `sessions` (`purge_at`);