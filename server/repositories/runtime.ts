/** D1 실행 저장소. 사용자 범위·요청 중복 방지·임대 잠금·revision 비교를 한 경계에서 관리한다. */
import type { RuntimeRun } from "../../runtime/types";

type Row = {id:string; owner_id:string; request_hash:string; status:string; document:string; revision:number; cancel_requested:number; lease_owner:string|null;lease_until:number};
const LEASE_MS = 150_000;
export class RuntimeRepository {
  constructor(private db:D1Database) {}
  /** 같은 사용자/요청 키는 한 실행으로 수렴한다. 기존 키의 요청 해시가 다르면 재사용을 거절한다. */
  async create(run:RuntimeRun,key:string,hash:string) {
    await this.db.prepare("INSERT INTO runtime_runs (id,owner_id,idempotency_key,request_hash,status,document,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(owner_id,idempotency_key) DO NOTHING").bind(run.id,run.owner.userId,key,hash,run.status,JSON.stringify(run),run.createdAt,run.updatedAt).run();
    const row=await this.db.prepare("SELECT * FROM runtime_runs WHERE owner_id=? AND idempotency_key=?").bind(run.owner.userId,key).first<Row>();
    if(!row)throw new Error("실행을 저장하지 못했어요.");
    if(row.request_hash!==hash)throw new Error("같은 실행 요청 키에 다른 입력을 사용할 수 없어요. 새 실행을 시작해 주세요.");
    return JSON.parse(row.document) as RuntimeRun;
  }
  /** 실행 ID뿐 아니라 ownerId도 조건에 넣어 다른 사용자의 실행을 조회하지 못하게 한다. */
  async get(ownerId:string,id:string) {
    const row=await this.db.prepare("SELECT document FROM runtime_runs WHERE owner_id=? AND id=?").bind(ownerId,id).first<{document:string}>();
    return row?JSON.parse(row.document) as RuntimeRun:null;
  }
  async list(ownerId:string) {
    const rows=await this.db.prepare("SELECT document FROM runtime_runs WHERE owner_id=? ORDER BY created_at DESC LIMIT 50").bind(ownerId).all<{document:string}>();
    return rows.results.map(row=>JSON.parse(row.document) as RuntimeRun);
  }
  /** 취소 의사를 지속 저장한다. 외부 작업을 강제 중단한 것으로 표시하지 않고 실행기가 안전한 지점에서 확인한다. */
  async cancel(ownerId:string,id:string) {
    return this.db.prepare("UPDATE runtime_runs SET cancel_requested=1 WHERE owner_id=? AND id=? AND status IN ('queued','running','waiting_approval','waiting_review','waiting_input')").bind(ownerId,id).run();
  }
  /** 임대가 만료된 진행 실행과 취소/만료 처리할 대기 실행만 선택한다. 한 번에 복구할 수를 제한한다. */
  async recoverable() {
    const rows=await this.db.prepare("SELECT id,owner_id FROM runtime_runs WHERE lease_until<? AND (status IN ('queued','running') OR (status IN ('waiting_approval','waiting_review','waiting_input') AND (cancel_requested=1 OR EXISTS(SELECT 1 FROM json_tree(document) WHERE type='object' AND json_extract(CASE WHEN type='object' THEN value ELSE '{}' END,'$.status')='pending' AND json_extract(CASE WHEN type='object' THEN value ELSE '{}' END,'$.expiresAt')<=?)))) ORDER BY created_at LIMIT 3").bind(Date.now(),new Date().toISOString()).all<{id:string;owner_id:string}>();
    return rows.results;
  }
  /** 원자적 UPDATE로 임대 토큰을 획득한다. save는 토큰·revision·만료를 모두 비교해 이전 작업자의 늦은 저장을 거절한다. */
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
      // 상태 JSON과 revision을 한 UPDATE로 저장한다. 임대 갱신에 실패하면 그 작업자는 더 이상 기록을 쓰면 안 된다.
      save:async(run:RuntimeRun)=>{
        const result=await this.db.prepare("UPDATE runtime_runs SET document=?,status=?,revision=revision+1,lease_until=?,updated_at=? WHERE owner_id=? AND id=? AND lease_owner=? AND revision=? AND lease_until>?").bind(JSON.stringify(run),run.status,Date.now()+LEASE_MS,run.updatedAt,ownerId,id,token,revision,Date.now()).run();
        if(result.meta.changes!==1)throw new Error("실행 처리 권한이 만료되었어요. 기록을 새로고침해 주세요.");
        revision++;
      },
      isCancelled:async()=>{
        // 취소 여부 확인도 임대 소유권을 요구한다. 잠금을 잃은 실행은 false를 반환해 계속 진행하지 않고 중단한다.
        const current=await this.db.prepare("SELECT cancel_requested FROM runtime_runs WHERE owner_id=? AND id=? AND lease_owner=? AND lease_until>?").bind(ownerId,id,token,Date.now()).first<{cancel_requested:number}>();
        if(!current)throw new Error("실행 처리 권한이 만료되었어요.");
        return current.cancel_requested===1;
      },
      // 자신의 토큰이 남아 있을 때만 해제하여 후속 작업자가 획득한 임대는 보존한다.
      release:async()=>{await this.db.prepare("UPDATE runtime_runs SET lease_owner=NULL,lease_until=0 WHERE owner_id=? AND id=? AND lease_owner=?").bind(ownerId,id,token).run();},
    };
  }
}
