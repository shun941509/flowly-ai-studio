import type { RuntimeRun } from "../../runtime/types";

type Row = {id:string; owner_id:string; request_hash:string; status:string; document:string; revision:number; cancel_requested:number; lease_owner:string|null;lease_until:number};
const LEASE_MS = 150_000;
export class RuntimeRepository {
  constructor(private db:D1Database) {}
  async create(run:RuntimeRun,key:string,hash:string) {
    await this.db.prepare("INSERT INTO runtime_runs (id,owner_id,idempotency_key,request_hash,status,document,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(owner_id,idempotency_key) DO NOTHING").bind(run.id,run.owner.userId,key,hash,run.status,JSON.stringify(run),run.createdAt,run.updatedAt).run();
    const row=await this.db.prepare("SELECT * FROM runtime_runs WHERE owner_id=? AND idempotency_key=?").bind(run.owner.userId,key).first<Row>();
    if(!row)throw new Error("실행을 저장하지 못했어요.");
    if(row.request_hash!==hash)throw new Error("같은 실행 요청 키에 다른 입력을 사용할 수 없어요. 새 실행을 시작해 주세요.");
    return JSON.parse(row.document) as RuntimeRun;
  }
  async get(ownerId:string,id:string) {
    const row=await this.db.prepare("SELECT document FROM runtime_runs WHERE owner_id=? AND id=?").bind(ownerId,id).first<{document:string}>();
    return row?JSON.parse(row.document) as RuntimeRun:null;
  }
  async list(ownerId:string) {
    const rows=await this.db.prepare("SELECT document FROM runtime_runs WHERE owner_id=? ORDER BY created_at DESC LIMIT 50").bind(ownerId).all<{document:string}>();
    return rows.results.map(row=>JSON.parse(row.document) as RuntimeRun);
  }
  async cancel(ownerId:string,id:string) {
    return this.db.prepare("UPDATE runtime_runs SET cancel_requested=1 WHERE owner_id=? AND id=? AND status IN ('queued','running','waiting_approval','waiting_review','waiting_input')").bind(ownerId,id).run();
  }
  async recoverable() {
    const rows=await this.db.prepare("SELECT id,owner_id FROM runtime_runs WHERE lease_until<? AND (status IN ('queued','running') OR (status IN ('waiting_approval','waiting_review','waiting_input') AND (cancel_requested=1 OR EXISTS(SELECT 1 FROM json_tree(document) WHERE type='object' AND json_extract(CASE WHEN type='object' THEN value ELSE '{}' END,'$.status')='pending' AND json_extract(CASE WHEN type='object' THEN value ELSE '{}' END,'$.expiresAt')<=?)))) ORDER BY created_at LIMIT 3").bind(Date.now(),new Date().toISOString()).all<{id:string;owner_id:string}>();
    return rows.results;
  }
  async claim(ownerId:string,id:string,waiting=false) {
    const token=crypto.randomUUID(), now=Date.now();
    const allowed=waiting?"('queued','running','waiting_approval','waiting_review','waiting_input')":"('queued','running')";
    const result=await this.db.prepare(`UPDATE runtime_runs SET lease_owner=?,lease_until=? WHERE owner_id=? AND id=? AND lease_until<? AND status IN ${allowed}`).bind(token,now+LEASE_MS,ownerId,id,now).run();
    if(result.meta.changes!==1)return null;
    const row=await this.db.prepare("SELECT * FROM runtime_runs WHERE owner_id=? AND id=? AND lease_owner=?").bind(ownerId,id,token).first<Row>();
    if(!row)return null;
    let revision=row.revision;
    return {
      run:JSON.parse(row.document) as RuntimeRun,
      save:async(run:RuntimeRun)=>{
        const result=await this.db.prepare("UPDATE runtime_runs SET document=?,status=?,revision=revision+1,lease_until=?,updated_at=? WHERE owner_id=? AND id=? AND lease_owner=? AND revision=? AND lease_until>?").bind(JSON.stringify(run),run.status,Date.now()+LEASE_MS,run.updatedAt,ownerId,id,token,revision,Date.now()).run();
        if(result.meta.changes!==1)throw new Error("실행 처리 권한이 만료되었어요. 기록을 새로고침해 주세요.");
        revision++;
      },
      isCancelled:async()=>{
        const current=await this.db.prepare("SELECT cancel_requested FROM runtime_runs WHERE owner_id=? AND id=? AND lease_owner=? AND lease_until>?").bind(ownerId,id,token,Date.now()).first<{cancel_requested:number}>();
        if(!current)throw new Error("실행 처리 권한이 만료되었어요.");
        return current.cancel_requested===1;
      },
      release:async()=>{await this.db.prepare("UPDATE runtime_runs SET lease_owner=NULL,lease_until=0 WHERE owner_id=? AND id=? AND lease_owner=?").bind(ownerId,id,token).run();},
    };
  }
}
