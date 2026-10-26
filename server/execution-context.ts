/** Workers 요청별 ExecutionContext를 전달해 응답 이후의 짧은 작업 수명을 관리한다. 실행 상태의 영속 저장은 repository의 책임이다. */
import { AsyncLocalStorage } from "node:async_hooks";
const contexts = new AsyncLocalStorage<ExecutionContext>();
/** 동시에 들어온 요청의 waitUntil 대상이 섞이지 않도록 비동기 문맥별로 컨텍스트를 보관한다. */
export function withExecutionContext<T>(ctx:ExecutionContext,work:()=>T) { return contexts.run(ctx,work); }
/** 현재 Worker 요청의 수명에 작업을 연결한다. 재개 가능한 상태 자체를 메모리에 저장하는 큐는 아니다. */
export function schedule(work:Promise<unknown>) {
  const ctx=contexts.getStore();
  if(!ctx)throw new Error("실행 작업 처리기를 사용할 수 없어요.");
  ctx.waitUntil(work);
}
