/** 등록 MCP 자료를 실행 계약으로 바꾼다. 공유되는 것은 도구 정의와 환경변수 이름이며 외부 계정 권한이나 토큰이 아니다. */
import { canReadResource, type Identity, type Resource } from "../app/lib/model";
import { readMcpRegistration } from "../domain/mcp-registration";
import type { ToolDefinition } from "../runtime/types";

// Legacy examples select a fixed contract. Newly registered resources use an
// explicitly validated versioned definition. Neither form carries credentials.
const contracts = [
  { id: "showcase-knowledge", key: "KNOWLEDGE", name: "참고 자료 조회", toolName: "lookup_reference", effect: "read" as const, fields: ["query"] },
  { id: "showcase-shipping", key: "SHIPPING", name: "배송 조회", toolName: "lookup_shipment", effect: "read" as const, fields: ["orderId"] },
  { id: "showcase-publishing", key: "PUBLISHING", name: "승인 후 기록 등록", toolName: "create_record", effect: "write" as const, fields: ["title", "body"] },
];

/** 현재 사용자가 읽을 수 있는 MCP만 변환한다. 반환된 endpoint는 설정 힌트일 뿐 원격 서비스 연결 검증 결과가 아니다. */
export function exampleConnections(user: Identity, resources: Resource[]) {
  return resources.flatMap(resource => {
    if (resource.type !== "mcp" || !canReadResource(resource, user)) return [];
    const registered = readMcpRegistration(resource);
    if (registered) {
      const tools: ToolDefinition[] = registered.tools.map(tool => ({
        resourceId: resource.id, connectionId: registered.connectionId, toolName: tool.name,
        name: tool.name, description: tool.description, effect: tool.effect,
        inputSchema: tool.inputSchema, supportsIdempotency: false,
      }));
      return [{ id: registered.connectionId, ownerId: user.userId, resourceId: resource.id, name: resource.name,
        endpoint: resource.url || "https://example.com/flowly-unconfigured/registered", endpointEnv: registered.endpointEnv,
        ...(registered.tokenEnv ? { tokenEnv: registered.tokenEnv } : {}), tools }];
    }
    let template: unknown;
    try { template = JSON.parse(resource.content).flowlyConnectionTemplate; } catch { return []; }
    const contract = contracts.find(c => c.id === template);
    if (!contract) return [];
    const tool: ToolDefinition = { resourceId: resource.id, connectionId: contract.id, toolName: contract.toolName,
      name: contract.toolName, description: `${contract.name} · 내보낸 환경에서 본인 서비스 설정 필요`, effect: contract.effect, supportsIdempotency: false,
      inputSchema: { type: "object", properties: Object.fromEntries(contract.fields.map(field => [field, { type: "string" as const }])), required: contract.fields, additionalProperties: false } };
    return [{ id: contract.id, ownerId: user.userId, resourceId: resource.id, name: contract.name,
      endpoint: `https://example.com/flowly-unconfigured/${contract.key.toLowerCase()}`, endpointEnv: `FLOWLY_MCP_ENDPOINT_${contract.key}`,
      tokenEnv: `FLOWLY_MCP_TOKEN_${contract.key}`, tools: [tool] }];
  });
}

// Kept under the old export name above for saved example/test compatibility.
/** 기존 호출부와의 호환 별칭이다. 예제뿐 아니라 사용자가 등록한 MCP 정의도 같은 변환 규칙을 쓴다. */
export const registeredConnections = exampleConnections;
