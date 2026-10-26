/**
 * MCP 자료에 저장하는 공개 연결 정의를 읽고 직렬화한다.
 * 주소·환경 변수 이름·도구 효과·입력 스키마를 다루며 실제 비밀 값과 서비스 연결은 실행 환경의 책임이다.
 */
import type { Resource } from "../app/lib/model";
import type { DataSchema, Json } from "../runtime/types";
import { assertSchema, parseSchema } from "./schema";
import { validateJson } from "./node-config";

export type McpRegistrationTool = { name: string; description: string; effect: "read" | "write"; inputSchema: DataSchema; outputSchema?: DataSchema; outputTarget?: "structuredContent" | "result"; targetDescription?: string; inputExample?: Json; outputExample?: Json; errorExample?: string; nextAction?: string };
export type McpRegistration = { version: 1; connectionId: string; endpointEnv: string; tokenEnv?: string; tools: McpRegistrationTool[] };
type ResourceDefinition = Pick<Resource, "type" | "content" | "url">;
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const allowedKeys = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key));

/** A non-secret address hint. Registration never contacts or resolves this host. */
/**
 * 지원하는 MCP 주소 형식을 정규화한다. 네트워크 연결 성공 여부를 확인하는 함수는 아니다.
 */
export function parseMcpAddress(value: string): string {
  if (!value) return "";
  if (value.length > 2000 || /[\s\u0000-\u0020\u007f\\@]/.test(value)) throw new Error("MCP 주소에는 공백·제어 문자·역슬래시·@를 넣을 수 없어요.");
  if (!/^https?:\/\//i.test(value)) throw new Error("MCP 주소는 http:// 또는 https://로 시작해야 해요.");
  let address: URL;
  try { address = new URL(value); } catch { throw new Error("올바른 MCP HTTP 또는 HTTPS 주소를 입력해 주세요."); }
  if (!["http:", "https:"].includes(address.protocol) || !address.hostname || address.port === "0" || address.username || address.password || address.search || address.hash) throw new Error("MCP 주소는 유효한 포트의 HTTP 또는 HTTPS로 입력하고, 로그인 정보·쿼리·# 문단 표시는 제외해 주세요. 토큰은 내보낸 환경에 별도로 설정합니다.");
  if (/\bsk-[A-Za-z0-9_-]{12,}\b|\bbearer(?:%20|\s)/i.test(value)) throw new Error("MCP 주소에 비밀 키나 토큰을 넣지 마세요. 내보낸 실행 환경에 직접 설정해 주세요.");
  return address.href;
}

function checkedSchema(raw: unknown): DataSchema {
  const schema = parseSchema(raw);
  if (schema.type !== "object") throw new Error("도구 입력 형식의 최상위 type은 object여야 해요.");
  const inspect = (value: DataSchema) => {
    if (value.required && (new Set(value.required).size !== value.required.length || value.required.some(key => !Object.hasOwn(value.properties ?? {}, key)))) throw new Error("도구 입력의 required에는 properties에 선언한 필드 이름을 중복 없이 적어 주세요.");
    for (const child of Object.values(value.properties ?? {})) inspect(child);
    if (value.items) inspect(value.items);
  };
  inspect(schema);
  return schema;
}

/** Recognized broken registrations throw; old free-text descriptions stay readable. */
/**
 * 현재 등록 형식의 MCP 정의를 읽고 지원 필드와 도구 계약을 검사한다.
 */
export function readMcpRegistration(resource: ResourceDefinition): McpRegistration | null {
  if (resource.type !== "mcp") return null;
  let parsed: unknown;
  try { parsed = JSON.parse(resource.content); }
  catch { if (/"flowlyMcp"\s*:/.test(resource.content)) throw new Error("MCP 도구 정의 JSON을 확인해 주세요."); return null; }
  if (!object(parsed) || !Object.hasOwn(parsed, "flowlyMcp")) return null;
  if (!allowedKeys(parsed, ["flowlyMcp"]) || !object(parsed.flowlyMcp)) throw new Error("MCP 도구 정의에는 flowlyMcp 설정만 넣어 주세요. 키·토큰 값은 저장하지 않습니다.");
  const config = parsed.flowlyMcp;
  if (!allowedKeys(config, ["version", "connectionId", "endpointEnv", "tokenEnv", "tools"]) || config.version !== 1) throw new Error("지원하는 MCP 등록 형식은 version 1이며 연결 ID·환경 변수 이름·도구 정의만 저장할 수 있어요.");
  if (typeof config.connectionId !== "string" || config.connectionId === "local-python" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(config.connectionId)) throw new Error("연결 ID는 영문·숫자로 시작하는 1~100자의 영문·숫자·밑줄·하이픈으로 입력해 주세요.");
  if (typeof config.endpointEnv !== "string" || config.endpointEnv.length > 100 || !/^FLOWLY_MCP_ENDPOINT_[A-Z0-9_]+$/.test(config.endpointEnv)) throw new Error("주소 환경 변수 이름은 FLOWLY_MCP_ENDPOINT_로 시작하는 대문자·숫자·밑줄로 입력해 주세요.");
  if (config.tokenEnv !== undefined && (typeof config.tokenEnv !== "string" || config.tokenEnv.length > 100 || !/^FLOWLY_MCP_TOKEN_[A-Z0-9_]+$/.test(config.tokenEnv))) throw new Error("토큰 환경 변수 이름은 FLOWLY_MCP_TOKEN_로 시작해야 해요. 실제 토큰 값을 입력하지 마세요.");
  if (!Array.isArray(config.tools) || !config.tools.length || config.tools.length > 12) throw new Error("등록할 MCP 도구를 1~12개 지정해 주세요.");
  const tools = config.tools.map((raw, index): McpRegistrationTool => {
    if (!object(raw) || !allowedKeys(raw, ["name", "description", "effect", "inputSchema", "outputSchema", "outputTarget", "targetDescription", "inputExample", "outputExample", "errorExample", "nextAction"])) throw new Error(`${index + 1}번째 도구의 지원 필드와 입출력 형식을 확인해 주세요.`);
    if (typeof raw.name !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(raw.name)) throw new Error(`${index + 1}번째 도구 이름은 서버의 실제 도구 이름과 일치하는 1~64자의 영문·숫자·밑줄·하이픈이어야 해요.`);
    if (typeof raw.description !== "string" || raw.description.length > 1000) throw new Error(`${index + 1}번째 도구 설명은 1,000자까지 입력할 수 있어요.`);
    if (raw.effect !== "read" && raw.effect !== "write") throw new Error(`${index + 1}번째 도구가 조회인지 외부 변경인지 선택해 주세요.`);
    const inputSchema=checkedSchema(raw.inputSchema),outputSchema=raw.outputSchema===undefined?undefined:parseSchema(raw.outputSchema);
    if(raw.outputTarget!==undefined&&(!outputSchema||!["structuredContent","result"].includes(String(raw.outputTarget))))throw new Error("MCP 출력 검사 대상에는 출력 스키마와 structuredContent 또는 result를 지정해 주세요.");
    const result:McpRegistrationTool={name:raw.name,description:raw.description,effect:raw.effect,inputSchema,...(outputSchema?{outputSchema,outputTarget:(raw.outputTarget??"structuredContent") as "structuredContent"|"result"}:{})};
    for(const field of ["targetDescription","errorExample","nextAction"] as const)if(raw[field]!==undefined){if(typeof raw[field]!=="string"||raw[field].length>2000)throw new Error("대상·오류·다음 행동 설명은 각각 2,000자 이내로 입력해 주세요.");result[field]=raw[field];}
    for(const field of ["inputExample","outputExample"] as const)if(raw[field]!==undefined){validateJson(raw[field]);if(JSON.stringify(raw[field]).length>20000)throw new Error("MCP 입출력 예시는 20,000자 이내로 작성해 주세요.");const schema=field==="inputExample"?inputSchema:outputSchema;if(schema)assertSchema(raw[field] as Json,schema,field==="inputExample"?"입력 예시":"출력 예시");result[field]=structuredClone(raw[field]) as Json;}
    return result;
  });
  if (new Set(tools.map(tool => tool.name)).size !== tools.length) throw new Error("같은 연결 안에서 도구 이름을 중복 등록할 수 없어요.");
  parseMcpAddress(resource.url);
  return { version: 1, connectionId: config.connectionId, endpointEnv: config.endpointEnv, ...(config.tokenEnv !== undefined ? { tokenEnv: config.tokenEnv as string } : {}), tools };
}

/** Editor migration only. Reading old snapshots never rewrites their contents. */
/**
 * 기존 자료의 MCP 표현을 호환 형식으로 읽는다. 새 자료의 권한을 부여하지 않는다.
 */
export function readLegacyMcpRegistration(resource: ResourceDefinition): McpRegistration | null {
  if (resource.type !== "mcp") return null;
  let parsed: unknown;
  try { parsed = JSON.parse(resource.content); } catch { return null; }
  if (!object(parsed)) return null;
  const contracts = [
    { id: "showcase-knowledge", key: "KNOWLEDGE", name: "lookup_reference", description: "질문과 관련된 회사 자료를 읽습니다.", effect: "read" as const, fields: ["query"] },
    { id: "showcase-shipping", key: "SHIPPING", name: "lookup_shipment", description: "주문번호로 배송 상태를 조회합니다.", effect: "read" as const, fields: ["orderId"] },
    { id: "showcase-publishing", key: "PUBLISHING", name: "create_record", description: "승인받은 제목과 본문으로 외부 기록을 등록합니다.", effect: "write" as const, fields: ["title", "body"] },
  ];
  const contract = contracts.find(item => item.id === parsed.flowlyConnectionTemplate);
  if (!contract) return null;
  return { version: 1, connectionId: contract.id, endpointEnv: `FLOWLY_MCP_ENDPOINT_${contract.key}`, tokenEnv: `FLOWLY_MCP_TOKEN_${contract.key}`, tools: [{ name: contract.name, description: contract.description, effect: contract.effect, inputSchema: { type: "object", properties: Object.fromEntries(contract.fields.map(field => [field, { type: "string" as const }])), required: contract.fields, additionalProperties: false } }] };
}

/**
 * 검증된 연결 정의를 자료 본문에 저장할 JSON으로 만든다.
 */
export function serializeMcpRegistration(value: McpRegistration): string {
  const content = JSON.stringify({ flowlyMcp: value });
  const normalized = readMcpRegistration({ type: "mcp", content, url: "" });
  return JSON.stringify({ flowlyMcp: normalized }, null, 2);
}
