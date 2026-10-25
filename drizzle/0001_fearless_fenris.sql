CREATE TABLE `runtime_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`status` text NOT NULL,
	`document` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`cancel_requested` integer DEFAULT 0 NOT NULL,
	`lease_owner` text,
	`lease_until` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_runs_request_idx` ON `runtime_runs` (`owner_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `runtime_runs_owner_idx` ON `runtime_runs` (`owner_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `runtime_runs_queue_idx` ON `runtime_runs` (`status`,`lease_until`);