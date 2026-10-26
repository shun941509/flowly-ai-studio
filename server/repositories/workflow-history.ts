/** 워크플로/자료의 현재 권한·낙관적 동시성·발행 스냅샷·감사 이력을 담당한다. API가 전달하는 Identity는 검증된 세션에서 와야 한다. */
import { canReadResource, parseDefinition, sampleResources, uid, type Identity, type Resource, type Workflow } from "../../app/lib/model";
import { compileDefinition, migrateV1, migrateV2, migrateV3, migrateV4, referencedResourceIds } from "../../domain/workflow";
import { workflowAccess, parseWorkflowSharing } from "../../domain/workflow-access";
import { redactText } from "../../runtime/policy";
import { HistoryError } from "./errors";
export { HistoryError } from "./errors";
import { ResourceHistoryRepository, resourceFromRow, type ResourceRow } from "./resource-history";

type WorkflowRow = { id: string; owner_id: string; name: string; description: string; definition: string; updated_at: string; visibility?: string; read_emails?: string; edit_emails?: string; last_modified_by?: string; modifier_name?: string };
type VersionRow = { id: string; workflow_id: string; owner_id: string; number: number; name: string; description: string; definition: string; created_at: string };
type CommentRow = { id: string; resource_id: string; author_id: string; author_name: string; text: string; created_at: string };
export type WorkflowVersion = { id: string; workflowId: string; number: number; name: string; description: string; definition: Workflow["definition"]; createdAt: string };
export type AuditMetadata = { fields?: string[]; visibility?: string; sharedUserCount?: number; version?: number; commentId?: string };
const decodeWorkflow = (row: WorkflowRow): Workflow => ({ id: row.id, name: row.name, description: row.description, definition: JSON.parse(row.definition), updatedAt: row.updated_at, ownerId: row.owner_id, visibility: (row.visibility || "private") as Workflow["visibility"], readEmails: JSON.parse(row.read_emails || "[]"), editEmails: JSON.parse(row.edit_emails || "[]"), lastModifiedBy: row.last_modified_by || row.owner_id, lastModifiedName: row.modifier_name || row.last_modified_by || row.owner_id });
const decodeResource = resourceFromRow;
const decodeVersion = (row: VersionRow): WorkflowVersion => ({ id: row.id, workflowId: row.workflow_id, number: row.number, name: row.name, description: row.description, definition: JSON.parse(row.definition), createdAt: row.created_at });
const timestamp = (previous?: string) => new Date(Math.max(Date.now(), previous ? Date.parse(previous) + 1 : 0)).toISOString();
const conflict = (current?: Workflow | Resource) => new HistoryError("다른 곳에서 먼저 변경했어요. 현재 입력은 유지하고 최신 내용을 확인한 뒤 다시 저장해 주세요.", 409, current);
function changedFields(before: Record<string, unknown>, after: Record<string, unknown>, fields: readonly string[]) { return fields.filter(field => JSON.stringify(before[field]) !== JSON.stringify(after[field])); }
function safeId(value: unknown) { if (typeof value !== "string" || !value || value.length > 100 || /[\x00-\x1f]/.test(value)) throw new HistoryError("대상 ID를 확인해 주세요."); return value; }

