import { AsyncLocalStorage } from "node:async_hooks";
const contexts = new AsyncLocalStorage<ExecutionContext>();
export function withExecutionContext<T>(ctx:ExecutionContext,work:()=>T) { return contexts.run(ctx,work); }
export function schedule(work:Promise<unknown>) {
  const ctx=contexts.getStore();
  if(!ctx)throw new Error("실행 작업 처리기를 사용할 수 없어요.");
  ctx.waitUntil(work);
}
