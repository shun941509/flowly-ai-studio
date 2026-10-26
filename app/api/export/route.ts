/** 워크플로 내보내기의 HTTP 경계. 현재 워크플로/자료 권한을 검사하고 동일 manifest로 복사 지시문 또는 실행 ZIP을 만든다. */
import { referencedResourceIds } from "../../../domain/workflow";
import type { Workflow } from "../../lib/model";
import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../chatgpt-auth";
import { getAuthConfig } from "../../../server/auth/environment";
import { buildExportManifest, ExportPackageError, readExportRequest } from "../../../server/export-package";
import { buildCopyPrompt, buildStartPrompt } from "../../../server/export-ai-documents";
import { buildExecutableExportPackage } from "../../../server/export-assets";
import { requireResources } from "../../../server/repositories/resources";
import { HistoryError, WorkflowHistoryRepository } from "../../../server/repositories/workflow-history";
import { resourceFilesForEnvironment } from "../../../server/resource-file-environment";

export const dynamic = "force-dynamic";
const respond = (error: string, status: number) => Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });

/** 세션과 요청을 검증한 뒤 저장 버전 또는 초안을 선택한다. 언어별 실행 자산은 서버가 공급하고 비밀값은 포함하지 않는다. */
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return respond("로그인 후 이용해 주세요.", 401);
  try {
    const input = await readExportRequest(request, getAuthConfig());
    const { language, kind } = input;
    if (!env.DB) return respond("자료 저장소가 미설정이에요. 관리자에게 확인해 주세요.", 503);
    const history = new WorkflowHistoryRepository(env.DB);
    const published = input.workflowId && input.versionId ? await history.getVersion(user, input.workflowId, input.versionId) : undefined;
    const workflow = published ? { id: published.workflowId, name: published.name, description: published.description, definition: published.definition, updatedAt: published.createdAt } : input.workflow;
    await history.checkExport(user, String((workflow as {id?:unknown})?.id || "draft"));
    const options: Parameters<typeof buildExecutableExportPackage>[0] = {
      user, workflow, connections: [], language, kind, intent: input.intent, sourceVersion: published ? {id:published.id,number:published.number} : undefined,
      resolveResourceFiles: async (identity, resources) => resourceFilesForEnvironment().resolve(identity, resources),
      resolveResources: async (identity, ids) => {
        try { return await requireResources(identity, ids); }
        catch (error) {
          if (error instanceof Error && /접근 권한|공유가 철회/.test(error.message)) throw new ExportPackageError("접근 권한이 없거나 공유가 철회된 자료예요. 자료 소유자에게 확인해 주세요.", 403);
          throw new ExportPackageError("자료 저장소에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.", 503);
        }
      },
    };
    /** 복사용 지시문도 ZIP과 동일한 설계/자료 검증을 거친다. */
    const promptManifest = kind === "prompt" ? await buildExportManifest(options) : undefined;
    const result = promptManifest ? buildCopyPrompt(promptManifest) : await buildExecutableExportPackage(options);
    await history.checkExport(user, String((workflow as {id?:unknown})?.id || "draft"));
    /** 생성 후 워크플로와 자료 권한을 다시 확인한다. 생성 중 공유가 철회되었다면 산출물을 반환하지 않는다. */
    await options.resolveResources(user, referencedResourceIds((workflow as Workflow).definition));
    await history.recordAudit(user, "workflow.export", "workflow", published?.workflowId || String((workflow as {id?:string})?.id || "workflow").slice(0,100), { ...(published ? { version: published.number } : {}), fields: ["kind", "language", "definition", "resources", "connections"] });
    if (typeof result === "string") return Response.json({ kind: "prompt", text: result, kickoff: promptManifest ? buildStartPrompt(promptManifest) : undefined, language }, { headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
    const bytes = result;
    const name = String((workflow as {name?:unknown})?.name || "workflow").replace(/[\\/:*?"<>|\x00-\x1f]/g,"-").slice(0,60);
    const filename = `${name}-${published ? `v${published.number}` : "draft"}-${new Date().toISOString().slice(0,10)}-${kind}-${language}.zip`;
    return new Response(bytes.slice().buffer as ArrayBuffer, { headers: {
      "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="flowly-${kind}-${language}.zip"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    } });
  } catch (error) {
    if (error instanceof HistoryError) return respond(error.message, error.status);
    if (error instanceof ExportPackageError) return respond(error.message, error.status);
    if (error instanceof SyntaxError) return respond("요청 형식을 확인해 주세요.", 400);
    return respond("실행 프로젝트를 만들지 못했어요. 연결 설정을 확인하거나 잠시 후 다시 시도해 주세요.", 503);
  }
}
