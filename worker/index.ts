/** Vinext 요청 진입점. 본문 제한 → 플랫폼 연결 문맥 → 라우트 순서로 처리하고 예약 작업에서 저장된 실행을 복구한다. */
import handler from "vinext/server/fetch-handler";
import { runWithConnectorBinding } from "../lib/connector-context";
import type { ConnectorBinding } from "../lib/connector-contract.mjs";
import { withExecutionContext } from "../server/execution-context";
import { recoverRuns } from "../server/runtime-service";
import { apiRequestByteLimit, bufferApiRequest } from "../server/http";

const worker = {
  async fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext<{ CONNECTORS?: ConnectorBinding }>) {
    // 라우트가 인증 오류로 조기 반환하더라도 본문 스트림은 여기에서 제한된 크기/시간 안에 정리한다.
    try {request=await bufferApiRequest(request);}catch(error){return Response.json({error:error instanceof Error&&error.message==="REQUEST_TOO_LARGE"?`이 요청은 ${apiRequestByteLimit(new URL(request.url).pathname).toLocaleString()}바이트까지 보낼 수 있어요.`:"요청 본문을 받지 못했어요. 다시 시도해 주세요."},{status:error instanceof Error&&error.message==="REQUEST_TOO_LARGE"?413:408,headers:{"Cache-Control":"no-store"}});}
    let binding = ctx.props?.CONNECTORS;
    // Local preview emulates the same request-scoped capability. This branch and
    // the auxiliary service binding are absent from production builds.
    if (import.meta.env.DEV && !binding && env.CONNECTORS) {
      const preview = env.CONNECTORS;
      const expiresAt = Date.now() + 60_000;
      binding = {
        async getContext() {
          if (Date.now() >= expiresAt) return { status: "request_context_expired" };
          return preview.getContext?.() ?? { status: "binding_unavailable" };
        },
        async invoke(connectorId, actionName, args) {
          if (Date.now() >= expiresAt) {
            return { status: "request_context_expired", message: "This request has expired. Please try again." };
          }
          return preview.invoke(connectorId, actionName, args);
        },
      };
    }
    return withExecutionContext(ctx, () => runWithConnectorBinding(binding, () => handler.fetch(request, env, ctx)));
  },
  // 예약 호출은 D1에 남은 실행을 복구할 뿐 새 사용자 실행을 생성하지 않는다.
  async scheduled() { await recoverRuns(); },
};

export default worker;
