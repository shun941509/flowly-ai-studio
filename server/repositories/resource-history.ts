/** 자료 본문·확장 설정·첨부 목록의 불변 버전과 현재 권한을 함께 관리한다. 파일 바이트는 별도 저장 어댑터 책임이다. */
import { canReadResource, parseDefinition, parseResource, sampleResources, uid, type Identity, type Resource } from "../../app/lib/model";
import type { ResourceAttachment, ResourceVersion } from "../../domain/resource-contract";
import { referencedResourceIds } from "../../domain/workflow";
import { workflowAccess } from "../../domain/workflow-access";
import { HistoryError } from "./errors";

export type ResourceRow={id:string;owner_id:string;name:string;type:string;description:string;content:string;url:string;visibility:string;allowed_emails:string;created_at:string;updated_at:string;details?:string;files?:string};
export type ResourceFileRow={id:string;owner_id:string;resource_id:string|null;path:string;mime_type:string;size:number;sha256:string;storage_key:string;created_at:string};
export const resourceFromRow=(r:ResourceRow):Resource=>({id:r.id,ownerId:r.owner_id,name:r.name,type:r.type as Resource["type"],description:r.description,content:r.content,url:r.url,visibility:r.visibility as Resource["visibility"],allowedEmails:JSON.parse(r.allowed_emails),createdAt:r.created_at,updatedAt:r.updated_at,...(r.details&&r.details!=="null"?{details:JSON.parse(r.details)}:{}),...(r.files&&r.files!=="[]"?{files:JSON.parse(r.files)}:{})});
export const attachmentFromRow=(r:ResourceFileRow):ResourceAttachment=>({id:r.id,path:r.path,mimeType:r.mime_type,size:r.size,sha256:r.sha256,createdAt:r.created_at});
const at=(previous?:string)=>new Date(Math.max(Date.now(),previous?Date.parse(previous)+1:0)).toISOString();
const validId=(id:unknown)=>{if(typeof id!=="string"||!/^[A-Za-z0-9_-]{1,100}$/.test(id))throw new HistoryError("자료 ID를 확인해 주세요.");return id;};
const base=(value:unknown,resource:Resource)=>{if(value!==resource.updatedAt)throw new HistoryError("다른 곳에서 자료가 변경됐어요. 최신 내용과 비교한 뒤 다시 저장해 주세요.",409,resource);};
const permission="(owner_id=? OR visibility='public' OR (visibility='selected' AND EXISTS(SELECT 1 FROM json_each(allowed_emails) WHERE value=?)))";

