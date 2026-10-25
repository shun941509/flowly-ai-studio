import { strToU8, zipSync } from "fflate";
import { canReadResource, validateGraph, type Identity, type Resource, type Workflow } from "../app/lib/model";
import { compileDefinition, referencedResourceIds } from "../domain/workflow";
import { parseSchema } from "../domain/schema";
import { DEFAULT_LIMITS, type Limits, type ToolDefinition } from "../runtime/types";
import { inspectWorkflow } from "../domain/preflight";
import { allNodes } from "../domain/advanced-config";
import { MAX_EXPORT_CONNECTIONS, MAX_EXPORT_RESOURCES } from "../domain/export-limits";
import { nodeRequiresModel, nodeRequiresResponseModel, nodeUsesEmbeddings } from "../domain/extended-config";
import { safeEndpoint } from "../runtime/adapters/http";
import type { AuthConfig } from "./auth/config";
import { sameOriginMutation } from "./auth/session";
import { registeredConnections } from "./example-connections";
import { buildAiExportDocuments } from "./export-ai-documents";
import { selectedPythonToolIds, pythonToolDefinition, PYTHON_TOOL_CONTRACTS } from "../runtime/python-tools";
import { getToolCandidate, TOOL_FAMILIES } from "../domain/tool-catalog";
import { selectedCompletionOperations } from "../runtime/completion-programs";
import completionContracts from "../domain/completion-operations.json";
import { buildAgentExportFiles } from "./export-agent-package";
import { exportExecution, type ExportExecutionTarget } from "./export-execution";

export type ExportKind = "runtime" | "agent" | "prompt";

export type ExportConnection = { id: string; ownerId: string; resourceId: string; name: string; endpoint: string; endpointEnv?: string; tokenEnv?: string; tools: ToolDefinition[] };
export type ExportManifest = {
  format: "flowly-executable-export";
  language: "node" | "python";
  version: 1;
  exportedAt: string;
  owner: Identity;
  workflow: Workflow;
  resources: Omit<Resource, "allowedEmails">[];
  connections: ExportConnection[];
  limits: Limits;
};
export class ExportPackageError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

/** Called after session verification; worker/index.ts drains and bounds the source first. */
export async function readExportRequest(request: Request, config: AuthConfig): Promise<{ workflow?: unknown; workflowId?: string; versionId?: string; language: "node" | "python"; kind: ExportKind }> {
  if (!sameOriginMutation(config, request)) throw new ExportPackageError("허용되지 않은 요청이에요. Flowly 화면에서 다시 내보내 주세요.", 403);
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new ExportPackageError("JSON 요청이 필요해요.", 415);
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > 350_000) throw new ExportPackageError("입력 내용이 너무 커요.", 413);
  let body: unknown;
  try { body = JSON.parse(raw); } catch { throw new ExportPackageError("요청 형식을 확인해 주세요."); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ExportPackageError("내보낼 워크플로를 확인해 주세요.");
  const input = body as Record<string, unknown>;
  const language = input.language ?? "node";
  const kind = input.kind ?? "runtime";
  if (kind !== "runtime" && kind !== "agent" && kind !== "prompt") throw new ExportPackageError("내보낼 항목을 다시 선택해 주세요.");
  if (language !== "node" && language !== "python") throw new ExportPackageError("Node 또는 Python 실행 프로젝트를 선택해 주세요.");
  if (input.versionId !== undefined || input.workflowId !== undefined) {
    if (input.workflow !== undefined || typeof input.workflowId !== "string" || !input.workflowId || input.workflowId.length > 100 || /[\x00-\x1f]/.test(input.workflowId) || typeof input.versionId !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(input.versionId)) throw new ExportPackageError("저장한 워크플로와 발행 버전을 확인해 주세요.");
    return { workflowId: input.workflowId, versionId: input.versionId, language, kind };
  }
  return { workflow: input.workflow, language, kind };
}
type ExportOptions = {
  user: Identity;
  workflow: unknown;
  connections: ExportConnection[];
  resolveResources: (user: Identity, ids: string[]) => Promise<Resource[]>;
  runnerSource: string;
  helpers?: { files: string; triggers: string; requirements: string; programs?: string; dynamic?: string; knowledge?: string; search?: string; pythonTools?: string; scientificTools?: string; mediaTools?: string; toolRequirements?: string; completions?: string; completionResearch?: string; completionPrograms?: string; completionOperations?: string };
  operations?: { ops: string; local: string; guide?: string };
  language?: "node" | "python";
  kind?: ExportKind;
  exportedAt?: string;
};

