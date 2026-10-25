import { canReadResource, parseDefinition, parseResource, sampleResources, uid, type Identity, type Resource, type Workflow } from "../../app/lib/model";
import { compileDefinition, migrateV1, migrateV2, migrateV3, migrateV4, referencedResourceIds } from "../../domain/workflow";
import { redactText } from "../../runtime/policy";

type WorkflowRow = { id: string; owner_id: string; name: string; description: string; definition: string; updated_at: string };
type ResourceRow = { id: string; owner_id: string; name: string; type: string; description: string; content: string; url: string; visibility: string; allowed_emails: string; created_at: string; updated_at: string };
type VersionRow = { id: string; workflow_id: string; owner_id: string; number: number; name: string; description: string; definition: string; created_at: string };
type CommentRow = { id: string; resource_id: string; author_id: string; author_name: string; text: string; created_at: string };
export type WorkflowVersion = { id: string; workflowId: string; number: number; name: string; description: string; definition: Workflow["definition"]; createdAt: string };
export type AuditMetadata = { fields?: string[]; visibility?: string; sharedUserCount?: number; version?: number; commentId?: string };
export class HistoryError extends Error {
  constructor(message: string, readonly status = 400, readonly current?: Workflow | Resource) { super(message); }
}
const decodeWorkflow = (row: WorkflowRow): Workflow => ({ id: row.id, name: row.name, description: row.description, definition: JSON.parse(row.definition), updatedAt: row.updated_at });
const decodeResource = (row: ResourceRow): Resource => ({ id: row.id, ownerId: row.owner_id, name: row.name, type: row.type as Resource["type"], description: row.description, content: row.content, url: row.url, visibility: row.visibility as Resource["visibility"], allowedEmails: JSON.parse(row.allowed_emails), createdAt: row.created_at, updatedAt: row.updated_at });
const decodeVersion = (row: VersionRow): WorkflowVersion => ({ id: row.id, workflowId: row.workflow_id, number: row.number, name: row.name, description: row.description, definition: JSON.parse(row.definition), createdAt: row.created_at });
const timestamp = (previous?: string) => new Date(Math.max(Date.now(), previous ? Date.parse(previous) + 1 : 0)).toISOString();
const conflict = (current?: Workflow | Resource) => new HistoryError("다른 곳에서 먼저 변경했어요. 현재 입력은 유지하고 최신 내용을 확인한 뒤 다시 저장해 주세요.", 409, current);
const resourceFields = ["name", "type", "description", "content", "url", "visibility", "allowedEmails"] as const;
function changedFields(before: Record<string, unknown>, after: Record<string, unknown>, fields: readonly string[]) { return fields.filter(field => JSON.stringify(before[field]) !== JSON.stringify(after[field])); }
function safeId(value: unknown) { if (typeof value !== "string" || !value || value.length > 100 || /[\x00-\x1f]/.test(value)) throw new HistoryError("대상 ID를 확인해 주세요."); return value; }

