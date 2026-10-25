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
export const registeredConnections = exampleConnections;