export class ResourceHistoryRepository {
  constructor(private db:D1Database){}
  async get(user:Identity,id:string,owner=false):Promise<Resource>{
    const sample=sampleResources.find(r=>r.id===id);if(sample&&!owner)return structuredClone(sample);
    const row=await this.db.prepare("SELECT * FROM resources WHERE id=?").bind(validId(id)).first<ResourceRow>();
    if(!row||owner&&row.owner_id!==user.userId||!canReadResource(resourceFromRow(row),user))throw new HistoryError("자료 접근 권한이 없거나 공유가 철회됐어요.",owner?404:403);
    return resourceFromRow(row);
  }
  private audit(user:Identity,id:string,action:string,time:string){return this.db.prepare("INSERT INTO audit_events(id,owner_id,actor_id,action,target_type,target_id,metadata,created_at) SELECT ?,?,?,?,'resource',?,'{}',? WHERE EXISTS(SELECT 1 FROM resources WHERE id=? AND owner_id=? AND updated_at=?)").bind(uid("audit"),user.userId,user.userId,action,id,time,id,user.userId,time);}
  private snapshot(user:Identity,resource:Resource){return this.db.prepare("INSERT INTO resource_versions(id,resource_id,number,actor_id,snapshot,created_at) SELECT ?,?,(SELECT COALESCE(MAX(number),0)+1 FROM resource_versions WHERE resource_id=?),?,?,? WHERE EXISTS(SELECT 1 FROM resources WHERE id=? AND owner_id=? AND updated_at=?)").bind(uid("rv"),resource.id,resource.id,user.userId,JSON.stringify(resource),resource.updatedAt,resource.id,user.userId,resource.updatedAt);}
  /** 클라이언트의 해시/소속을 신뢰하지 않고 불변 파일 메타데이터와 현재 소유자를 대조한다. */
  private async checkFiles(user:Identity,files:ResourceAttachment[],resourceId:string,clones:ResourceFileRow[]=[]){
    for(const file of files){const row=clones.find(r=>r.id===file.id)??await this.db.prepare("SELECT * FROM resource_files WHERE id=? AND owner_id=?").bind(file.id,user.userId).first<ResourceFileRow>();if(!row||row.resource_id&&row.resource_id!==resourceId||JSON.stringify(attachmentFromRow(row))!==JSON.stringify(file))throw new HistoryError("첨부 파일의 소유권·경로·내용이 달라요. 현재 파일을 다시 올려 주세요.",403);}
  }
  async create(user:Identity,value:unknown,origin?:{id:string;updatedAt:string},clones:ResourceFileRow[]=[]){
    const input=parseResource(value),now=at(),resource:Resource={...input,id:uid("res"),ownerId:user.userId,createdAt:now,updatedAt:now};
    await this.checkFiles(user,input.files??[],resource.id,clones);
    // 사전 읽기 뒤 다른 저장이 staged 파일을 먼저 차지할 수 있다. 같은 D1 트랜잭션의 INSERT 조건에서 다시 검사한다.
    const claimedFiles=(input.files??[]).filter(file=>!clones.some(row=>row.id===file.id));
    const predicates=[...(origin?[`EXISTS(SELECT 1 FROM resources WHERE id=? AND updated_at=? AND ${permission})`]:[]),...claimedFiles.map(()=>"EXISTS(SELECT 1 FROM resource_files WHERE id=? AND owner_id=? AND resource_id IS NULL)")];
    const condition=predicates.length?` WHERE ${predicates.join(" AND ")}`:"";
    const statements=[this.db.prepare("INSERT INTO resources(id,owner_id,name,type,description,content,url,visibility,allowed_emails,created_at,updated_at,details,files) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?"+condition).bind(resource.id,user.userId,input.name,input.type,input.description,input.content,input.url,input.visibility,JSON.stringify(input.allowedEmails),now,now,JSON.stringify(input.details??null),JSON.stringify(input.files??[]),...(origin?[origin.id,origin.updatedAt,user.userId,user.email.toLowerCase()]:[]),...claimedFiles.flatMap(file=>[file.id,user.userId]))];
    for(const row of clones)statements.push(this.db.prepare("INSERT INTO resource_files(id,owner_id,resource_id,path,mime_type,size,sha256,storage_key,created_at) SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM resources WHERE id=? AND owner_id=?)").bind(row.id,user.userId,resource.id,row.path,row.mime_type,row.size,row.sha256,row.storage_key,row.created_at,resource.id,user.userId));
    for(const file of input.files??[])if(!clones.some(r=>r.id===file.id))statements.push(this.db.prepare("UPDATE resource_files SET resource_id=? WHERE id=? AND owner_id=? AND resource_id IS NULL AND EXISTS(SELECT 1 FROM resources WHERE id=? AND updated_at=?)").bind(resource.id,file.id,user.userId,resource.id,now));
    statements.push(this.snapshot(user,resource),this.audit(user,resource.id,"resource.create",now));
    const [created]=await this.db.batch(statements);if(created.meta.changes!==1)throw new HistoryError("원본 자료의 권한이나 버전이 바뀌어 사본을 만들지 못했어요.",409);return resource;
  }
  async update(user:Identity,id:string,value:unknown,baseUpdatedAt:unknown){
    const before=await this.get(user,id,true);base(baseUpdatedAt,before);
    if(!value||typeof value!=="object"||Array.isArray(value))throw new HistoryError("자료 내용을 확인해 주세요.");
    const input=parseResource({...before,...value}),time=at(before.updatedAt),token=uid("write"),resource:Resource={...before,...input,details:input.details,files:input.files,updatedAt:time};
    await this.checkFiles(user,input.files??[],id);
    const guard="EXISTS(SELECT 1 FROM resources WHERE id=? AND owner_id=? AND write_token=?)";
    const fileGuard=(input.files??[]).map(()=>" AND EXISTS(SELECT 1 FROM resource_files WHERE id=? AND owner_id=? AND (resource_id IS NULL OR resource_id=?))").join("");
    const statements=[this.db.prepare("UPDATE resources SET name=?,type=?,description=?,content=?,url=?,visibility=?,allowed_emails=?,details=?,files=?,updated_at=?,write_token=? WHERE id=? AND owner_id=? AND updated_at=?"+fileGuard).bind(input.name,input.type,input.description,input.content,input.url,input.visibility,JSON.stringify(input.allowedEmails),JSON.stringify(input.details??null),JSON.stringify(input.files??[]),time,token,id,user.userId,baseUpdatedAt,...(input.files??[]).flatMap(file=>[file.id,user.userId,id]))];
    statements.push(this.db.prepare(`INSERT INTO resource_versions(id,resource_id,number,actor_id,snapshot,created_at) SELECT ?,?,1,?,?,? WHERE ${guard} AND NOT EXISTS(SELECT 1 FROM resource_versions WHERE resource_id=?)`).bind(uid("rv"),id,user.userId,JSON.stringify(before),before.updatedAt,id,user.userId,token,id));
    for(const file of input.files??[])statements.push(this.db.prepare(`UPDATE resource_files SET resource_id=? WHERE id=? AND owner_id=? AND (resource_id IS NULL OR resource_id=?) AND ${guard}`).bind(id,file.id,user.userId,id,id,user.userId,token));
    statements.push(this.db.prepare(`INSERT INTO resource_versions(id,resource_id,number,actor_id,snapshot,created_at) SELECT ?,?,(SELECT COALESCE(MAX(number),0)+1 FROM resource_versions WHERE resource_id=?),?,?,? WHERE ${guard}`).bind(uid("rv"),id,id,user.userId,JSON.stringify(resource),time,id,user.userId,token));
    statements.push(this.db.prepare(`INSERT INTO audit_events(id,owner_id,actor_id,action,target_type,target_id,metadata,created_at) SELECT ?,?,?,'resource.update','resource',?,'{}',? WHERE ${guard}`).bind(uid("audit"),user.userId,user.userId,id,time,id,user.userId,token));
    const [written]=await this.db.batch(statements);if(written.meta.changes!==1)throw new HistoryError("다른 곳에서 자료가 변경됐어요. 최신 자료를 확인해 주세요.",409,await this.get(user,id,true));return resource;
  }
  async versions(user:Identity,id:string):Promise<ResourceVersion[]>{await this.get(user,id,true);const rows=await this.db.prepare("SELECT * FROM resource_versions WHERE resource_id=? ORDER BY number DESC LIMIT 100").bind(id).all<{id:string;resource_id:string;number:number;actor_id:string;snapshot:string;created_at:string}>();return rows.results.map(r=>({id:r.id,resourceId:r.resource_id,number:r.number,actorId:r.actor_id,createdAt:r.created_at,snapshot:JSON.parse(r.snapshot)}));}
  async restore(user:Identity,id:string,versionId:string,baseUpdatedAt:unknown){const current=await this.get(user,id,true);base(baseUpdatedAt,current);const row=await this.db.prepare("SELECT snapshot FROM resource_versions WHERE id=? AND resource_id=?").bind(validId(versionId),id).first<{snapshot:string}>();if(!row)throw new HistoryError("자료 버전을 찾을 수 없어요.",404);const prior=JSON.parse(row.snapshot) as Resource;return this.update(user,id,{...prior,details:prior.details??null,files:prior.files??[],visibility:current.visibility,allowedEmails:current.allowedEmails},baseUpdatedAt);}
  /** 공유 자료의 수정본은 새 소유자의 비공개 사본으로 만든다. 원본 변경은 현재 소유자와 CAS 모두 필요하다. */
  async import(user:Identity,sourceId:string,baseUpdatedAt:unknown,mode:unknown,value:unknown){
    if(mode!=="copy"&&mode!=="version")throw new HistoryError("자료는 사본 또는 새 버전으로 가져와 주세요.");
    const source=await this.get(user,sourceId);base(baseUpdatedAt,source);
    if(mode==="version"){if(source.ownerId!==user.userId||source.sample)throw new HistoryError("공유받은 자료는 내 사본으로 저장해 주세요.",403);return this.update(user,sourceId,value,baseUpdatedAt);}
    const input=parseResource(value),clones:ResourceFileRow[]=[],ids=new Map<string,string>();
    for(const file of input.files??[]){if(!(source.files??[]).some(f=>f.id===file.id))continue;const row=await this.db.prepare("SELECT * FROM resource_files WHERE id=? AND resource_id=?").bind(file.id,sourceId).first<ResourceFileRow>();if(!row||JSON.stringify(file)!==JSON.stringify(attachmentFromRow(row)))throw new HistoryError("공유 첨부가 바뀌었어요. 다시 비교해 주세요.",409);const clone={...row,id:uid("file"),owner_id:user.userId,resource_id:null,created_at:at()};clones.push(clone);ids.set(file.id,clone.id);}
    const files=input.files?.map(file=>{const clone=clones.find(row=>row.id===ids.get(file.id));return clone?attachmentFromRow(clone):file;});
    const details=input.details?structuredClone(input.details):undefined;
    if(details?.skill?.executions)for(const entry of details.skill.executions)entry.entryFileId=ids.get(entry.entryFileId)??entry.entryFileId;
    if(details?.document?.originalFileId)details.document.originalFileId=ids.get(details.document.originalFileId)??details.document.originalFileId;
    return this.create(user,{...input,files,details,visibility:"private",allowedEmails:[]},source.sample?undefined:{id:source.id,updatedAt:source.updatedAt},clones);
  }
  async impact(user:Identity,id:string){await this.get(user,id);const rows=await this.db.prepare("SELECT * FROM workflows").all<{id:string;owner_id:string;name:string;definition:string;visibility:string;read_emails:string;edit_emails:string}>();const workflows=rows.results.flatMap(row=>{const access=workflowAccess({ownerId:row.owner_id,visibility:row.visibility as "private"|"selected"|"public",readEmails:JSON.parse(row.read_emails||"[]"),editEmails:JSON.parse(row.edit_emails||"[]")},user);if(!access.canRead)return [];try{return referencedResourceIds(parseDefinition(JSON.parse(row.definition))).includes(id)?[{id:row.id,name:row.name,canEdit:access.canEdit}]:[];}catch{return [];}});return {workflows,scope:"현재 읽을 수 있는 저장 워크플로 기준이며 이미 내보낸 오프라인 사본은 회수되지 않아요."};}
}