/** Only explicit, server-resolved fields cross the downloadable package boundary. */
export async function buildExportManifest(options: Omit<ExportOptions, "runnerSource">): Promise<ExportManifest> {
  if (!options.workflow || typeof options.workflow !== "object" || Array.isArray(options.workflow)) throw new ExportPackageError("내보낼 워크플로를 확인해 주세요.");
  const raw = options.workflow as Record<string, unknown>;
  let definition: Workflow["definition"];
  try { definition = compileDefinition(raw.definition); }
  catch (error) { throw new ExportPackageError(error instanceof Error ? error.message : "워크플로 형식을 확인해 주세요."); }
  if (options.kind === "agent" && !allNodes(definition).some(node => node.type === "agent")) throw new ExportPackageError("Agent 다운로드에는 AI Agent 블록이 필요해요. 하위 작업의 Agent도 사용할 수 있어요.", 409);
  const selected = allNodes(definition).flatMap(node => node.allowedTools || []);
  if (selected.some(tool => ["test-read", "test-write"].includes(tool.connectionId))) throw new ExportPackageError("테스트 도구는 실행 프로젝트로 내보낼 수 없어요. 에이전트에서 실제로 사용할 서비스 도구를 선택해 주세요.", 409);
  const ids = referencedResourceIds(definition);
  if (ids.length > MAX_EXPORT_RESOURCES) throw new ExportPackageError(`하위 작업을 포함해 자료는 ${MAX_EXPORT_RESOURCES}개까지 내보낼 수 있어요. 워크플로를 나누거나 사용 자료를 줄여 주세요.`);
  if (new Set(selected.map(tool => tool.connectionId)).size > MAX_EXPORT_CONNECTIONS) throw new ExportPackageError(`하위 작업을 포함해 서비스 연결은 ${MAX_EXPORT_CONNECTIONS}개까지 내보낼 수 있어요. 사용 연결을 줄여 주세요.`);
  // Resolve again for every export. A previously saved graph does not preserve access.
  const accessible = await options.resolveResources(options.user, ids);
  const resources = ids.map(id => {
    const resource = accessible.find(candidate => candidate.id === id);
    if (!resource || !canReadResource(resource, options.user)) throw new ExportPackageError("접근 권한이 없거나 공유가 철회된 자료예요. 자료 소유자에게 확인해 주세요.", 403);
    return resource;
  });
  const resourceErrors = validateGraph(definition, resources);
  if (resourceErrors.length) throw new ExportPackageError(resourceErrors.join("\n"));
  const connections: ExportConnection[] = [];
  const registered = registeredConnections(options.user, resources);
  // A current registration supersedes an older server-side definition. The
  // public API supplies no fallback connections; this option remains for legacy
  // trusted integrations and isolated contract tests only.
  const availableConnections = [...registered, ...options.connections.filter(c => !registered.some(r => r.resourceId === c.resourceId))];
  for (const chosen of selected) {
    if (resources.find(resource => resource.id === chosen.resourceId)?.type !== "mcp") throw new ExportPackageError("허용 도구는 MCP 자료에 연결해 주세요.");
    const connection = availableConnections.find(candidate => candidate.ownerId === options.user.userId && candidate.id === chosen.connectionId && candidate.resourceId === chosen.resourceId);
    const tool = connection?.tools.find(candidate => candidate.connectionId === chosen.connectionId && candidate.resourceId === chosen.resourceId && candidate.toolName === chosen.toolName);
    if (!connection || !tool) throw new ExportPackageError("‘도구 및 자료’에 등록했거나 공유받은 MCP의 도구를 선택해 주세요. 연결 ID와 도구 정의를 확인해 주세요.", 403);
    let exported = connections.find(candidate => candidate.id === connection.id);
    if (exported && exported.resourceId !== connection.resourceId) throw new ExportPackageError("같은 서비스 정의가 여러 자료에 중복 연결되어 있어요. 이 워크플로에서는 같은 서비스의 MCP 자료 하나를 선택해 주세요.");
    if (!exported) {
      let endpoint: string;
      try { endpoint = safeEndpoint(connection.endpoint); } catch { throw new ExportPackageError("인증 정보·쿼리·프래그먼트 없는 HTTP 또는 HTTPS MCP 주소를 입력해 주세요."); }
      if (connection.tokenEnv && !/^FLOWLY_MCP_TOKEN_[A-Z0-9_]+$/.test(connection.tokenEnv)) throw new ExportPackageError("서비스 비밀 설정 이름을 확인해 주세요.");
      if (connection.endpointEnv && !/^FLOWLY_MCP_ENDPOINT_[A-Z0-9_]+$/.test(connection.endpointEnv)) throw new ExportPackageError("서비스 주소 설정 이름을 확인해 주세요.");
      exported = { id: connection.id, ownerId: options.user.userId, resourceId: connection.resourceId, name: connection.name, endpoint,
        ...(connection.endpointEnv ? { endpointEnv: connection.endpointEnv } : {}),
        ...(connection.tokenEnv ? { tokenEnv: connection.tokenEnv } : {}), tools: [] };
      connections.push(exported);
    }
    if (!exported.tools.some(candidate => candidate.toolName === tool.toolName)) exported.tools.push({
      connectionId: exported.id, resourceId: exported.resourceId, toolName: tool.toolName, name: tool.name,
      description: tool.description, effect: tool.effect, inputSchema: parseSchema(tool.inputSchema), supportsIdempotency: tool.supportsIdempotency === true,
    });
  }
  const toolNames = connections.flatMap(connection => connection.tools.map(tool => tool.name));
  if (new Set(toolNames).size !== toolNames.length) throw new ExportPackageError("선택한 MCP 도구 이름이 겹쳐요. 서로 구분되는 도구 이름으로 등록해 주세요.");
  const exportedAt = options.exportedAt || new Date().toISOString();
  const workflow: Workflow = { id: String(raw.id || "workflow").slice(0, 100), name: String(raw.name || "워크플로").slice(0, 80), description: String(raw.description || "").slice(0, 300), definition, updatedAt: exportedAt };
  const inspection = inspectWorkflow(workflow, resources, { testEnabled: false, liveEnabled: false, liveReason: "내보내기 전용", connections: connections.map(c => ({ ...c, status: "configured" })) });
  if (!inspection.canExport) throw new ExportPackageError(inspection.issues.filter(i => i.severity === "error").map(i => i.message).join("\n"));
  const manifest: ExportManifest = {
    format: "flowly-executable-export", version: 1, language: options.language || "node", exportedAt,
    owner: { userId: options.user.userId, email: options.user.email, displayName: options.user.displayName },
    workflow,
    resources: resources.map(resource => ({ id: resource.id, ownerId: resource.ownerId, name: resource.name, type: resource.type,
      description: resource.description, content: resource.content, url: resource.url, visibility: resource.visibility,
      createdAt: resource.createdAt, updatedAt: resource.updatedAt, ...(resource.sample ? { sample: true } : {}) })),
    connections, limits: { ...DEFAULT_LIMITS },
  };
  if (strToU8(JSON.stringify(manifest, null, 2)).byteLength > 8_000_000) throw new ExportPackageError("내보낼 자료가 너무 커요. 자료를 나누거나 사용하지 않는 연결을 제거해 주세요.", 413);
  return manifest;
}