/** D1 batches keep mutation, immutable snapshot and metadata-only audit in one transaction. */
export class WorkflowHistoryRepository {
  constructor(private readonly db: D1Database) {}
  async recordAudit(user: Identity, action: "workflow.export", targetType: "workflow", targetId: string, metadata: Pick<AuditMetadata, "version" | "fields"> = {}) {
    if (action !== "workflow.export" || targetType !== "workflow") throw new HistoryError("지원하지 않는 감사 기록이에요.");
    const clean: AuditMetadata = {};
    if (Number.isSafeInteger(metadata.version) && metadata.version! > 0) clean.version = metadata.version;
    if (metadata.fields) clean.fields = metadata.fields.filter(field => ["language", "definition", "resources", "connections"].includes(field));
    await this.db.prepare("INSERT INTO audit_events(id,owner_id,actor_id,action,target_type,target_id,metadata,created_at) VALUES(?,?,?,?,?,?,?,?)").bind(uid("audit"), user.userId, user.userId, action, targetType, safeId(targetId), JSON.stringify(clean), timestamp()).run();
  }
  private audit(user: Identity, ownerId: string, action: string, targetType: "workflow" | "resource", targetId: string, metadata: AuditMetadata, at: string) {
    return this.db.prepare("INSERT INTO audit_events(id,owner_id,actor_id,action,target_type,target_id,metadata,created_at) SELECT ?,?,?,?,?,?,?,? WHERE changes()=1").bind(uid("audit"), ownerId, user.userId, action, targetType, targetId, JSON.stringify(metadata), at);
  }
  private async ownedWorkflow(user: Identity, id: string) {
    const row = await this.db.prepare("SELECT * FROM workflows WHERE id=? AND owner_id=?").bind(safeId(id), user.userId).first<WorkflowRow>();
    if (!row) throw new HistoryError("워크플로를 찾을 수 없어요.", 404); return row;
  }
  private async resource(user: Identity, id: string) {
    const sample = sampleResources.find(resource => resource.id === id);
    const row = sample ? null : await this.db.prepare("SELECT * FROM resources WHERE id=?").bind(safeId(id)).first<ResourceRow>();
    const resource = sample ?? (row ? decodeResource(row) : undefined);
    if (!resource || !canReadResource(resource, user)) throw new HistoryError("자료에 접근할 권한이 없거나 공유가 철회됐어요.", 404);
    return resource;
  }
  private async checkResources(user: Identity, definition: Workflow["definition"]) {
    for (const id of referencedResourceIds(definition)) try { await this.resource(user, id); } catch { throw new HistoryError("접근 권한이 없거나 삭제된 자료가 연결되어 있어요. 공유 상태를 확인해 주세요.", 403); }
  }
  private checkBase(base: unknown, current: Workflow | Resource) { if (typeof base !== "string" || base !== current.updatedAt) throw conflict(current); }
  async saveWorkflow(user: Identity, value: unknown, baseUpdatedAt: unknown): Promise<Workflow> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new HistoryError("저장할 워크플로를 확인해 주세요.");
    const data = value as Record<string, unknown>, id = safeId(data.id || uid("flow"));
    const existing = await this.db.prepare("SELECT * FROM workflows WHERE id=?").bind(id).first<WorkflowRow>();
    if (existing && existing.owner_id !== user.userId) throw new HistoryError("저장할 권한이 없어요.", 403);
    if (existing) this.checkBase(baseUpdatedAt, decodeWorkflow(existing));
    const name = typeof data.name === "string" ? data.name.trim() : "";
    if (!name || name.length > 80) throw new HistoryError("워크플로 이름을 1~80자로 입력해 주세요.");
    const definition = parseDefinition(data.definition); await this.checkResources(user, definition);
    const result: Workflow = { id, name, description: String(data.description ?? "").slice(0, 300), definition, updatedAt: timestamp(existing?.updated_at) };
    const statement = existing
      ? this.db.prepare("UPDATE workflows SET name=?,description=?,definition=?,updated_at=? WHERE id=? AND owner_id=? AND updated_at=?").bind(name, result.description, JSON.stringify(definition), result.updatedAt, id, user.userId, baseUpdatedAt)
      : this.db.prepare("INSERT INTO workflows(id,owner_id,name,description,definition,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING").bind(id, user.userId, name, result.description, JSON.stringify(definition), result.updatedAt);
    const fields = existing ? changedFields(decodeWorkflow(existing) as unknown as Record<string, unknown>, result as unknown as Record<string, unknown>, ["name", "description", "definition"]) : ["name", "description", "definition"];
    const [write] = await this.db.batch([statement, this.audit(user, user.userId, existing ? "workflow.update" : "workflow.create", "workflow", id, { fields }, result.updatedAt)]);
    if (write.meta.changes !== 1) throw conflict(existing ? decodeWorkflow(await this.ownedWorkflow(user, id)) : undefined);
    return result;
  }
  async createResource(user: Identity, value: unknown) {
    const input = parseResource(value), now = timestamp(); const result: Resource = { ...input, id: uid("res"), ownerId: user.userId, createdAt: now, updatedAt: now };
    await this.db.batch([
      this.db.prepare("INSERT INTO resources(id,owner_id,name,type,description,content,url,visibility,allowed_emails,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").bind(result.id, user.userId, input.name, input.type, input.description, input.content, input.url, input.visibility, JSON.stringify(input.allowedEmails), now, now),
      this.audit(user, user.userId, "resource.create", "resource", result.id, { fields: [...resourceFields], visibility: input.visibility, sharedUserCount: input.allowedEmails.length }, now),
    ]); return result;
  }
  async updateResource(user: Identity, id: string, value: unknown, baseUpdatedAt: unknown) {
    const existing = await this.db.prepare("SELECT * FROM resources WHERE id=? AND owner_id=?").bind(safeId(id), user.userId).first<ResourceRow>();
    if (!existing) throw new HistoryError("수정 권한이 없거나 삭제된 자료예요.", 404);
    const before = decodeResource(existing); this.checkBase(baseUpdatedAt, before);
    const input = parseResource(value), at = timestamp(existing.updated_at), result: Resource = { ...before, ...input, updatedAt: at };
    const [write] = await this.db.batch([
      this.db.prepare("UPDATE resources SET name=?,type=?,description=?,content=?,url=?,visibility=?,allowed_emails=?,updated_at=? WHERE id=? AND owner_id=? AND updated_at=?").bind(input.name, input.type, input.description, input.content, input.url, input.visibility, JSON.stringify(input.allowedEmails), at, id, user.userId, baseUpdatedAt),
      this.audit(user, user.userId, "resource.update", "resource", id, { fields: changedFields(before as unknown as Record<string, unknown>, input as unknown as Record<string, unknown>, resourceFields), visibility: input.visibility, sharedUserCount: input.allowedEmails.length }, at),
    ]);
    if (write.meta.changes !== 1) throw conflict(await this.resource(user, id)); return result;
  }
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
  async deleteWorkflow(user: Identity, id: string) {
    await this.ownedWorkflow(user, id);
    const [deleted] = await this.db.batch([
      this.db.prepare("DELETE FROM workflows WHERE id=? AND owner_id=?").bind(id, user.userId),
      this.audit(user, user.userId, "workflow.delete", "workflow", id, {}, timestamp()),
      this.db.prepare("DELETE FROM workflow_versions WHERE workflow_id=? AND owner_id=?").bind(id, user.userId),
    ]); if (deleted.meta.changes !== 1) throw new HistoryError("이미 삭제된 워크플로예요.", 404);
  }
  async publish(user: Identity, id: string, baseUpdatedAt: unknown): Promise<WorkflowVersion> {
    const row = await this.ownedWorkflow(user, id), current = decodeWorkflow(row); this.checkBase(baseUpdatedAt, current);
    const definition = compileDefinition(current.definition); await this.checkResources(user, definition);
    const versionId = uid("version"), at = timestamp();
    const [published] = await this.db.batch([
      this.db.prepare("INSERT INTO workflow_versions(id,workflow_id,owner_id,number,name,description,definition,created_at) SELECT ?,id,owner_id,(SELECT COALESCE(MAX(number),0)+1 FROM workflow_versions WHERE workflow_id=?),name,description,?,? FROM workflows WHERE id=? AND owner_id=? AND updated_at=?").bind(versionId, id, JSON.stringify(definition), at, id, user.userId, baseUpdatedAt),
      this.db.prepare("INSERT INTO audit_events(id,owner_id,actor_id,action,target_type,target_id,metadata,created_at) SELECT ?,owner_id,?,'workflow.publish','workflow',workflow_id,json_object('version',number),? FROM workflow_versions WHERE id=? AND changes()=1").bind(uid("audit"), user.userId, at, versionId),
    ]);
    if (published.meta.changes !== 1) throw conflict(decodeWorkflow(await this.ownedWorkflow(user, id))); return this.getVersion(user, id, versionId);
  }
  async versions(user: Identity, id: string) {
    await this.ownedWorkflow(user, id);
    const rows = await this.db.prepare("SELECT id,workflow_id,number,name,description,created_at FROM workflow_versions WHERE owner_id=? AND workflow_id=? ORDER BY number DESC LIMIT 100").bind(user.userId, id).all<Omit<VersionRow, "definition" | "owner_id">>();
    return rows.results.map(row => ({ id: row.id, workflowId: row.workflow_id, number: row.number, name: row.name, description: row.description, createdAt: row.created_at }));
  }
  async getVersion(user: Identity, id: string, versionId: string): Promise<WorkflowVersion> {
    await this.ownedWorkflow(user, id);
    const row = await this.db.prepare("SELECT * FROM workflow_versions WHERE owner_id=? AND workflow_id=? AND id=?").bind(user.userId, id, safeId(versionId)).first<VersionRow>();
    if (!row) throw new HistoryError("발행한 버전을 찾을 수 없어요.", 404); return decodeVersion(row);
  }
  async restore(user: Identity, id: string, versionId: string, baseUpdatedAt: unknown) {
    const row = await this.ownedWorkflow(user, id); this.checkBase(baseUpdatedAt, decodeWorkflow(row));
    const version = await this.getVersion(user, id, versionId); await this.checkResources(user, version.definition);
    const updatedAt = timestamp(row.updated_at), [write] = await this.db.batch([
      this.db.prepare("UPDATE workflows SET name=?,description=?,definition=?,updated_at=? WHERE owner_id=? AND id=? AND updated_at=?").bind(version.name, version.description, JSON.stringify(version.definition), updatedAt, user.userId, id, baseUpdatedAt),
      this.audit(user, user.userId, "workflow.restore", "workflow", id, { fields: ["name", "description", "definition"], version: version.number }, updatedAt),
    ]); if (write.meta.changes !== 1) throw conflict(decodeWorkflow(await this.ownedWorkflow(user, id)));
    return { id, name: version.name, description: version.description, definition: version.definition, updatedAt } satisfies Workflow;
  }
  async diff(user: Identity, id: string, fromVersionId: string, toVersionId?: string) {
    const from = await this.getVersion(user, id, fromVersionId), to = toVersionId ? await this.getVersion(user, id, toVersionId) : decodeWorkflow(await this.ownedWorkflow(user, id));
    return workflowDiff(from, to);
  }
  async comments(user: Identity, id: string) {
    const resource = await this.resource(user, id);
    const rows = await this.db.prepare("SELECT * FROM resource_comments WHERE resource_id=? ORDER BY created_at DESC LIMIT 100").bind(id).all<CommentRow>();
    return rows.results.map(row => ({ id: row.id, resourceId: row.resource_id, authorId: row.author_id, authorName: row.author_name, text: row.text, createdAt: row.created_at, canDelete: row.author_id === user.userId || resource.ownerId === user.userId }));
  }
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
    const rows = await this.db.prepare(`SELECT id,actor_id,action,target_type,target_id,metadata,created_at FROM audit_events WHERE owner_id=?${targetType && id ? " AND target_type=? AND target_id=?" : ""} ORDER BY created_at DESC LIMIT 100`).bind(user.userId, ...(targetType && id ? [targetType, safeId(id)] : [])).all<{ id: string; actor_id: string; action: string; target_type: string; target_id: string; metadata: string; created_at: string }>();
    return rows.results.map(row => ({ id: row.id, actorId: row.actor_id, action: row.action, targetType: row.target_type, targetId: row.target_id, metadata: JSON.parse(row.metadata) as AuditMetadata, createdAt: row.created_at }));
  }
}

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
