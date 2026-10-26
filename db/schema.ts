/** D1 테이블의 TypeScript 매핑. JSON 문자열의 도메인 검증과 현재 사용자 권한 검사는 저장소 계층에서 수행한다. */
import { sqliteTable, text, index, integer, uniqueIndex } from "drizzle-orm/sqlite-core";
/** 서버에서 검증한 신원만 저장한다. 이메일은 공유 대상 비교에 사용하고 소유권은 안정적인 사용자 ID에 연결한다. */
export const users = sqliteTable("users", {
  id: text("id").primaryKey(), email: text("email").notNull(), name: text("name").notNull(), createdAt: text("created_at").notNull(),
});
/** 자료 본문·정의와 자료별 공유 범위. 워크플로를 공유해도 이 테이블의 자료 권한은 자동으로 바뀌지 않는다. */
export const resources = sqliteTable("resources", {
  id: text("id").primaryKey(), ownerId: text("owner_id").notNull(), name: text("name").notNull(),
  type: text("type").notNull(), description: text("description").notNull(), content: text("content").notNull(), url: text("url").notNull(),
  visibility: text("visibility").notNull(), allowedEmails: text("allowed_emails").notNull(),
  createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
  details: text("details").notNull().default("null"), files: text("files").notNull().default("[]"),
  writeToken: text("write_token").notNull().default(""),
}, table => [index("resources_owner_idx").on(table.ownerId), index("resources_visibility_idx").on(table.visibility)]);
/** 자료/파일의 과거 버전은 불변 스냅샷으로 보존한다. 공유 사용자는 현재 자료의 첨부만 읽고 복구는 소유자만 수행한다. */
export const resourceVersions = sqliteTable("resource_versions", {
  id:text("id").primaryKey(),resourceId:text("resource_id").notNull(),number:integer("number").notNull(),actorId:text("actor_id").notNull(),snapshot:text("snapshot").notNull(),createdAt:text("created_at").notNull(),
}, table=>[uniqueIndex("resource_versions_number_idx").on(table.resourceId,table.number)]);
export const resourceFiles = sqliteTable("resource_files", {
  id:text("id").primaryKey(),ownerId:text("owner_id").notNull(),resourceId:text("resource_id"),path:text("path").notNull(),mimeType:text("mime_type").notNull(),size:integer("size").notNull(),sha256:text("sha256").notNull(),storageKey:text("storage_key").notNull(),createdAt:text("created_at").notNull(),
}, table=>[index("resource_files_resource_idx").on(table.resourceId),index("resource_files_owner_idx").on(table.ownerId)]);
/** 명시적 개발 테스트 어댑터만 사용하는 파일 조각. 운영 첨부는 R2 바인딩으로 저장한다. */
export const resourceFileChunks=sqliteTable("resource_file_chunks",{fileId:text("file_id").notNull(),part:integer("part").notNull(),data:text("data").notNull()},table=>[uniqueIndex("resource_file_chunks_part_idx").on(table.fileId,table.part)]);
/** 편집 가능한 현재 설계. readEmails/editEmails는 JSON 배열이며 전체 공개 읽기와 지정 사용자 수정 권한을 분리한다. */
export const workflows = sqliteTable("workflows", {
  id: text("id").primaryKey(), ownerId: text("owner_id").notNull(), name: text("name").notNull(),
  description: text("description").notNull(), definition: text("definition").notNull(), updatedAt: text("updated_at").notNull(),
  visibility: text("visibility").notNull().default("private"), readEmails: text("read_emails").notNull().default("[]"),
  editEmails: text("edit_emails").notNull().default("[]"), lastModifiedBy: text("last_modified_by").notNull().default(""),
}, table => [index("workflows_owner_idx").on(table.ownerId), index("workflows_visibility_idx").on(table.visibility)]);
/** simulateFlow 미리보기 이력이다. 실제/테스트 엔진의 지속 실행 상태는 runtimeRuns에 별도로 둔다. */
export const runs = sqliteTable("runs", {
  id: text("id").primaryKey(), ownerId: text("owner_id").notNull(), workflowId: text("workflow_id"), workflowName: text("workflow_name").notNull(),
  input: text("input").notNull(), result: text("result").notNull(), steps: text("steps").notNull(), createdAt: text("created_at").notNull(),
}, table => [index("runs_owner_idx").on(table.ownerId)]);

/** 발행 당시 설계 스냅샷. (workflowId, number)의 유일 제약으로 같은 번호의 버전이 중복 생성되지 않게 한다. */
export const workflowVersions = sqliteTable("workflow_versions", {
  id: text("id").primaryKey(), workflowId: text("workflow_id").notNull(), ownerId: text("owner_id").notNull(),
  number: integer("number").notNull(), name: text("name").notNull(), description: text("description").notNull(),
  definition: text("definition").notNull(), createdAt: text("created_at").notNull(),
}, table => [uniqueIndex("workflow_versions_number_idx").on(table.workflowId, table.number), index("workflow_versions_owner_idx").on(table.ownerId, table.workflowId)]);
export const resourceComments = sqliteTable("resource_comments", {
  id: text("id").primaryKey(), resourceId: text("resource_id").notNull(), authorId: text("author_id").notNull(),
  authorName: text("author_name").notNull(), text: text("text").notNull(), createdAt: text("created_at").notNull(),
}, table => [index("resource_comments_target_idx").on(table.resourceId, table.createdAt)]);
/** 행동·주체·변경 필드 같은 메타데이터 기록. 자료 본문이나 자격 증명을 감사 메타데이터에 추가하지 않는다. */
export const auditEvents = sqliteTable("audit_events", {
  id: text("id").primaryKey(), ownerId: text("owner_id").notNull(), actorId: text("actor_id").notNull(), action: text("action").notNull(),
  targetType: text("target_type").notNull(), targetId: text("target_id").notNull(), metadata: text("metadata").notNull(), createdAt: text("created_at").notNull(),
}, table => [index("audit_events_owner_idx").on(table.ownerId, table.createdAt), index("audit_events_target_idx").on(table.ownerId, table.targetType, table.targetId, table.createdAt)]);

// Kept separate from legacy preview runs. JSON is an atomic durable checkpoint;
// revision + lease fencing protects external call preparation and recovery.
/** 실행 JSON과 revision/lease를 함께 저장한다. 요청 키의 사용자별 유일성과 저장 시 CAS로 중복 시작·오래된 작업자의 덮어쓰기를 막는다. */
export const runtimeRuns = sqliteTable("runtime_runs", {
  id:text("id").primaryKey(), ownerId:text("owner_id").notNull(),
  idempotencyKey:text("idempotency_key").notNull(), requestHash:text("request_hash").notNull(),
  status:text("status").notNull(), document:text("document").notNull(),
  revision:integer("revision").notNull().default(0), cancelRequested:integer("cancel_requested").notNull().default(0),
  leaseOwner:text("lease_owner"), leaseUntil:integer("lease_until").notNull().default(0),
  createdAt:text("created_at").notNull(), updatedAt:text("updated_at").notNull(),
}, table=>[uniqueIndex("runtime_runs_request_idx").on(table.ownerId,table.idempotencyKey),index("runtime_runs_owner_idx").on(table.ownerId,table.createdAt),index("runtime_runs_queue_idx").on(table.status,table.leaseUntil)]);
