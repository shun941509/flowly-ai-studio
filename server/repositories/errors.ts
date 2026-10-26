import type { Resource, Workflow } from "../../app/lib/model";
/** API가 사용자 입력을 보존하며 권한·충돌·미설정을 구분할 수 있도록 하는 공통 저장소 오류. */
export class HistoryError extends Error {
  constructor(message: string, readonly status = 400, readonly current?: Workflow | Resource) { super(message); }
}