function readme(manifest: ExportManifest, withOperations: boolean, target: ExportExecutionTarget): string {
  const nodes = allNodes(manifest.workflow.definition);
  const hasFiles = nodes.some(node => ["file_input", "document_extract", "file_output"].includes(node.type));
  const trigger = nodes.find(node => node.type === "trigger")?.trigger;
  const hasVector = nodes.some(nodeUsesEmbeddings);
  const requiresModel = allNodes(manifest.workflow.definition).some(nodeRequiresModel);
  const extraCredentials = [...new Set(manifest.connections.flatMap(connection => connection.tokenEnv ? [connection.tokenEnv] : []))];
  const { command, entrypoint } = exportExecution(manifest, target);
  const runtime = manifest.language === "python" ? "Python 3.11 이상" : "Node.js 22.13 이상";
  const stateDirectory = manifest.language === "python" ? ".flowly-python-runs" : ".flowly-runs";
  return `# Flowly 실행 프로젝트

웹 화면은 워크플로를 설계하고 파일로 내보냅니다. 이 파일을 다운로드하는 동안 모델이나 MCP 서비스는 호출하지 않습니다.
실제 AI 실행은 이 폴더에서 사용자가 직접 시작하며, 사용자의 OpenAI API 키와 서비스 연결을 사용합니다.
AI 작업 도구에 전달할 지시는 AI_PROMPT.md, 공통 지침은 AGENTS.md, 설계 설명은 WORKFLOW_GUIDE.md입니다. START_HERE.md에서 Skill 목록과 사용 순서를 확인하세요. 이 파일들은 전역 설치되지 않습니다.

## 준비

1. ${runtime}을 설치하고 ZIP을 새 폴더에 풉니다.${hasFiles || trigger ? " 파일·자동 시작 도우미는 Python 3.11 이상도 필요합니다." : " 별도 패키지 설치는 필요하지 않습니다."}
${requiresModel || manifest.connections.length ? "2. .env.example을 .env로 복사합니다. Windows PowerShell: Copy-Item .env.example .env" : "2. 이 흐름에는 모델 키나 서비스 토큰이 필요하지 않습니다. .env 없이 실행할 수 있습니다."}
${requiresModel ? "3. 로컬 편집기로 .env를 열어 OPENAI_API_KEY에 본인의 키를 입력합니다. FLOWLY_MODEL은 사용 가능한 모델로 지정합니다. 기본 예시는 gpt-5.4-mini입니다." : "이 흐름에는 AI 블록이 없어 OpenAI를 호출하지 않습니다."}
${extraCredentials.length ? `서비스 인증에는 ${extraCredentials.join(", ")}에 본인의 토큰을 입력합니다.\n` : ""}
${manifest.connections.filter(c=>c.endpointEnv).map(c=>`${c.name}: .env의 ${c.endpointEnv}에 ‘도구 및 자료’에 등록한 사내 MCP 서버의 HTTP/HTTPS 주소를 입력하세요.${c.endpoint.includes("/flowly-unconfigured/") ? " 주소는 아직 미설정입니다." : ` 등록한 주소: ${c.endpoint}`} 인증 정보는 주소에 넣지 않고 ${c.tokenEnv || "사내 서버에서 요구하는 인증 설정"}에 따로 입력합니다. 실행 시작 시 주소를 고정하므로 승인 대기 중 변경하면 재개가 차단됩니다.\n`).join("")}
사내 접근과 통신 범위는 회사 네트워크에서 통제합니다. 실행기는 사내 주소 허용 목록이나 공개 호스트 여부를 검사하지 않습니다. 등록된 도구 정의는 복사되지만 서비스 자체와 자격 증명은 포함되지 않습니다.
${hasVector ? "벡터 검색은 FLOWLY_EMBEDDING_MODEL(기본 text-embedding-3-small)을 사용합니다. 임베딩만 사용하는 흐름에는 FLOWLY_MODEL이 필요하지 않습니다. 캐시는 사용자·워크플로·자료 버전·임베딩 모델별로 분리됩니다.\n" : ""}
키는 웹 화면이나 workflow.json에 넣지 마세요. 필요한 설정이 비어 있으면 미설정 상태로 종료합니다.
모델이나 유료 외부 서비스를 선택한 경우 실제 사용량과 비용이 발생할 수 있습니다.
사용자 입력, 작업 지침, 연결 자료와 도구 결과는 실행 중 선택한 모델과 해당 서비스에 전송됩니다.

## 실행

    ${command} check
    ${command} run --input "질문이나 요청"
    ${command} run --input-file input.txt

check는 패키지·자료·도구 입력과 로컬 설정의 유무를 검사합니다. 키 원문을 출력하지 않으며, 실제 연결이나 모델 권한 검증을 뜻하지 않습니다.
입력 블록에 JSON 예시가 있다면 input.txt에 해당 형식으로 작성한 뒤 --input-file을 사용하세요.

명령이 출력한 실행 ID로 진행 상태를 확인합니다.

    ${command} status <실행ID>
    ${command} resume <실행ID>
    ${command} report <실행ID> --output report.html

report는 저장한 상태·노드 입출력·도구·승인·오류·사용량을 한국어 HTML로 만듭니다. 새 호출을 하지 않으며 기존 파일은 덮어쓰지 않습니다. 실행 중 저장된 입력 매핑과 앞 단계 출력에서 노드 입력을 재구성합니다.

외부 변경 작업이 승인 대기 중이면 해당 실행 ID와 승인 ID를 사용합니다.
승인 또는 거절은 결정만 저장합니다. resume 명령으로 이어서 실행합니다.

    ${command} approve <실행ID> <승인ID>
    ${command} deny <실행ID> <승인ID>
    ${command} resume <실행ID>

사람 검토 노드에서는 검토 ID로 수락 또는 거절합니다. 수정이 허용된 요청은 JSON 객체 파일을 전달할 수 있습니다. 외부 변경 승인은 별도입니다.

    ${command} accept <실행ID> <검토ID>
    ${command} accept <실행ID> <검토ID> --edited-input-file edited.json
    ${command} reject <실행ID> <검토ID>
    ${command} resume <실행ID>

입력 양식은 등록한 필드의 JSON 객체를 --input-file로 전달하세요. 병렬 작업·팀·반복은 하위 체크포인트를 저장하며 부모의 남은 호출·토큰 한도를 나누어 사용합니다. 작업 수가 많으면 각 작업의 한도가 작아집니다. 하위 워크플로는 내보낸 정의의 고정 복사본입니다. 기억 노드는 이 실행기의 상태 폴더 안에 사용자·워크플로별 값을 저장합니다.

프로세스가 종료된 뒤 잠금이 남았을 때만 ${command} unlock을 사용합니다.
기본 파일은 workflow.json, 환경 파일은 .env, 실행 기록 폴더는 ${stateDirectory}입니다.
Node와 Python의 로컬 실행 기록은 서로 공유하지 않습니다.

${withOperations ? `## 로컬 실행 화면과 운영 도구

운영 도우미는 Python 3.11 이상이 필요하며 Node와 Python 실행 프로젝트 모두에서 사용할 수 있습니다. 기본 Node 실행기는 계속 Python 없이 사용할 수 있습니다(파일 처리 노드 제외).

    python flowly_local.py

터미널에 표시한 토큰 포함 주소를 브라우저로 엽니다. 127.0.0.1에서만 접근하고 페이지를 열 때마다 생성한 토큰을 사용합니다. 웹 서비스로 모델 키를 전송하지 않습니다. 실제 연결 점검·작업 시작·사례 평가를 누를 때만 모델/서비스를 호출합니다. 자동 새로고침은 저장 상태를 읽습니다.
프로필별 환경 파일과 실행 기록을 분리하며 기본 프로필 이름은 development입니다. 입력을 대기열에 추가한 뒤 처리기를 시작합니다. 한 번에 한 작업을 우선순위·접수 순서로 처리합니다. 중지는 취소 파일을 통해 실행기에 전달하고, 진행 중 외부 쓰기의 결과가 불명확하면 자동 재시도하지 않습니다.

    python flowly_ops.py --help
    python flowly_ops.py request --root . --request-file operation.json
    python flowly_ops.py worker --root . --once

operation.json 예시:

    {"action":"check","profile":"development"}
    {"action":"probe","profile":"development","target":"all","confirm":true}
    {"action":"profiles.set","name":"production","env":".env.production","production":true,"confirmProduction":true}
    {"action":"jobs.enqueue","profile":"development","input":"실행할 요청","priority":0}
    {"action":"runs.resume","profile":"development","runId":"run_..."}
    {"action":"backup","profile":"development","scopes":["state","outputs","reports"]}
    {"action":"restore","profile":"development","backupId":"backup_...","confirm":true}
    {"action":"prune","profile":"development","scopes":["state","outputs","reports"],"olderThanDays":30,"confirm":true}
    {"action":"evaluate","profile":"development","dataset":"evaluations/cases.json"}
    {"action":"compare","evaluationId":"eval_...","baselineId":"eval_..."}
    {"action":"prices.set","model":"사용할 모델명","inputPerMillion":1,"outputPerMillion":4,"currency":"USD","asOf":"2026-10-22"}
    {"action":"prices.estimate","profile":"development","runId":"run_..."}
    {"action":"bills.import","path":"billing.csv"}

위 단가는 형식 설명용 가상 숫자입니다. 실제 제공자의 확인한 단가와 기준일을 직접 입력하세요. 비용 추정은 제공자 청구 금액이 아닙니다. 세부 입력/출력 토큰이 없는 기록은 추정 범위로 표시합니다. 청구 CSV는 수동으로 준비한 금액과 비교하며 계정 청구 API를 자동 조회하지 않습니다.
백업은 .env를 제외한 로컬 ZIP이고 암호화하지 않습니다. 복원은 빈 대상만 허용하며 보관 정리는 진행 중·승인 대기·결과 불명확 기록을 자동 삭제하지 않습니다. 평가 사례의 입력은 실제 실행기를 통과하므로 외부 쓰기 승인과 한도가 그대로 적용됩니다. 상세 데이터 형식은 함께 제공한 OPERATIONS.md를 확인하세요.

` : ""}${hasFiles ? `## 파일 처리 준비

입력 파일은 이 폴더의 inputs/ 아래에 직접 저장하고 입력 JSON에는 상대경로만 넣습니다. 웹에 파일을 업로드하지 않습니다. 예: {"path":"inputs/example.txt"}. 파일은 10MB 이하이며 추출 전에 해시를 다시 검사합니다.

    python -m venv .venv-files
    .venv-files\\Scripts\\python -m pip install -r requirements-files.txt

macOS/Linux에서는 .venv-files/bin/python을 사용하세요. ${manifest.language === "node" ? "Node 파일 노드는 .env의 FLOWLY_PYTHON에 이 Python 실행 파일의 절대경로를 지정하세요." : `파일을 사용하는 실행은 위 가상 환경의 Python으로 ${entrypoint}를 실행하세요.`}
OCR에는 Tesseract 실행 파일(PATH 등록) 또는 호환되는 tesserocr 패키지와 tessdata/kor.traineddata·eng.traineddata가 추가로 필요합니다. [Tesseract 설치](https://tesseract-ocr.github.io/tessdoc/Installation.html), [공식 언어 데이터](https://github.com/tesseract-ocr/tessdata_fast), [tesserocr 설치](https://github.com/sirfz/tesserocr). check가 누락된 라이브러리·언어 데이터를 안내합니다. 자동 다운로드하거나 외부 OCR 서비스로 보내지 않습니다.
PDF·Word·Excel·CSV·텍스트를 읽고 PDF·Word·Excel·CSV를 생성합니다. Word는 실제 인쇄 페이지를 계산하지 않으므로 페이지 번호는 제공하지 않습니다. 출력은 outputs/실행별폴더/에 생성하고 기존 파일을 덮어쓰지 않습니다. 생성 결과가 불명확하거나 파일이 변경되면 자동 재생성하지 않습니다.

` : ""}${trigger ? `## 자동 시작

웹에서 예약이나 리스너를 실행하지 않습니다. 이 폴더에서 아래 도우미를 직접 시작합니다. 실행기는 한 번에 하나의 작업만 처리하고 승인·검토 대기 중에는 새 이벤트 실행을 멈춥니다.

    python flowly_triggers.py ${trigger.kind === "schedule" ? "schedule --max-runs 10 --input-file input.txt" : "serve --port 8789"}
    python flowly_triggers.py status

${trigger.kind === "schedule" ? "예약은 지정 시각(시간대 포함)부터 설정된 초 간격으로 동작합니다. 놓친 실행을 한꺼번에 재생하지 않습니다. 실행 횟수와 다음 시각은 로컬 상태 폴더에 저장합니다." : `FLOWLY_TRIGGER_SECRET에 무작위 32자 이상을 직접 설정하세요. 리스너는 http://127.0.0.1:8789/events만 엽니다. 요청 JSON은 {"eventId":"고유영문ID","type":"${trigger.eventType || "event"}","input":{}}입니다. X-Flowly-Timestamp에는 현재 Unix 초, X-Flowly-Signature에는 HMAC-SHA256(secret, timestamp + '.' + 정확한 요청본문)의 소문자 hex를 보냅니다. 5분 초과 요청과 잘못된 서명은 거절합니다. 외부 서비스 연결에는 사용자가 인증된 역방향 프록시를 별도로 구성해야 합니다.`}
같은 이벤트 ID·본문은 재실행하지 않습니다. 동일 ID의 내용 변경은 거절합니다. 실행 중 프로세스가 종료되어 결과가 불명확하면 자동 재시도하지 않으므로 실행 기록을 확인하세요. .flowly-triggers/는 패키지 해시에 묶입니다. 패키지를 바꾸려면 새 상태 폴더를 사용하세요. 비정상 종료 후 .launcher.lock은 해당 프로세스가 종료된 것을 확인한 뒤에만 정리합니다.

` : ""}## 확장 동작

민감정보 처리는 선택한 패턴의 규칙 검사이며 모든 개인정보 검출을 보장하지 않습니다. 해당 노드 뒤로 전달할 값을 제한합니다. 앞 단계의 로컬 기록까지 지우지는 않습니다.
답변 평가는 규칙 점수 또는 모델의 평가이며 결과의 사실성을 보장하지 않습니다. 웹 검색의 sources에는 근거 URL이 제공됩니다. 스트리밍을 켜면 부분 텍스트는 stderr JSONL에 기록되고 최종 성공 JSON은 stdout에 나옵니다. 중단된 부분 응답은 완료 답변으로 사용하지 않습니다.
외부 기억은 선택한 MCP 도구가 namespace/key/action/value/expiresAt 계약을 지원해야 합니다. 저장·삭제와 보상 작업은 각각 별도 승인을 받습니다. 보상은 지정한 완료 작업의 역방향 도구를 실행하며, 모든 부작용을 자동으로 되돌리는 트랜잭션은 아닙니다.

## 자료와 보관

워크플로와 사용 자료는 ${manifest.exportedAt}에 현재 권한을 검사하여 복사한 스냅샷입니다.
사용하지 않는 자료, 공유 대상 이메일 목록, 서버의 API 키와 서비스 토큰은 포함하지 않습니다.
내보낸 파일은 독립적인 오프라인 복사본이므로 이후 원본의 수정·삭제·공유 철회가 이 파일에 적용되지 않습니다.
최신 자료와 권한을 반영하려면 웹에서 다시 내보내세요. 받은 자료의 보관·재공유 범위를 확인하세요.

.env와 ${stateDirectory}는 Git 제외 목록에 들어 있지만 파일 자체는 암호화하지 않습니다.
로컬 실행 기록에는 사용자 입력, 자료, 도구 인자·결과, 승인과 오류가 포함될 수 있습니다.
이 폴더를 공유하거나 업로드하기 전에 민감한 자료와 로컬 실행 기록을 확인하세요.
외부 쓰기 결과가 불명확하면 자동 재실행하지 않으며, 해당 서비스에서 결과를 확인해야 합니다.
`;
}

export async function buildExportPackage(options: ExportOptions): Promise<Uint8Array> {
  if (options.kind === "prompt") throw new ExportPackageError("AI 명령 프롬프트는 미리보기에서 복사해 주세요. 파일 다운로드는 제공하지 않아요.");
  const manifest = await buildExportManifest(options);
  const target = options.kind === "agent" ? "agent" : "runtime";
  const json = strToU8(JSON.stringify(manifest, null, 2));
  if (json.byteLength > 8_000_000) throw new ExportPackageError("내보낼 자료가 너무 커요. 자료를 나누거나 사용하지 않는 연결을 제거해 주세요.", 413);
  if (!options.runnerSource.trim()) throw new ExportPackageError("실행 프로젝트 생성기가 준비되지 않았어요. 관리자에게 확인해 주세요.", 503);
  const tokenNames = [...new Set(manifest.connections.flatMap(connection => [connection.endpointEnv, connection.tokenEnv].filter((name): name is string => !!name)))];
  const requiresModel = allNodes(manifest.workflow.definition).some(nodeRequiresModel);
  const nodes = allNodes(manifest.workflow.definition);
  const hasFiles = nodes.some(node => ["file_input", "document_extract", "file_output"].includes(node.type));
  const trigger = nodes.find(node => node.type === "trigger")?.trigger;
  const vector = nodes.some(nodeUsesEmbeddings);
  const features = manifest.language === "python" ? {dynamic: nodes.some(n => n.orchestration?.mode === "dynamic"), knowledge: nodes.some(n => n.type === "knowledge"), search: nodes.some(n => n.type === "candidate_search")} : {dynamic:false, knowledge:false, search:false};
  for (const name of ["dynamic", "knowledge", "search"] as const) if(features[name] && !options.helpers?.[name]?.trim()) throw new ExportPackageError("동적 작업·지식 색인·후보 탐색 실행 도우미가 준비되지 않았어요.",503);
  const programs = manifest.language === "python" && nodes.some(node => node.type === "program" && node.program?.name !== "python_tool");
  const pythonToolIds = selectedPythonToolIds(manifest.workflow.definition);
  const completionIds = selectedCompletionOperations(manifest.workflow.definition);
  const completionManifest = { format: "flowly-completion-programs", version: 1, operations: completionIds.map(id => {
    const contract = completionContracts.operations.find(entry => entry.id === id);
    if (!contract) throw new ExportPackageError(`등록되지 않은 업무 프로그램이에요: ${id}`);
    return contract;
  }) };
  const completionRequirements = [...new Set(completionManifest.operations.flatMap(contract => "dependencies" in contract ? contract.dependencies as string[] : []))].sort();
  if (completionIds.length && ["completions", "completionResearch", "completionPrograms", "completionOperations"].some(key => !options.helpers?.[key as keyof NonNullable<ExportOptions["helpers"]>]?.trim())) throw new ExportPackageError("업무 프로그램 실행 파일이 준비되지 않았어요.", 503);
  const pythonAssets = Boolean(pythonToolIds.length || completionIds.length);
  const pythonTools = pythonToolIds.map(id => getToolCandidate(id)!);
  const toolContracts = { version: 1, tools: Object.fromEntries(pythonToolIds.map(id => [id, PYTHON_TOOL_CONTRACTS.tools[id]])) };
  const packages: Record<string, string> = { sklearn: "scikit-learn", cv2: "opencv-python-headless", skimage: "scikit-image", pywt: "pywavelets", PIL: "pillow", sentence_transformers: "sentence-transformers", faster_whisper: "faster-whisper", umap: "umap-learn", sklearn_crfsuite: "sklearn-crfsuite" };
  const requiredPackages = new Set(pythonToolIds.flatMap(id => PYTHON_TOOL_CONTRACTS.tools[id].dependencies ?? []).map(name => packages[name.split(".")[0]] ?? name.split(".")[0].toLowerCase()));
  const selectedRequirements = (options.helpers?.toolRequirements ?? "").split(/\r?\n/).filter(line => requiredPackages.has(line.match(/^([A-Za-z0-9_-]+)/)?.[1].toLowerCase() ?? ""));
  const requirementFile = ["# Selected workflow dependencies only. Compatibility ranges, not a reproducibility lock.", "# Provision packages through your company package repository; check/run never install.", ...selectedRequirements, ""].join("\n");
  if (pythonAssets && ["pythonTools", "scientificTools", "mediaTools", "toolRequirements"].some(key => !options.helpers?.[key as keyof NonNullable<ExportOptions["helpers"]>]?.trim())) throw new ExportPackageError("Python 도구 실행 파일이 준비되지 않았어요. 관리자에게 확인해 주세요.", 503);
  const toolManifest = { format: "flowly-python-tools", version: 1, tools: pythonTools.map(tool => ({ ...tool, ...PYTHON_TOOL_CONTRACTS.tools[tool.id] })), requirements: selectedRequirements, definitions: pythonToolIds.map(pythonToolDefinition), invocations: nodes.filter(node => node.pythonTools?.length || node.program?.name === "python_tool").map(node => ({ nodeId: node.id, type: node.type, ...(node.pythonTools ? { pythonTools: node.pythonTools } : {}), ...(node.program ? { program: node.program } : {}) })), execution: { bridge: "flowly_tools.py", input: "{toolId, arguments}", output: "{ok, result | error}", network: "disabled_by_tool_contract", credentials: "not_included" } };
  if (hasFiles && (!options.helpers?.files.trim() || !options.helpers.requirements.trim()) || trigger && !options.helpers?.triggers.trim()) throw new ExportPackageError("파일·자동 시작 실행 도우미가 준비되지 않았어요. 관리자에게 확인해 주세요.", 503);
  if (options.operations && (!options.operations.ops.trim() || !options.operations.local.trim())) throw new ExportPackageError("로컬 운영 도우미가 준비되지 않았어요. 관리자에게 확인해 주세요.", 503);
  if (programs && !options.helpers?.programs?.trim()) throw new ExportPackageError("등록 프로그램 실행 도우미가 준비되지 않았어요. 관리자에게 확인해 주세요.", 503);
  const entries: Record<string, Uint8Array> = {
    ...Object.fromEntries(Object.entries(buildAiExportDocuments(manifest, target)).map(([path, text]) => [path, strToU8(text)])),
    [manifest.language === "python" ? "runner.py" : "runner.mjs"]: strToU8(options.runnerSource),
    "workflow.json": json,
    ".env.example": strToU8(["# 본인 기기의 .env 파일에만 필요한 키를 입력하세요.", ...(requiresModel ? ["OPENAI_API_KEY=", ...(nodes.some(nodeRequiresResponseModel) ? ["FLOWLY_MODEL=gpt-5.4-mini"] : [])] : ["# AI 블록이 없는 흐름에는 OpenAI 키가 필요하지 않습니다."]), ...(vector ? ["FLOWLY_EMBEDDING_MODEL=text-embedding-3-small"] : []), ...(pythonToolIds.length ? ["# 로컬 모델 도구 ID -> models/ 아래 상대경로의 JSON 객체", "FLOWLY_TOOL_MODELS={}", ...(pythonToolIds.includes("watermark") ? ["FLOWLY_WATERMARK_KEY="] : []), ...(pythonToolIds.includes("content_credentials") ? ["FLOWLY_CONTENT_CREDENTIALS_KEY="] : [])] : []), ...((hasFiles || pythonAssets) && manifest.language === "node" ? ["# 선택한 도우미 가상 환경의 Python 실행 파일 절대경로", "FLOWLY_PYTHON="] : []), ...(trigger && trigger.kind !== "schedule" ? ["FLOWLY_TRIGGER_SECRET="] : []), ...tokenNames.map(name => `${name}=`), ""].join("\n")),
    ...(hasFiles ? { "flowly_files.py": strToU8(options.helpers!.files), "requirements-files.txt": strToU8(options.helpers!.requirements) } : {}),
    ...(trigger ? { "flowly_triggers.py": strToU8(options.helpers!.triggers) } : {}),
    ...Object.fromEntries((["dynamic", "knowledge", "search"] as const).filter(name => features[name]).map(name => [`flowly_${name}.py`, strToU8(options.helpers![name]!)])),
    ...(programs ? { "flowly_programs.py": strToU8(options.helpers!.programs!) } : {}),
    ...(completionIds.length ? {
      "flowly_completions.py": strToU8(options.helpers!.completions!), "completion_research.py": strToU8(options.helpers!.completionResearch!), "completion_programs.py": strToU8(options.helpers!.completionPrograms!), "completion_operations.py": strToU8(options.helpers!.completionOperations!),
      "completion-manifest.json": strToU8(JSON.stringify(completionManifest, null, 2)),
      "requirements-completion.txt": strToU8(["# Selected registered program dependencies. Install through your company package repository.", ...completionRequirements, ""].join("\n")),
      "COMPLETION_PROGRAMS.md": strToU8("# 등록된 업무 프로그램\n\ncompletion-manifest.json에 이 흐름에서 선택한 연산 ID·입력 예·검증 범위가 있습니다. Node.js와 Python이 동일한 Python 3.11 이상 도우미를 실행합니다. Node.js는 .env의 FLOWLY_PYTHON에 실행 파일 경로를 지정할 수 있습니다. 고정된 등록 연산만 실행하며 임의 코드·명령·SQL을 받지 않습니다. 코드 및 SQLite 예제는 격리된 로컬 작업물에서 실제 검사·수정·백업·복구를 수행합니다. 회사 저장소/DB를 변경하려면 도구 및 자료에 등록한 MCP와 승인 노드를 사용하세요.\n\n웹에서 이 연산이나 OpenAI를 실행하지 않습니다. 내보낸 실행기의 check는 파일과 등록 연산을 점검하며 외부 서비스 연결은 하지 않습니다. 실행·재개 시 프로그램 코드·계약 파일의 지문을 대조합니다.\n"),
    } : {}),
    ...(pythonAssets ? {
      "flowly_tools.py": strToU8(options.helpers!.pythonTools!), "toolpacks_scientific.py": strToU8(options.helpers!.scientificTools!), "toolpacks_media.py": strToU8(options.helpers!.mediaTools!),
      "requirements-tools.txt": strToU8(requirementFile), "tool-manifest.json": strToU8(JSON.stringify(toolManifest, null, 2)), "tool-contracts.json": strToU8(JSON.stringify(toolContracts, null, 2)),
      "tool-catalog.json": strToU8(JSON.stringify({ version: 1, families: TOOL_FAMILIES, tools: pythonTools }, null, 2)),
      "PYTHON_TOOLS.md": strToU8("# 등록된 Python 도구\n\n선택한 도구와 정확한 입력 계약은 tool-manifest.json을 확인하세요. Python 3.11 이상이 필요합니다. check는 의존성만 검사하고 모델 다운로드·외부 요청·자동 설치를 하지 않습니다.\n\nrequirements-tools.txt에는 현재 흐름이 선택한 도구의 의존성만 포함합니다. 사내 패키지 저장소에서 설치하세요. 호환 범위 지정이며 잠금 파일은 아닙니다. 모델이 필요한 도구는 사용자가 models/ 아래에 준비한 모델과 .env의 FLOWLY_TOOL_MODELS JSON 매핑(도구 ID: 상대경로)이 필요하며, 미설정이면 실행을 중지합니다. Node.js는 .env의 FLOWLY_PYTHON에 가상 환경 Python 경로를 지정할 수 있습니다.\n\n프로그램 블록과 Agent의 pythonTools는 같은 등록 도구를 호출합니다. 임의 코드·셸·파일 경로를 실행하지 않습니다. 실행을 시작한 도구 코드·계약·목록 파일과 로컬 도구 설정의 해시가 고정되어 변경 후 재개는 거절됩니다. 대용량 모델 가중치와 설치된 라이브러리 버전까지 자동 고정하지는 않습니다. 로그에는 실제 도구 호출과 결과가 남고, 모델의 비공개 사고 원문을 저장하지 않습니다.\n")
    } : {}),
    ...(options.operations ? { "flowly_ops.py": strToU8(options.operations.ops), "flowly_local.py": strToU8(options.operations.local), ...(options.operations.guide ? { "OPERATIONS.md": strToU8(options.operations.guide) } : {}) } : {}),
    "README.md": strToU8(readme(manifest, Boolean(options.operations), target) + (completionIds.length ? "\n\n## 업무 프로그램\n\nCOMPLETION_PROGRAMS.md와 completion-manifest.json에서 선택한 계산·검증 기능을 확인하세요. Node.js도 Python 3.11 이상이 필요하며 .env의 FLOWLY_PYTHON으로 실행 경로를 지정합니다.\n" : "") + (pythonToolIds.length ? "\n\n## Python 도구\n\n이 흐름에는 등록된 Python 도구가 포함됩니다. PYTHON_TOOLS.md와 tool-manifest.json에서 입력·의존성·모델 설정을 확인하세요. Node.js 내보내기도 해당 도구를 실행할 때 Python이 필요합니다. check는 실제 서비스 연결을 하지 않습니다.\n" : "")),
    ".gitignore": strToU8(".env\n.env.*\n!.env.example\n.flowly-runs/\n.flowly-python-runs/\n.flowly-triggers/\n.flowly-ops/\n.flowly-profiles/\n.venv-files/\n.venv-tools/\nmodels/\ninputs/\noutputs/\nreports/\ntessdata/\n__pycache__/\n"),
  };
  if (options.kind === "agent") Object.assign(entries, Object.fromEntries(Object.entries(await buildAgentExportFiles(manifest, entries)).map(([path, text]) => [path, strToU8(text)])));
  return zipSync(entries, { level: 1 });
}
