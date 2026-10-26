/** 첨부 바이트 저장과 자료 권한 검사를 분리한다. 불변 파일 ID를 공유해도 현재 자료 권한 없이 바이트를 읽을 수 없다. */
import { uid, type Identity, type Resource } from "../app/lib/model";
import { RESOURCE_FILE_MAX_BYTES, EXPORT_RESOURCE_FILES_MAX_BYTES, type ResourceAttachment, type ResourceFilePayload } from "../domain/resource-contract";
import { safeResourcePath } from "../domain/resource-validation";
import { ResourceHistoryRepository, attachmentFromRow, type ResourceFileRow } from "./repositories/resource-history";
import { HistoryError } from "./repositories/errors";

export interface ResourceFileStore { readonly kind:"r2"|"d1-test"; put(key:string,bytes:Uint8Array):Promise<void>; get(key:string):Promise<Uint8Array|undefined>; delete(key:string):Promise<void> }
export class R2ResourceFileStore implements ResourceFileStore {
  readonly kind="r2";
  constructor(private bucket:R2Bucket){}
  async put(key:string,bytes:Uint8Array){await this.bucket.put(key,Uint8Array.from(bytes).buffer as ArrayBuffer);}
  async get(key:string){const object=await this.bucket.get(key);return object?new Uint8Array(await object.arrayBuffer()):undefined;}
  async delete(key:string){await this.bucket.delete(key);}
}
/** 운영 미설정을 숨기지 않도록 테스트 모드에서만 환경 팩토리가 선택하는 영속 D1 어댑터. */
export class D1TestResourceFileStore implements ResourceFileStore {
  readonly kind="d1-test";
  constructor(private db:D1Database){}
  async put(key:string,bytes:Uint8Array){const statements=[];for(let offset=0;offset<bytes.length;offset+=48000){const part=bytes.slice(offset,offset+48000);let binary="";for(const byte of part)binary+=String.fromCharCode(byte);statements.push(this.db.prepare("INSERT INTO resource_file_chunks(file_id,part,data) VALUES(?,?,?)").bind(key,offset/48000,btoa(binary)));}if(!statements.length)statements.push(this.db.prepare("INSERT INTO resource_file_chunks(file_id,part,data) VALUES(?,0,'')").bind(key));await this.db.batch(statements);}
  async get(key:string){const rows=await this.db.prepare("SELECT part,data FROM resource_file_chunks WHERE file_id=? ORDER BY part").bind(key).all<{part:number;data:string}>();if(!rows.results.length)return undefined;let length=0;const parts=rows.results.map((r,index)=>{if(r.part!==index)throw new Error("첨부 파일 조각이 누락됐어요.");const raw=atob(r.data),bytes=Uint8Array.from(raw,c=>c.charCodeAt(0));length+=bytes.length;if(length>RESOURCE_FILE_MAX_BYTES)throw new Error("첨부 크기 한도를 초과했어요.");return bytes;});const result=new Uint8Array(length);let offset=0;for(const part of parts){result.set(part,offset);offset+=part.length;}return result;}
  async delete(key:string){await this.db.prepare("DELETE FROM resource_file_chunks WHERE file_id=?").bind(key).run();}
}
export async function resourceFileHash(bytes:Uint8Array){return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",Uint8Array.from(bytes).buffer)),byte=>byte.toString(16).padStart(2,"0")).join("");}

export class ResourceFilesRepository {
  constructor(private db:D1Database,private store?:ResourceFileStore){}
  status(){return {configured:!!this.store,kind:this.store?.kind??"unconfigured",maxFileBytes:RESOURCE_FILE_MAX_BYTES,message:this.store?this.store.kind==="r2"?"R2 첨부 저장소 설정됨 · 외부 서비스 연결 검증과 별개":"로컬 테스트 D1 첨부 저장소":"첨부 저장소가 미설정이에요. 운영 환경의 BUCKET R2 바인딩을 설정해 주세요."};}
  private configured(){if(!this.store)throw new HistoryError(this.status().message,503);return this.store;}
  async upload(user:Identity,pathValue:unknown,mimeValue:unknown,bytes:Uint8Array):Promise<ResourceAttachment>{
    const store=this.configured();let path:string;try{path=safeResourcePath(pathValue);}catch(error){throw new HistoryError(error instanceof Error?error.message:"첨부 경로를 확인해 주세요.",400);}if(bytes.byteLength>RESOURCE_FILE_MAX_BYTES)throw new HistoryError("첨부 파일은 각각 5MB 이하여야 해요.",413);
    const mimeType=typeof mimeValue==="string"&&/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(mimeValue)?mimeValue:"application/octet-stream",id=uid("file"),time=new Date().toISOString(),sha256=await resourceFileHash(bytes),key=`resource-files/${id}`;
    await store.put(key,bytes);
    try {await this.db.prepare("INSERT INTO resource_files(id,owner_id,resource_id,path,mime_type,size,sha256,storage_key,created_at) VALUES(?,?,NULL,?,?,?,?,?,?)").bind(id,user.userId,path,mimeType,bytes.byteLength,sha256,key,time).run();}catch(error){await store.delete(key).catch(()=>{});throw error;}
    return {id,path,mimeType,size:bytes.byteLength,sha256,createdAt:time};
  }
  async read(user:Identity,id:string):Promise<{file:ResourceAttachment;bytes:Uint8Array}>{
    if(!/^[A-Za-z0-9_-]{1,100}$/.test(id))throw new HistoryError("첨부 ID를 확인해 주세요.");
    const row=await this.db.prepare("SELECT * FROM resource_files WHERE id=?").bind(id).first<ResourceFileRow>();
    if(!row)throw new HistoryError("첨부 파일을 찾을 수 없어요.",404);
    if(row.resource_id){const resource=await new ResourceHistoryRepository(this.db).get(user,row.resource_id);if(row.owner_id!==user.userId&&!resource.files?.some(f=>f.id===id))throw new HistoryError("현재 공유한 첨부가 아니에요.",403);}
    else if(row.owner_id!==user.userId)throw new HistoryError("첨부 파일 접근 권한이 없어요.",403);
    const bytes=await this.configured().get(row.storage_key);if(!bytes)throw new HistoryError("첨부 원본을 찾을 수 없어요. 원본 파일을 다시 올려 주세요.",404);
    if(bytes.byteLength!==row.size||await resourceFileHash(bytes)!==row.sha256)throw new HistoryError("첨부 파일 내용이 등록 버전과 달라요. 새 파일로 등록해 주세요.",409);
    return {file:attachmentFromRow(row),bytes};
  }
  async resolve(user:Identity,resources:Resource[]):Promise<ResourceFilePayload[]>{
    const result:ResourceFilePayload[]=[];let bytes=0;
    for(const resource of resources){if(resource.files?.length)await new ResourceHistoryRepository(this.db).get(user,resource.id);for(const expected of resource.files??[]){const actual=await this.read(user,expected.id);if(actual.file.sha256!==expected.sha256||actual.file.path!==expected.path)throw new HistoryError("자료 첨부가 변경됐어요. 최신 자료로 다시 내보내 주세요.",409);bytes+=actual.bytes.byteLength;if(bytes>EXPORT_RESOURCE_FILES_MAX_BYTES)throw new HistoryError("내보낼 전체 첨부는 20MB 이하여야 해요.",413);result.push({resourceId:resource.id,...actual});}}
    return result;
  }
}