/** D1 batches keep mutation, immutable snapshot and metadata-only audit in one transaction. */
export class WorkflowHistoryRepository {
  constructor(private readonly db: D1Database) {}
  async recordAudit(user: Identity, action: "workflow.export", targetType: "workflow", targetId: string, metadata: Pick<AuditMetadata, "version" | "fields"> = {}) {
    if (action !== "workflow.export" || targetType !== "workflow") throw new HistoryError("지원하지 않는 감사 기록이에요.");
    await this.checkExport(user, targetId);
    const exported = await this.db.prepare("SELECT * FROM workflows WHERE id=?").bind(targetId).first<WorkflowRow>();
    const clean: AuditMetadata = {};
    if (Number.isSafeInteger(metadata.version) && metadata.version! > 0) clean.version = metadata.version;
    if (metadata.fields) clean.fields = metadata.fields.filter(field => ["kind", "language", "definition", "resources", "connections"].includes(field));
    await this.db.prepare("INSERT INTO audit_events(id,owner_id,actor_id,action,target_type,target_id,metadata,created_at) VALUES(?,?,?,?,?,?,?,?)").bind(uid("audit"), exported?.owner_id || user.userId, user.userId, action, targetType, safeId(targetId), JSON.stringify(clean), timestamp()).run();
  }
  /** 직전 쓰기가 정확히 한 행을 바꾼 경우만 기록한다. changes()를 사용하므로 호출부 batch의 SQL 순서가 계약의 일부다. */
  private audit(user: Identity, ownerId: string, action: string, targetType: "workflow" | "resource", targetId: string, metadata: AuditMetadata, at: string) {
    return this.db.prepare("INSERT INTO audit_events(id,owner_id,actor_id,action,target_type,target_id,metadata,created_at) SELECT ?,?,?,?,?,?,?,? WHERE changes()=1").bind(uid("audit"), ownerId, user.userId, action, targetType, targetId, JSON.stringify(metadata), at);
  }
  /** 삭제·권한 관리에 사용하는 소유자 전용 조회. 공동 편집 권한으로 이 경계를 통과할 수 없다. */
  private async ownedWorkflow(user: Identity, id: string) {
    const row = await this.db.prepare("SELECT * FROM workflows WHERE id=? AND owner_id=?").bind(safeId(id), user.userId).first<WorkflowRow>();
    if (!row) throw new HistoryError("워크플로를 찾을 수 없어요.", 404); return row;
  }
  /** 조회 시점의 공유 상태로 읽기/편집을 검사한다. 예전에 화면을 열었다는 사실을 접근 권한으로 사용하지 않는다. */
  private async workflow(user: Identity, id: string, mode: "read" | "edit" = "read") {
    const row = await this.db.prepare("SELECT * FROM workflows WHERE id=?").bind(safeId(id)).first<WorkflowRow>();
    const access = row && workflowAccess(decodeWorkflow(row), user);
    if (!row || !access || !(mode === "edit" ? access.canEdit : access.canRead)) throw new HistoryError(mode === "edit" ? "수정 권한이 없거나 공유가 철회됐어요." : "워크플로를 찾을 수 없거나 공유가 철회됐어요.", mode === "edit" ? 403 : 404);
    return row;
  }
  /** 권한 플래그는 서버에서 계산하고 공유 대상 이메일 목록은 관리 권한이 있는 소유자에게만 보낸다. */
  private present(row: WorkflowRow, user: Identity): Workflow {
    const workflow = decodeWorkflow(row), access = workflowAccess(workflow, user);
    return { ...workflow, access, editScope: workflow.editEmails?.length ? "selected" : "private", readEmails: access.canManage ? workflow.readEmails : [], editEmails: access.canManage ? workflow.editEmails : [] };
  }
  async getWorkflow(user: Identity, id: string) { const row = await this.workflow(user, id); const actor = await this.db.prepare("SELECT name FROM users WHERE id=?").bind(row.last_modified_by || row.owner_id).first<{name:string}>(); return this.present({...row, modifier_name:actor?.name}, user); }
  async listWorkflows(user: Identity) {
    const rows = await this.db.prepare("SELECT workflows.*,(SELECT name FROM users WHERE users.id=workflows.last_modified_by) AS modifier_name FROM workflows WHERE owner_id=? OR visibility='public' OR EXISTS(SELECT 1 FROM json_each(edit_emails) WHERE value=?) OR (visibility='selected' AND EXISTS(SELECT 1 FROM json_each(read_emails) WHERE value=?)) ORDER BY updated_at DESC").bind(user.userId, user.email.toLowerCase(), user.email.toLowerCase()).all<WorkflowRow>();
    return rows.results.map(row => this.present(row, user));
  }
  /** Unsaved drafts are permitted; an existing ID always requires current read permission. */
  async checkExport(user: Identity, id: string) {
    const row = await this.db.prepare("SELECT * FROM workflows WHERE id=?").bind(safeId(id)).first<WorkflowRow>();
    if (row && !workflowAccess(decodeWorkflow(row), user).canRead) throw new HistoryError("워크플로 공유가 철회되어 내보낼 수 없어요.", 403);
  }
  /** 소유자만 공유 범위를 바꾼다. 파서는 전체 사용자 편집을 거절하고 updatedAt 비교로 오래된 설정 덮어쓰기를 막는다. */
  async shareWorkflow(user: Identity, id: string, value: unknown, baseUpdatedAt: unknown) {
    const row = await this.ownedWorkflow(user, id); this.checkBase(baseUpdatedAt, decodeWorkflow(row));
    let sharing; try { sharing = parseWorkflowSharing(value); } catch (error) { throw new HistoryError((error as Error).message); }
    const at = timestamp(row.updated_at);
    const [written] = await this.db.batch([
      this.db.prepare("UPDATE workflows SET visibility=?,read_emails=?,edit_emails=?,last_modified_by=?,updated_at=? WHERE id=? AND owner_id=? AND updated_at=?").bind(sharing.visibility, JSON.stringify(sharing.readEmails), JSON.stringify(sharing.editEmails), user.userId, at, id, user.userId, baseUpdatedAt),
      this.audit(user, row.owner_id, "workflow.share", "workflow", id, { visibility: sharing.visibility, sharedUserCount: new Set([...sharing.readEmails, ...sharing.editEmails]).size }, at),
    ]);
    if (written.meta.changes !== 1) throw conflict(this.present(await this.workflow(user, id), user));
    return this.getWorkflow(user, id);
  }
  private async resource(user: Identity, id: string) {
    const sample = sampleResources.find(resource => resource.id === id);
    const row = sample ? null : await this.db.prepare("SELECT * FROM resources WHERE id=?").bind(safeId(id)).first<ResourceRow>();
    const resource = sample ?? (row ? decodeResource(row) : undefined);
    if (!resource || !canReadResource(resource, user)) throw new HistoryError("자료에 접근할 권한이 없거나 공유가 철회됐어요.", 404);
    return resource;
  }
  /** 설계의 하위 흐름까지 참조하는 자료를 개별 검사한다. 워크플로 편집 권한이 연결 자료 사용 권한을 대신하지 않는다. */
  private async checkResources(user: Identity, definition: Workflow["definition"]) {
    for (const id of referencedResourceIds(definition)) try { await this.resource(user, id); } catch { throw new HistoryError("접근 권한이 없거나 삭제된 자료가 연결되어 있어요. 공유 상태를 확인해 주세요.", 403); }
  }
  private checkBase(base: unknown, current: Workflow | Resource) { if (typeof base !== "string" || base !== current.updatedAt) throw conflict(current); }
  /** 기존 설계는 최신 updatedAt와 현재 편집 권한을 SQL에서도 재확인한다. 새 설계 소유자는 클라이언트 값이 아닌 세션 사용자다. */
  async saveWorkflow(user: Identity, value: unknown, baseUpdatedAt: unknown, updateAction: "workflow.update" | "workflow.restore" = "workflow.update", sourceVersion?: number): Promise<Workflow> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new HistoryError("저장할 워크플로를 확인해 주세요.");
    const data = value as Record<string, unknown>, id = safeId(data.id || uid("flow"));
    const existing = await this.db.prepare("SELECT * FROM workflows WHERE id=?").bind(id).first<WorkflowRow>();
    if (existing && !workflowAccess(decodeWorkflow(existing), user).canEdit) throw new HistoryError("저장할 권한이 없어요.", 403);
    if (existing) this.checkBase(baseUpdatedAt, this.present(existing, user));
    const name = typeof data.name === "string" ? data.name.trim() : "";
    if (!name || name.length > 80) throw new HistoryError("워크플로 이름을 1~80자로 입력해 주세요.");
    const definition = parseDefinition(data.definition); await this.checkResources(user, definition);
    const result: Workflow = { id, name, description: String(data.description ?? "").slice(0, 300), definition, updatedAt: timestamp(existing?.updated_at), ownerId: existing?.owner_id || user.userId, visibility: (existing?.visibility || "private") as Workflow["visibility"], readEmails: JSON.parse(existing?.read_emails || "[]"), editEmails: JSON.parse(existing?.edit_emails || "[]"), lastModifiedBy: user.userId, lastModifiedName: user.displayName };
    const statement = existing
      ? this.db.prepare("UPDATE workflows SET name=?,description=?,definition=?,updated_at=?,last_modified_by=? WHERE id=? AND updated_at=? AND (owner_id=? OR EXISTS(SELECT 1 FROM json_each(edit_emails) WHERE value=?))").bind(name, result.description, JSON.stringify(definition), result.updatedAt, user.userId, id, baseUpdatedAt, user.userId, user.email.toLowerCase())
      : this.db.prepare("INSERT INTO workflows(id,owner_id,name,description,definition,updated_at,last_modified_by) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING").bind(id, user.userId, name, result.description, JSON.stringify(definition), result.updatedAt, user.userId);
    const fields = existing ? changedFields(decodeWorkflow(existing) as unknown as Record<string, unknown>, result as unknown as Record<string, unknown>, ["name", "description", "definition"]) : ["name", "description", "definition"];
    const [write] = await this.db.batch([statement, this.audit(user, result.ownerId!, existing ? updateAction : "workflow.create", "workflow", id, { fields, ...(sourceVersion ? {version:sourceVersion} : {}) }, result.updatedAt)]);
    if (write.meta.changes !== 1) throw conflict(existing ? this.present(await this.workflow(user, id), user) : undefined);
    return { ...result, access: workflowAccess(result, user), editScope: result.editEmails?.length ? "selected" : "private", readEmails: result.ownerId === user.userId ? result.readEmails : [], editEmails: result.ownerId === user.userId ? result.editEmails : [] };
  }
  /** 외부 수정본은 새 사본 또는 원본의 새 버전으로 저장한다. 설계/자료 권한을 재검사하며 실행기 코드를 가져와 실행하지 않는다. */
  async importWorkflow(user: Identity, value: unknown, mode: unknown, origin: unknown): Promise<Workflow> {
    if (!value || typeof value !== "object" || Array.isArray(value) || !origin || typeof origin !== "object" || Array.isArray(origin) || !["copy", "version"].includes(String(mode))) throw new HistoryError("가져올 설계와 저장 방법을 확인해 주세요.");
    const data = value as Record<string, unknown>, source = origin as Record<string, unknown>;
    const id = safeId(source.workflowId), definition = compileDefinition(parseDefinition(data.definition));
    await this.checkExport(user, id); await this.checkResources(user, definition);
    if (mode === "copy") return this.saveWorkflow(user, { id: uid("flow"), name: data.name, description: data.description, definition }, undefined);
    const row = await this.workflow(user, id, "edit"); this.checkBase(source.updatedAt, this.present(row, user));
    if (data.id !== id) throw new HistoryError("원본 ID가 다른 설계는 새 사본으로 저장해 주세요.");
    const name = typeof data.name === "string" ? data.name.trim() : "";
    if (!name || name.length > 80) throw new HistoryError("워크플로 이름을 1~80자로 입력해 주세요.");
    const description = String(data.description || "").slice(0, 300), at = timestamp(row.updated_at), versionId = uid("version");
    const [write, version] = await this.db.batch([
      this.db.prepare("UPDATE workflows SET name=?,description=?,definition=?,updated_at=?,last_modified_by=? WHERE id=? AND updated_at=? AND (owner_id=? OR EXISTS(SELECT 1 FROM json_each(edit_emails) WHERE value=?))").bind(name, description, JSON.stringify(definition), at, user.userId, id, source.updatedAt, user.userId, user.email.toLowerCase()),
      this.db.prepare("INSERT INTO workflow_versions(id,workflow_id,owner_id,number,name,description,definition,created_at) SELECT ?,id,owner_id,(SELECT COALESCE(MAX(number),0)+1 FROM workflow_versions WHERE workflow_id=?),name,description,definition,? FROM workflows WHERE id=? AND updated_at=? AND changes()=1").bind(versionId, id, at, id, at),
      this.audit(user, row.owner_id, "workflow.import", "workflow", id, { fields: ["name", "description", "definition"] }, at),
    ]);
    if (write.meta.changes !== 1 || version.meta.changes !== 1) throw conflict(this.present(await this.workflow(user, id), user));
    return this.getWorkflow(user, id);
  }
  /** 자료 입력을 도메인 파서로 검증하고 ID·소유자·시각은 서버에서 부여한다. */
  async createResource(user: Identity, value: unknown) { return new ResourceHistoryRepository(this.db).create(user,value); }
  /** 기존 자료 API는 같은 버전/파일/CAS 계약으로 위임한다. */
  async updateResource(user: Identity, id: string, value: unknown, baseUpdatedAt: unknown) { return new ResourceHistoryRepository(this.db).update(user,id,value,baseUpdatedAt); }
  /** 소유자만 삭제하며 본인 저장 워크플로의 참조를 검사한다. 다른 사용자의 사본까지 일괄 수정하지 않는다. */
  async deleteResource(user: Identity, id: string) {
    const row = await this.db.prepare("SELECT * FROM resources WHERE id=? AND owner_id=?").bind(safeId(id), user.userId).first<ResourceRow>();
    if (!row) throw new HistoryError("수정 권한이 없거나 삭제된 자료예요.", 404);
    const references = await this.db.prepare("SELECT definition FROM workflows WHERE owner_id=?").bind(user.userId).all<{ definition: string }>();
    if (references.results.some(workflow => referencedResourceIds(parseDefinition(JSON.parse(workflow.definition))).includes(id))) throw new HistoryError("저장한 워크플로에서 사용 중인 자료예요. 다른 자료로 바꾼 뒤 저장해 주세요.", 409);
    const [deleted] = await this.db.batch([
      this.db.prepare("DELETE FROM resources WHERE id=? AND owner_id=?").bind(id, user.userId),
      this.audit(user, user.userId, "resource.delete", "resource", id, {}, timestamp()),
      this.db.prepare("DELETE FROM resource_comments WHERE resource_id=?").bind(id),
    ]); if (deleted.meta.changes !== 1) throw new HistoryError("이미 삭제된 자료예요.", 404);
  }
  /** 소유자 조건을 조회와 삭제 SQL에 반복한다. 공동 편집자의 블록 삭제와 워크플로 자체 삭제를 구분한다. */
  async deleteWorkflow(user: Identity, id: string) {
    await this.ownedWorkflow(user, id);
    const [deleted] = await this.db.batch([
      this.db.prepare("DELETE FROM workflows WHERE id=? AND owner_id=?").bind(id, user.userId),
      this.audit(user, user.userId, "workflow.delete", "workflow", id, {}, timestamp()),
      this.db.prepare("DELETE FROM workflow_versions WHERE workflow_id=? AND owner_id=?").bind(id, user.userId),
    ]); if (deleted.meta.changes !== 1) throw new HistoryError("이미 삭제된 워크플로예요.", 404);
  }
  /** 실행 가능한 설계와 현재 자료 권한을 검사한 뒤 새 불변 스냅샷을 발행한다. 버전 번호 할당과 감사 기록은 batch로 묶는다. */
  async publish(user: Identity, id: string, baseUpdatedAt: unknown): Promise<WorkflowVersion> {
    const row = await this.workflow(user, id, "edit"), current = this.present(row, user); this.checkBase(baseUpdatedAt, current);
    const definition = compileDefinition(current.definition); await this.checkResources(user, definition);
    const versionId = uid("version"), at = timestamp();
    const [published] = await this.db.batch([
      this.db.prepare("INSERT INTO workflow_versions(id,workflow_id,owner_id,number,name,description,definition,created_at) SELECT ?,id,owner_id,(SELECT COALESCE(MAX(number),0)+1 FROM workflow_versions WHERE workflow_id=?),name,description,?,? FROM workflows WHERE id=? AND updated_at=? AND (owner_id=? OR EXISTS(SELECT 1 FROM json_each(edit_emails) WHERE value=?))").bind(versionId, id, JSON.stringify(definition), at, id, baseUpdatedAt, user.userId, user.email.toLowerCase()),
      this.db.prepare("INSERT INTO audit_events(id,owner_id,actor_id,action,target_type,target_id,metadata,created_at) SELECT ?,owner_id,?,'workflow.publish','workflow',workflow_id,json_object('version',number),? FROM workflow_versions WHERE id=? AND changes()=1").bind(uid("audit"), user.userId, at, versionId),
    ]);
    if (published.meta.changes !== 1) throw conflict(this.present(await this.workflow(user, id), user)); return this.getVersion(user, id, versionId);
  }
  async versions(user: Identity, id: string) {
    const owner = await this.workflow(user, id);
    const rows = await this.db.prepare("SELECT id,workflow_id,number,name,description,created_at FROM workflow_versions WHERE owner_id=? AND workflow_id=? ORDER BY number DESC LIMIT 100").bind(owner.owner_id, id).all<Omit<VersionRow, "definition" | "owner_id">>();
    return rows.results.map(row => ({ id: row.id, workflowId: row.workflow_id, number: row.number, name: row.name, description: row.description, createdAt: row.created_at }));
  }
  /** 과거 버전도 현재 워크플로 읽기 권한이 있어야 조회할 수 있다. 버전 ID만으로 접근을 허용하지 않는다. */
  async getVersion(user: Identity, id: string, versionId: string): Promise<WorkflowVersion> {
    const owner = await this.workflow(user, id);
    const row = await this.db.prepare("SELECT * FROM workflow_versions WHERE owner_id=? AND workflow_id=? AND id=?").bind(owner.owner_id, id, safeId(versionId)).first<VersionRow>();
    if (!row) throw new HistoryError("발행한 버전을 찾을 수 없어요.", 404); return decodeVersion(row);
  }
  /** 과거 스냅샷을 현재 초안에 적용하며 saveWorkflow의 충돌·자료 권한 검사를 다시 통과해야 한다. */
  async restore(user: Identity, id: string, versionId: string, baseUpdatedAt: unknown) {
    const row = await this.workflow(user, id, "edit"); this.checkBase(baseUpdatedAt, this.present(row, user));
    const version = await this.getVersion(user, id, versionId);
    return this.saveWorkflow(user, { id, name: version.name, description: version.description, definition: version.definition }, baseUpdatedAt, "workflow.restore", version.number);
  }
  async diff(user: Identity, id: string, fromVersionId: string, toVersionId?: string) {
    const from = await this.getVersion(user, id, fromVersionId), to = toVersionId ? await this.getVersion(user, id, toVersionId) : decodeWorkflow(await this.workflow(user, id));
    return workflowDiff(from, to);
  }
  async comments(user: Identity, id: string) {
    const resource = await this.resource(user, id);
    const rows = await this.db.prepare("SELECT * FROM resource_comments WHERE resource_id=? ORDER BY created_at DESC LIMIT 100").bind(id).all<CommentRow>();
    return rows.results.map(row => ({ id: row.id, resourceId: row.resource_id, authorId: row.author_id, authorName: row.author_name, text: row.text, createdAt: row.created_at, canDelete: row.author_id === user.userId || resource.ownerId === user.userId }));
  }
  /** 자료를 읽을 수 있는 사용자만 댓글을 쓴다. 조회 뒤 공유 철회가 발생해도 INSERT의 현재 권한 조건으로 차단한다. */
  async createComment(user: Identity, id: string, value: unknown) {
    const resource = await this.resource(user, id);
    if (typeof value !== "string" || !value.trim() || value.length > 5000) throw new HistoryError("댓글은 1~5,000자로 입력해 주세요.");
    const comment = { id: uid("comment"), resourceId: id, authorId: user.userId, authorName: user.displayName.slice(0, 100), text: redactText(value.trim()), createdAt: timestamp(), canDelete: true };
    // Predicate repeats current sharing inside the transaction, closing revocation between read and insert.
    const allowed = "SELECT 1 FROM resources WHERE id=? AND (owner_id=? OR visibility='public' OR (visibility='selected' AND EXISTS(SELECT 1 FROM json_each(allowed_emails) WHERE value=?)))";
    const statement = resource.sample
      ? this.db.prepare("INSERT INTO resource_comments(id,resource_id,author_id,author_name,text,created_at) VALUES(?,?,?,?,?,?)").bind(comment.id, id, user.userId, comment.authorName, comment.text, comment.createdAt)
      : this.db.prepare(`INSERT INTO resource_comments(id,resource_id,author_id,author_name,text,created_at) SELECT ?,?,?,?,?,? WHERE EXISTS(${allowed})`).bind(comment.id, id, user.userId, comment.authorName, comment.text, comment.createdAt, id, user.userId, user.email.toLowerCase());
    const [written] = await this.db.batch([statement, this.audit(user, resource.ownerId, "comment.create", "resource", id, { commentId: comment.id }, comment.createdAt)]);
    if (written.meta.changes !== 1) throw new HistoryError("자료 공유가 바뀌어 댓글을 저장하지 못했어요.", 403); return comment;
  }
  /** 댓글 작성자 또는 자료 소유자만 삭제한다. 현재 자료 읽기 권한도 SQL에서 다시 확인한다. */
  async deleteComment(user: Identity, id: string, commentId: string) {
    const resource = await this.resource(user, id);
    const row = await this.db.prepare("SELECT * FROM resource_comments WHERE id=? AND resource_id=?").bind(safeId(commentId), id).first<CommentRow>();
    if (!row || row.author_id !== user.userId && resource.ownerId !== user.userId) throw new HistoryError("댓글을 삭제할 권한이 없어요.", 404);
    const statement = resource.sample
      ? this.db.prepare("DELETE FROM resource_comments WHERE id=? AND resource_id=? AND author_id=?").bind(commentId, id, user.userId)
      : this.db.prepare("DELETE FROM resource_comments WHERE id=? AND resource_id=? AND (author_id=? OR EXISTS(SELECT 1 FROM resources WHERE id=? AND owner_id=?)) AND EXISTS(SELECT 1 FROM resources WHERE id=? AND (owner_id=? OR visibility='public' OR (visibility='selected' AND EXISTS(SELECT 1 FROM json_each(allowed_emails) WHERE value=?))))").bind(commentId, id, user.userId, id, user.userId, id, user.userId, user.email.toLowerCase());
    const [deleted] = await this.db.batch([statement, this.audit(user, resource.ownerId, "comment.delete", "resource", id, { commentId }, timestamp())]);
    if (deleted.meta.changes !== 1) throw new HistoryError("댓글을 찾을 수 없어요.", 404);
  }
  async audits(user: Identity, targetType?: "workflow" | "resource", id?: string) {
    let ownerId = user.userId;
    if (targetType === "workflow" && id) {
      const row = await this.db.prepare("SELECT * FROM workflows WHERE id=?").bind(safeId(id)).first<WorkflowRow>();
      if (row) { if (!workflowAccess(decodeWorkflow(row), user).canRead) return []; ownerId = row.owner_id; }
    }
    const rows = await this.db.prepare(`SELECT id,actor_id,action,target_type,target_id,metadata,created_at FROM audit_events WHERE owner_id=?${targetType && id ? " AND target_type=? AND target_id=?" : ""} ORDER BY created_at DESC LIMIT 100`).bind(ownerId, ...(targetType && id ? [targetType, safeId(id)] : [])).all<{ id: string; actor_id: string; action: string; target_type: string; target_id: string; metadata: string; created_at: string }>();
    return rows.results.map(row => ({ id: row.id, actorId: row.actor_id, action: row.action, targetType: row.target_type, targetId: row.target_id, metadata: JSON.parse(row.metadata) as AuditMetadata, createdAt: row.created_at }));
  }
}

