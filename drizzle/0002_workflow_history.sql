CREATE TABLE workflow_versions (
 id TEXT PRIMARY KEY NOT NULL,
 workflow_id TEXT NOT NULL,
 owner_id TEXT NOT NULL,
 number INTEGER NOT NULL CHECK(number > 0),
 name TEXT NOT NULL,
 description TEXT NOT NULL,
 definition TEXT NOT NULL,
 created_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX workflow_versions_number_idx ON workflow_versions(workflow_id, number);
--> statement-breakpoint
CREATE INDEX workflow_versions_owner_idx ON workflow_versions(owner_id, workflow_id);
--> statement-breakpoint
CREATE TRIGGER workflow_versions_immutable BEFORE UPDATE ON workflow_versions BEGIN SELECT RAISE(ABORT, 'Published workflow versions are immutable'); END;
--> statement-breakpoint
CREATE TABLE resource_comments (
 id TEXT PRIMARY KEY NOT NULL,
 resource_id TEXT NOT NULL,
 author_id TEXT NOT NULL,
 author_name TEXT NOT NULL,
 text TEXT NOT NULL,
 created_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX resource_comments_target_idx ON resource_comments(resource_id, created_at);
--> statement-breakpoint
CREATE TABLE audit_events (
 id TEXT PRIMARY KEY NOT NULL,
 owner_id TEXT NOT NULL,
 actor_id TEXT NOT NULL,
 action TEXT NOT NULL,
 target_type TEXT NOT NULL,
 target_id TEXT NOT NULL,
 metadata TEXT NOT NULL,
 created_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX audit_events_owner_idx ON audit_events(owner_id, created_at);
--> statement-breakpoint
CREATE INDEX audit_events_target_idx ON audit_events(owner_id, target_type, target_id, created_at);
