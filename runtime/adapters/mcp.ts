// HTTP 기반 MCP initialize/initialized/tools-call 클라이언트. 연결과 토큰은 실행 환경 설정에서 받고 자료 본문에서 읽지 않는다.
import type { Json, RuntimeDependencies } from "../types";
import { canonicalJson, redactJson, redactSecret, RuntimeFault } from "../policy";
import { readBody, safeEndpoint } from "./http";

export type McpConnection = { id: string; endpoint: string; token?: string };
type Rpc = { jsonrpc?: string; id?: string; result?: Record<string, Json>; error?: unknown };
const VERSION = "2025-11-25";

// JSON 또는 SSE 중 요청 ID가 일치하는 응답만 수락한다. 서버가 요청한 sampling/elicitation은 실행하지 않는다.
async function readRpc(response: Response, id: string): Promise<Rpc> {
  const kind = response.headers.get("content-type") ?? "";
  if (kind.includes("application/json")) {
    let parsed: Rpc; try { parsed = JSON.parse(await readBody(response)); } catch { throw new RuntimeFault("failed", "연결된 도구의 응답 형식이 올바르지 않아요."); }
    if (parsed.jsonrpc !== "2.0" || parsed.id !== id || parsed.error || !parsed.result) throw new RuntimeFault("failed", "연결된 도구가 요청을 처리하지 못했어요.");
    return parsed;
  }
  if (!kind.includes("text/event-stream") || !response.body) throw new RuntimeFault("failed", "이 MCP 응답 형식은 지원하지 않아요.");
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let text = ""; let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 400000) throw new RuntimeFault("failed", "도구 응답이 허용 크기를 넘었어요.");
      text = (text + decoder.decode(chunk.value, { stream: true })).replace(/\r\n/g, "\n");
      let boundary: number;
      while ((boundary = text.indexOf("\n\n")) >= 0) {
        const block = text.slice(0, boundary); text = text.slice(boundary + 2);
        const payload = block.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
        if (!payload) continue;
        let parsed: Rpc; try { parsed = JSON.parse(payload); } catch { throw new RuntimeFault("failed", "도구 이벤트 형식이 올바르지 않아요."); }
        if (parsed.id !== id) continue; // Never execute server initiated requests, sampling or elicitation.
        if (parsed.jsonrpc !== "2.0" || parsed.error || !parsed.result) throw new RuntimeFault("failed", "연결된 도구가 요청을 처리하지 못했어요.");
        return parsed;
      }
    }
  } finally { await reader.cancel().catch(() => {}); }
  throw new RuntimeFault("failed", "연결된 도구의 응답이 중단됐어요.");
}

/** Exact endpoints and bearer secrets MUST come from an owner-scoped server configuration, never catalog content. */
// 고정 도구 정의의 effect와 멱등성 지원 여부를 사용한다. 실제 토큰은 전송 헤더에만 넣고 결과에서 다시 제거한다.
export function createMcpToolCaller(connections: McpConnection[], request: typeof fetch = fetch): RuntimeDependencies["callTool"] {
  const configured = connections.map(c => ({ ...c, endpoint: safeEndpoint(c.endpoint) }));
  return async (tool, args, { signal, deadlineAt, idempotencyKey }) => {
    const connection = configured.find(c => c.id === tool.connectionId);
    if (!connection) throw new RuntimeFault("failed", "이 도구에 사용할 연결이 설정되지 않았어요.");
    let session: string | undefined;
    async function send(method: string, params?: Record<string, unknown>, notification = false): Promise<Record<string, Json>> {
      if (signal.aborted || (deadlineAt !== undefined && Date.now() >= deadlineAt)) throw new RuntimeFault("budget_exceeded", "도구 요청의 허용 시간이 지났어요. 추가 요청을 보내지 않았어요.");
      const id = crypto.randomUUID();
      const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": VERSION };
      if (connection!.token) headers.Authorization = `Bearer ${connection!.token}`;
      if (session) headers["Mcp-Session-Id"] = session;
      let response: Response;
      try { response = await request(connection!.endpoint, { method: "POST", redirect: "error", signal, headers, body: JSON.stringify({ jsonrpc: "2.0", ...(notification ? {} : { id }), method, ...(params ? { params } : {}) }) }); }
      catch { throw new Error("도구 연결에 실패했어요."); }
      if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error("도구 연결 또는 인증에 실패했어요."); }
      if (notification) { await response.body?.cancel().catch(() => {}); return {}; }
      const assigned = response.headers.get("Mcp-Session-Id");
      if (assigned) { if (!/^[\x21-\x7e]{1,1024}$/.test(assigned)) throw new RuntimeFault("failed", "도구 연결 세션이 올바르지 않아요."); session = assigned; }
      return (await readRpc(response, id)).result!;
    }
    const initialized = await send("initialize", { protocolVersion: VERSION, capabilities: {}, clientInfo: { name: "flowly", version: "1.0.0" } });
    if (initialized.protocolVersion !== VERSION || !initialized.capabilities || typeof initialized.capabilities !== "object" || !Object.hasOwn(initialized.capabilities, "tools")) throw new RuntimeFault("failed", "MCP 2025-11-25 도구 연결을 지원하는 서버가 필요해요.");
    await send("notifications/initialized", undefined, true);
    // Tool effect/schema are administrator-pinned. Untrusted server annotations cannot downgrade approval policy.
    const result = await send("tools/call", { name: tool.toolName, arguments: args, ...(tool.supportsIdempotency ? { _meta: { "flowly/idempotencyKey": idempotencyKey } } : {}) });
    if (result.isError) throw new RuntimeFault("failed", "연결된 도구가 작업 오류를 반환했어요.");
    canonicalJson(result);
    // A server can echo a bearer token: remove the exact secret before persistence or model observation.
    return redactJson(redactSecret(result, connection.token));
  };
}