/** 구버전 기본값을 동일하게 이관한 뒤 노드 ID/연결 ID 기준으로 비교한다. 표시량을 제한한 결과이지 전체 실행 의미의 동등성 증명은 아니다. */
export function workflowDiff(from: Pick<Workflow, "name" | "description" | "definition">, to: Pick<Workflow, "name" | "description" | "definition">) {
  // Compare effective mappings/schemas consistently, even when the draft is incomplete.
  const effective = (definition: Workflow["definition"]) => migrateV4(migrateV3(migrateV2(migrateV1(parseDefinition(definition)))));
  from = { ...from, definition: effective(from.definition) }; to = { ...to, definition: effective(to.definition) };
  const before = from.definition, after = to.definition;
  const nodes = { added: after.nodes.filter(node => !before.nodes.some(n => n.id === node.id)).map(node => node.id), removed: before.nodes.filter(node => !after.nodes.some(n => n.id === node.id)).map(node => node.id), changed: after.nodes.flatMap(node => { const previous = before.nodes.find(n => n.id === node.id); if (!previous) return []; const fields = changedFields(previous as unknown as Record<string, unknown>, node as unknown as Record<string, unknown>, [...new Set([...Object.keys(previous), ...Object.keys(node)])]); return fields.length ? [{ id: node.id, title: node.title, fields }] : []; }) };
  const edges = { added: after.edges.filter(edge => !before.edges.some(e => e.id === edge.id)).map(edge => edge.id), removed: before.edges.filter(edge => !after.edges.some(e => e.id === edge.id)).map(edge => edge.id), changed: after.edges.filter(edge => { const prior = before.edges.find(e => e.id === edge.id); return prior && JSON.stringify(prior) !== JSON.stringify(edge); }).map(edge => edge.id) };
  const changes: { path: string; before: unknown; after: unknown }[] = []; let truncated = false;
  const display = (value: unknown) => { if (value === undefined) return null; const text = typeof value === "string" ? value : JSON.stringify(value); if (text.length > 2000) { truncated = true; return text.slice(0, 2000) + "…"; } return value; };
  const visit = (left: unknown, right: unknown, path: string) => {
    if (JSON.stringify(left) === JSON.stringify(right)) return;
    if (changes.length >= 100) { truncated = true; return; }
    if (left && right && typeof left === "object" && typeof right === "object" && !Array.isArray(left) && !Array.isArray(right)) {
      for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) visit((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key], path ? `${path}.${key}` : key);
    } else changes.push({ path, before: display(left), after: display(right) });
  };
  const normalized = (workflow: Pick<Workflow, "name" | "description" | "definition">) => ({ name: workflow.name, description: workflow.description, nodes: Object.fromEntries(workflow.definition.nodes.map(node => [node.id, node])), edges: Object.fromEntries(workflow.definition.edges.map(edge => [edge.id, edge])) });
  visit(normalized(from), normalized(to), "");
  return { nameChanged: from.name !== to.name, descriptionChanged: from.description !== to.description, nodes, edges, changes, truncated };
}
