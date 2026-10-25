import handler from "vinext/server/fetch-handler";
import { runWithConnectorBinding } from "../lib/connector-context";
import type { ConnectorBinding } from "../lib/connector-contract.mjs";
import { withExecutionContext } from "../server/execution-context";
import { recoverRuns } from "../server/runtime-service";
import { bufferApiRequest } from "../server/http";

const worker = {
  async fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext<{ CONNECTORS?: ConnectorBinding }>) {
    try {request=await bufferApiRequest(request);}catch(error){return Response.json({error:error instanceof Error&&error.message==="REQUEST_TOO_LARGE"?"요청은 350KB까지 보낼 수 있어요.":"요청 본문을 받지 못했어요. 다시 시도해 주세요."},{status:error instanceof Error&&error.message==="REQUEST_TOO_LARGE"?413:408,headers:{"Cache-Control":"no-store"}});}
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
  async scheduled() { await recoverRuns(); },
};

export default worker;
