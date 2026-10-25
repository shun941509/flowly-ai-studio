import { sqliteTable, text, index, integer, uniqueIndex } from "drizzle-orm/sqlite-core";
export const users = sqliteTable("users", {
  id: text("id").primaryKey(), email: text("email").notNull(), name: text("name").notNull(), createdAt: text("created_at").notNull(),
});
export const resources = sqliteTable("resources", {
  id: text("id").primaryKey(), ownerId: text("owner_id").notNull(), name: text("name").notNull(),
  type: text("type").notNull(), description: text("description").notNull(), content: text("content").notNull(), url: text("url").notNull(),
  visibility: text("visibility").notNull(), allowedEmails: text("allowed_emails").notNull(),
  createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, table => [index("resources_owner_idx").on(table.ownerId), index("resources_visibility_idx").on(table.visibility)]);
export const workflows = sqliteTable("workflows", {
  id: text("id").primaryKey(), ownerId: text("owner_id").notNull(), name: text("name").notNull(),
  description: text("description").notNull(), definition: text("definition").notNull(), updatedAt: text("updated_at").notNull(),
}, table => [index("workflows_owner_idx").on(table.ownerId)]);
export const runs = sqliteTable("runs", {
  id: text("id").primaryKey(), ownerId: text("owner_id").notNull(), workflowId: text("workflow_id"), workflowName: text("workflow_name").notNull(),
  input: text("input").notNull(), result: text("result").notNull(), steps: text("steps").notNull(), createdAt: text("created_at").notNull(),
}, table => [index("runs_owner_idx").on(table.ownerId)]);

export const workflowVersions = sqliteTable("workflow_versions", {
  id: text("id").primaryKey(), workflowId: text("workflow_id").notNull(), ownerId: text("owner_id").notNull(),
  number: integer("number").notNull(), name: text("name").notNull(), description: text("description").notNull(),
  definition: text("definition").notNull(), createdAt: text("created_at").notNull(),
}, table => [uniqueIndex("workflow_versions_number_idx").on(table.workflowId, table.number), index("workflow_versions_owner_idx").on(table.ownerId, table.workflowId)]);
export const resourceComments = sqliteTable("resource_comments", {
  id: text("id").primaryKey(), resourceId: text("resource_id").notNull(), authorId: text("author_id").notNull(),
  authorName: text("author_name").notNull(), text: text("text").notNull(), createdAt: text("created_at").notNull(),
}, table => [index("resource_comments_target_idx").on(table.resourceId, table.createdAt)]);
export const auditEvents = sqliteTable("audit_events", {
  id: text("id").primaryKey(), ownerId: text("owner_id").notNull(), actorId: text("actor_id").notNull(), action: text("action").notNull(),
  targetType: text("target_type").notNull(), targetId: text("target_id").notNull(), metadata: text("metadata").notNull(), createdAt: text("created_at").notNull(),
}, table => [index("audit_events_owner_idx").on(table.ownerId, table.createdAt), index("audit_events_target_idx").on(table.ownerId, table.targetType, table.targetId, table.createdAt)]);

// Kept separate from legacy preview runs. JSON is an atomic durable checkpoint;
// revision + lease fencing protects external call preparation and recovery.
export const runtimeRuns = sqliteTable("runtime_runs", {
  id:text("id").primaryKey(), ownerId:text("owner_id").notNull(),
  idempotencyKey:text("idempotency_key").notNull(), requestHash:text("request_hash").notNull(),
  status:text("status").notNull(), document:text("document").notNull(),
  revision:integer("revision").notNull().default(0), cancelRequested:integer("cancel_requested").notNull().default(0),
  leaseOwner:text("lease_owner"), leaseUntil:integer("lease_until").notNull().default(0),
  createdAt:text("created_at").notNull(), updatedAt:text("updated_at").notNull(),
}, table=>[uniqueIndex("runtime_runs_request_idx").on(table.ownerId,table.idempotencyKey),index("runtime_runs_owner_idx").on(table.ownerId,table.createdAt),index("runtime_runs_queue_idx").on(table.status,table.leaseUntil)]);
